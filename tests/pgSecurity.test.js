// INTEGRATION (real PostgreSQL) + configuration: no secrets at rest, payload privacy after a
// PostgreSQL restore, single storage authority, fail-closed startup, test-database guard.
import assert from 'node:assert';
import fs from 'node:fs';
import { makeRunner, startServer, connect, emit, createRoom, strongToken, sleep, tempStorageFile, trackManager, mockIo, registerAsyncCleanup, findPrivateData, freePort, waitFor } from './helpers/harness.js';
import { requireTestDatabase, assertSafeTestUrl, startPgServer } from './helpers/pg.js';
import { richRoom } from './helpers/auctionRooms.js';

const t = makeRunner('PostgreSQL Security & Configuration Suite — INTEGRATION (real PostgreSQL)');
const db = await requireTestDatabase('security');
if (!db) process.exit(await t.finish());

const { createPool } = await import('../server/persistence/db.js');
const { runMigrations } = await import('../server/persistence/migrate.js');
const { PostgresStore } = await import('../server/persistence/postgresStore.js');
const { resolveStorageMode, StorageConfigError } = await import('../server/persistence/index.js');
const { hashToken, hashKeyOf } = await import('../server/persistence/tokenHash.js');
const { RoomManager } = await import('../server/roomManager.js');

const admin = createPool(db.url, { max: 2 });
registerAsyncCleanup(() => admin.end());
await runMigrations(admin);
const PG_ENV = { PERSISTENCE: 'postgres', DATABASE_URL: db.url };
const SECRET_A = 'test-only-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SECRET_B = 'test-only-secret-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

async function dumpDatabase(pool) {
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map(r => r.tablename);
  let out = '';
  for (const tbl of tables) {
    const r = await pool.query(`SELECT row_to_json(x)::text AS j FROM ${tbl} x`);
    out += r.rows.map(row => row.j).join('\n');
  }
  return out;
}

await t.it('X1: the database contains no raw session token and no socket id — only token hashes', async () => {
  const store = new PostgresStore({ connectionString: db.url, poolMax: 2 });
  await store.init({ log: () => {} });
  const rm = trackManager(new RoomManager(mockIo(), { store }));
  await rm.init();
  const { H, A } = richRoom(rm);
  await rm.flushStorage();
  const dump = await dumpDatabase(admin);
  for (const secret of [H, A]) assert.ok(!dump.includes(secret), 'raw token stored');
  for (const sock of ['sock-host-1', 'sock-alice-1']) assert.ok(!dump.includes(sock), 'socket id stored');
  assert.ok(dump.includes(hashToken(H)) && dump.includes(hashToken(A)), 'token hashes missing');
  await rm.shutdown(); await store.close();
});

await t.it('X2: after a PostgreSQL restore, no payload leaks tokens, token hashes or hash keys (before and after reconnect)', async () => {
  let srv = await startPgServer(PG_ENV);
  const H = strongToken('h'); const A = strongToken('a');
  const c = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = c.body.roomCode;
  const h = await connect(srv.url); const a = await connect(srv.url);
  await emit(h, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(a, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(h, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(a, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  await emit(h, 'start_auction', { roomCode: code });
  await srv.stop();
  srv = await startPgServer(PG_ENV);
  const secrets = [H, A, hashToken(H), hashToken(A), hashKeyOf(H), hashKeyOf(A), 'hash:'];
  const forbiddenKeys = ['ownerToken', 'ownerSocketId', 'token', 'hostToken', 'socketId'];
  const check = (label, payload) => {
    const hits = findPrivateData(payload, { secrets, forbiddenKeys });
    assert.deepStrictEqual(hits, [], `${label} leaks: ${hits.slice(0, 3).join(', ')}`);
  };
  check('GET /api/rooms (nobody reconnected yet)', await (await fetch(`${srv.url}/api/rooms/${code}`)).json());
  check('GET /api/health', await (await fetch(`${srv.url}/api/health`)).json());
  const observer = await connect(srv.url);
  const h2 = await connect(srv.url);
  const seen = waitFor(observer, 'state_updated', () => true, 5000);
  const joinObs = await emit(observer, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  check('join ack', joinObs);
  check('broadcast', await seen);
  const joinHost = await emit(h2, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  check('host join ack', joinHost);
  check('GET /api/rooms (after reconnect)', await (await fetch(`${srv.url}/api/rooms/${code}`)).json());
  await srv.stop();
});

await t.it('X3: storage mode resolution — JSON default, PostgreSQL only when explicitly selected, invalid settings refused', () => {
  assert.deepStrictEqual(resolveStorageMode({}), { mode: 'json', warnings: [] });
  const j = resolveStorageMode({ PERSISTENCE: 'json', DATABASE_URL: 'postgres://x@localhost/y' });
  assert.strictEqual(j.mode, 'json');
  assert.match(j.warnings[0], /NOT being used/);
  assert.strictEqual(resolveStorageMode({ DATABASE_URL: 'postgres://x@localhost/y' }).mode, 'json', 'DATABASE_URL alone must not switch authority');
  assert.strictEqual(resolveStorageMode({ PERSISTENCE: ' Postgres ', DATABASE_URL: 'postgres://x@localhost/y' }).mode, 'postgres');
  assert.throws(() => resolveStorageMode({ PERSISTENCE: 'postgres' }), StorageConfigError);
  assert.throws(() => resolveStorageMode({ PERSISTENCE: 'mysql' }), StorageConfigError);
});

await t.it('X4: the server refuses to start (exit 1, no JSON fallback) when PostgreSQL is selected but unusable', async () => {
  const deadPort = await freePort();
  const cases = [
    [{ PERSISTENCE: 'postgres' }, /requires DATABASE_URL/],
    [{ PERSISTENCE: 'sqlite' }, /PERSISTENCE must be/],
    [{ PERSISTENCE: 'postgres', DATABASE_URL: `postgres://nobody@127.0.0.1:${deadPort}/none`, DB_CONNECT_ATTEMPTS: '2' }, /FATAL/],
    [{ PERSISTENCE: 'postgres', DATABASE_URL: db.url, PG_POOL_MAX: '0' }, /PG_POOL_MAX/]
  ];
  for (const [env, why] of cases) {
    const storageFile = tempStorageFile('x4');
    await assert.rejects(startServer({ storageFile, env, timeoutMs: 15000 }),
      err => /exited early \(code 1/.test(err.message) && why.test(err.message), `not refused: ${JSON.stringify(env)}`);
    assert.ok(!fs.existsSync(storageFile), 'fell back to JSON storage');
  }
});

await t.it('X5: PERSISTENCE=json with DATABASE_URL set uses ONLY the JSON file and leaves the database untouched', async () => {
  const before = (await admin.query('SELECT count(*)::int AS n FROM rooms')).rows[0].n;
  const srv = await startServer({ env: { PERSISTENCE: 'json', DATABASE_URL: db.url }, timeoutMs: 15000 });
  const h = await (await fetch(`${srv.url}/api/health`)).json();
  assert.strictEqual(h.storage.kind, 'json-file');
  assert.match(srv.getLog(), /DATABASE_URL is set but PERSISTENCE is not "postgres"/);
  const c = await createRoom(srv.url, { hostToken: strongToken('x5') });
  await sleep(300);
  await srv.stop();
  assert.strictEqual((await admin.query('SELECT count(*)::int AS n FROM rooms')).rows[0].n, before, 'JSON-mode server wrote to PostgreSQL');
  assert.ok(JSON.parse(fs.readFileSync(srv.storageFile, 'utf-8'))[c.body.roomCode], 'room not in the JSON file');
});

await t.it('X6: changing the token hashing scheme on an existing database is refused at startup (nobody gets locked out)', async () => {
  const srv = await startServer({ env: { ...PG_ENV, TOKEN_HASH_SECRET: SECRET_A }, timeoutMs: 15000 }).catch(e => e);
  assert.ok(srv instanceof Error, 'server started with a different hashing scheme');
  assert.match(srv.message, /Token hash scheme mismatch/);
  const scheme = (await admin.query(`SELECT value FROM storage_meta WHERE key = 'token_hash_scheme'`)).rows[0].value;
  assert.strictEqual(scheme, 'sha256-v1', 'stored scheme was changed');
});

await t.it('X7: with TOKEN_HASH_SECRET from the start, only keyed (HMAC) hashes are stored and reconnecting works', async () => {
  const d2 = await requireTestDatabase('securityhmac');
  const env = { PERSISTENCE: 'postgres', DATABASE_URL: d2.url, DB_AUTO_MIGRATE: 'true', TOKEN_HASH_SECRET: SECRET_A };
  let srv = await startPgServer(env);
  const H = strongToken('hm');
  const c = await createRoom(srv.url, { hostName: 'Host', hostToken: H });
  const s1 = await connect(srv.url);
  await emit(s1, 'join_room', { roomCode: c.body.roomCode, participantName: 'Host', participantToken: H });
  await srv.stop();
  const p2 = createPool(d2.url, { max: 1 });
  try {
    const row = (await p2.query('SELECT host_token_hash FROM rooms')).rows[0];
    assert.strictEqual(row.host_token_hash, hashToken(H, { TOKEN_HASH_SECRET: SECRET_A }));
    assert.notStrictEqual(row.host_token_hash, hashToken(H, {}));
  } finally { await p2.end(); }
  srv = await startPgServer(env);
  const s2 = await connect(srv.url);
  const j = await emit(s2, 'join_room', { roomCode: c.body.roomCode, participantName: 'Host', participantToken: H });
  assert.ok(j.success && j.participant.isHost);
  await srv.stop();
});

await t.it('X9: TOKEN_HASH_SECRET — weak values refused, a changed value detected, the secret never appears in logs, health or API responses', async () => {
  // weak secret: refused before anything else, without echoing it
  const weak = 'short-secret-123';
  const w = await startServer({ storageFile: tempStorageFile('x9'), env: { ...PG_ENV, TOKEN_HASH_SECRET: weak }, timeoutMs: 15000 }).catch(e => e);
  assert.ok(w instanceof Error && /at least 32 characters/.test(w.message), 'weak secret accepted');
  assert.ok(!w.message.includes(weak), 'weak secret echoed in the log');
  // a database initialised with SECRET_A
  const d3 = await requireTestDatabase('securitysecret');
  const env = { PERSISTENCE: 'postgres', DATABASE_URL: d3.url, DB_AUTO_MIGRATE: 'true', TOKEN_HASH_SECRET: SECRET_A };
  const srv = await startPgServer(env);
  const H = strongToken('sx');
  const c = await createRoom(srv.url, { hostName: 'Host', hostToken: H });
  const sock = await connect(srv.url);
  const j = await emit(sock, 'join_room', { roomCode: c.body.roomCode, participantName: 'Host', participantToken: H });
  const payloads = JSON.stringify([c.body, j, await (await fetch(`${srv.url}/api/health`)).json(), await (await fetch(`${srv.url}/api/rooms/${c.body.roomCode}`)).json()]);
  await srv.stop();
  for (const [label, text] of [['payloads', payloads], ['log', srv.getLog()]]) {
    assert.ok(!text.includes(SECRET_A), `secret leaked in ${label}`);
    assert.ok(!text.includes(H), `raw token leaked in ${label}`);
  }
  const p3 = createPool(d3.url, { max: 1 });
  try {
    const dump = await dumpDatabase(p3);
    assert.ok(!dump.includes(SECRET_A), 'secret stored in the database');
  } finally { await p3.end(); }
  // same scheme, different VALUE → refused (previously undetected), no secret in the message
  const changed = await startServer({ storageFile: tempStorageFile('x9b'), env: { ...env, TOKEN_HASH_SECRET: SECRET_B }, timeoutMs: 15000 }).catch(e => e);
  assert.ok(changed instanceof Error && /Token hash secret mismatch/.test(changed.message), 'changed secret value not detected');
  assert.ok(!changed.message.includes(SECRET_A) && !changed.message.includes(SECRET_B), 'secret echoed in the mismatch message');
  // removing the secret is a scheme change → refused
  const removed = await startServer({ storageFile: tempStorageFile('x9c'), env: { ...env, TOKEN_HASH_SECRET: '' }, timeoutMs: 15000 }).catch(e => e);
  assert.ok(removed instanceof Error && /scheme mismatch/.test(removed.message));
  // the original secret still works
  const back = await startPgServer(env);
  const s2 = await connect(back.url);
  assert.ok((await emit(s2, 'join_room', { roomCode: c.body.roomCode, participantName: 'Host', participantToken: H })).success);
  await back.stop();
});

await t.it('X8: the test-database guard refuses hosted/production hosts, remote hosts and DATABASE_URL itself', () => {
  assert.throws(() => assertSafeTestUrl('postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/neondb', {}), /hosted\/production/);
  assert.throws(() => assertSafeTestUrl('postgres://u:p@db.example.com/x', {}), /non-local/);
  assert.doesNotThrow(() => assertSafeTestUrl('postgres://u:p@db.example.com/x', { ALLOW_REMOTE_TEST_DB: '1' }));
  assert.throws(() => assertSafeTestUrl('postgres://u:p@ep-x.neon.tech/x', { ALLOW_REMOTE_TEST_DB: '1' }), /hosted/);
  assert.throws(() => assertSafeTestUrl('postgres://u@127.0.0.1/x', { DATABASE_URL: 'postgres://u@127.0.0.1/x' }), /must not equal/);
  assert.doesNotThrow(() => assertSafeTestUrl('postgres://u@127.0.0.1:5432/x', {}));
});

process.exit(await t.finish());
