// INTEGRATION (real PostgreSQL + real server processes): restart recovery from the database.
// Servers run with PERSISTENCE=postgres; they are killed (SIGKILL = crash) or stopped (SIGTERM)
// and restarted against the same database. Clients reconnect over sockets with their tokens.
import assert from 'node:assert';
import fs from 'node:fs';
import { makeRunner, startServer, connect, emit, createRoom, strongToken, sleep, tempStorageFile, registerAsyncCleanup, assertRejected } from './helpers/harness.js';
import { requireTestDatabase, startPgServer } from './helpers/pg.js';

const t = makeRunner('PostgreSQL Restart Recovery Suite — INTEGRATION (real PostgreSQL, real server processes)');
const db = await requireTestDatabase('recovery');
if (!db) process.exit(await t.finish());

const { createPool } = await import('../server/persistence/db.js');
const { runMigrations } = await import('../server/persistence/migrate.js');
const admin = createPool(db.url, { max: 2 });
registerAsyncCleanup(() => admin.end());
await runMigrations(admin);

const PG_ENV = { PERSISTENCE: 'postgres', DATABASE_URL: db.url };
const start = (env = {}) => startPgServer({ ...PG_ENV, ...env });
const health = async url => (await fetch(`${url}/api/health`)).json();
const roomState = async (url, code) => (await fetch(`${url}/api/rooms/${code}`)).json();
async function waitSaved(url) {
  for (let i = 0; i < 100; i++) {
    const h = await health(url);
    if (h.storage.pendingWrites === 0 && h.storage.lastWriteAt) return h;
    await sleep(50);
  }
  throw new Error('writes did not settle');
}
function kill9(srv) {
  return new Promise(resolve => {
    srv.child.once('exit', () => resolve());
    srv.child.kill('SIGKILL');
  });
}
async function join(url, code, name, token) {
  const s = await connect(url);
  const res = await emit(s, 'join_room', { roomCode: code, participantName: name, participantToken: token });
  return { s, res };
}
// Lobby → two franchises → auction started, through the real socket API
async function liveAuction(url, { hostToken = strongToken('h'), aliceToken = strongToken('a') } = {}) {
  const created = await createRoom(url, { hostName: 'Host', hostToken, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const code = created.body.roomCode;
  const host = await join(url, code, 'Host', hostToken);
  const alice = await join(url, code, 'Alice', aliceToken);
  assert.ok(host.res.success && alice.res.success);
  assert.ok((await emit(host.s, 'select_franchise', { roomCode: code, franchiseId: 'CSK' })).success);
  assert.ok((await emit(alice.s, 'select_franchise', { roomCode: code, franchiseId: 'MI' })).success);
  assert.ok((await emit(host.s, 'start_auction', { roomCode: code })).success);
  return { code, hostToken, aliceToken, host: host.s, alice: alice.s };
}
async function placeBid(url, socket, code, fid) {
  const st = await roomState(url, code);
  return emit(socket, 'place_bid', { roomCode: code, franchiseId: fid, bidAmount: st.currentLot.nextValidBid, expectedVersion: st.currentLot.stateVersion });
}

await t.it('D1: server in PostgreSQL mode — health reports durable postgres storage without credentials; no JSON file is created', async () => {
  const srv = await start();
  const h = await health(srv.url);
  assert.strictEqual(h.status, 'ok');
  assert.strictEqual(h.storage.kind, 'postgres');
  assert.strictEqual(h.storage.durable, true);
  assert.strictEqual(h.storage.connected, true);
  const dump = JSON.stringify(h);
  const u = new URL(db.url);
  assert.ok(!dump.includes('postgres://') && (!u.password || !dump.includes(u.password)), 'health exposes the connection string');
  assert.match(srv.getLog(), /PostgreSQL .* is the durable storage authority/);
  await createRoom(srv.url, { hostToken: strongToken('d1') });
  await waitSaved(srv.url);
  assert.ok(!fs.existsSync(srv.storageFile), 'JSON save file created in PostgreSQL mode');
  await srv.stop();
});

await t.it('D2: crash (SIGKILL) mid-lot → restart → paused, countdown reset, bid kept → same tokens rejoin → resume → sell → buyer fields the player', async () => {
  let srv = await start();
  const a = await liveAuction(srv.url);
  assert.ok((await placeBid(srv.url, a.alice, a.code, 'MI')).success);
  const before = await roomState(srv.url, a.code);
  await waitSaved(srv.url);
  await kill9(srv);

  srv = await start();
  const after = await roomState(srv.url, a.code);
  assert.strictEqual(after.status, 'paused');
  assert.strictEqual(after.currentLot.countdown, after.config.timerDuration);
  assert.strictEqual(after.currentLot.hammerStatus, 'OPEN');
  assert.strictEqual(after.currentLot.highestBid, before.currentLot.highestBid);
  assert.strictEqual(after.currentLot.highestBidderFranchiseId, 'MI');
  assert.strictEqual(after.currentLot.player.id, before.currentLot.player.id);
  assert.strictEqual(after.auditLog[0].type, 'SERVER_RESTART_PAUSED');

  const host = await join(srv.url, a.code, 'Host', a.hostToken);
  const alice = await join(srv.url, a.code, 'Alice', a.aliceToken);
  assert.ok(host.res.success, `host could not reconnect: ${host.res.error}`);
  assert.ok(alice.res.success, `participant could not reconnect: ${alice.res.error}`);
  assert.strictEqual(alice.res.participant.franchiseId, 'MI');
  assert.ok((await emit(host.s, 'resume_auction', { roomCode: a.code })).success);
  assert.ok((await placeBid(srv.url, host.s, a.code, 'CSK')).success);
  assert.ok((await placeBid(srv.url, alice.s, a.code, 'MI')).success);
  const pid = after.currentLot.player.id;
  assert.ok((await emit(host.s, 'advance_lot', { roomCode: a.code })).success);
  const sold = await roomState(srv.url, a.code);
  assert.strictEqual(sold.currentLot.hammerStatus, 'SOLD');
  assert.strictEqual(sold.playersCatalog.find(p => p.id === pid).soldTo, 'MI');
  const xi = await emit(alice.s, 'update_playing_xi', { roomCode: a.code, franchiseId: 'MI', playingXI: [pid] });
  assert.ok(xi.success, `buyer cannot field the player after recovery: ${xi.error}`);
  await waitSaved(srv.url);
  await srv.stop();
});

await t.it('D3: graceful stop (SIGTERM) right after a bid — the bid survives and the lease is released at once', async () => {
  let srv = await start();
  const a = await liveAuction(srv.url);
  assert.ok((await placeBid(srv.url, a.alice, a.code, 'MI')).success);
  const high = (await roomState(srv.url, a.code)).currentLot.highestBid;
  await srv.stop();
  assert.match(srv.getLog(), /IPL Auction Backend/);
  const lease = await admin.query(`SELECT 1 FROM storage_meta WHERE key = 'writer_lease'`);
  assert.strictEqual(lease.rowCount, 0, 'graceful stop did not release the writer lease');
  srv = await start();
  const st = await roomState(srv.url, a.code);
  assert.strictEqual(st.currentLot.highestBid, high, 'bid lost on graceful shutdown');
  assert.strictEqual(st.recentBids.length, 1);
  await srv.stop();
});

await t.it('D4: a legacy-format token reconnects after restart; a stranger, a guessed hash key, or an old socket cannot act', async () => {
  let srv = await start();
  const legacyHost = 'usr_1731740000000_h0st01';
  const a = await liveAuction(srv.url, { hostToken: legacyHost });
  const oldHostSocket = a.host;
  await waitSaved(srv.url);
  await srv.stop();
  srv = await start();
  const host = await join(srv.url, a.code, 'Host', legacyHost);
  assert.ok(host.res.success && host.res.participant.isHost, `legacy host could not reconnect: ${host.res.error}`);
  assert.ok((await emit(host.s, 'resume_auction', { roomCode: a.code })).success);
  // stranger with a fresh token cannot join an active room
  const stranger = await join(srv.url, a.code, 'Mallory', strongToken('m'));
  assertRejected(stranger.res, 'stranger join');
  // presenting the stored hash form instead of the token is rejected by validation
  const { hashKeyOf } = await import('../server/persistence/tokenHash.js');
  const forged = await join(srv.url, a.code, 'Mallory', hashKeyOf(a.aliceToken));
  assertRejected(forged.res, 'hash-key join');
  const forgedHex = await join(srv.url, a.code, 'Mallory', hashKeyOf(a.aliceToken).slice(5));
  assertRejected(forgedHex.res, 'raw-hash join');
  assert.ok(!oldHostSocket.connected, 'socket from the previous process still connected');
  await srv.stop();
});

await t.it('D5: a room the host paused keeps its exact countdown across a restart', async () => {
  let srv = await start();
  const a = await liveAuction(srv.url);
  await sleep(2300);
  assert.ok((await emit(a.host, 'pause_auction', { roomCode: a.code })).success);
  const paused = await roomState(srv.url, a.code);
  assert.ok(paused.currentLot.countdown < paused.config.timerDuration, 'clock did not run');
  await waitSaved(srv.url);
  await kill9(srv);
  srv = await start();
  const st = await roomState(srv.url, a.code);
  assert.strictEqual(st.status, 'paused');
  assert.strictEqual(st.currentLot.countdown, paused.currentLot.countdown);
  await srv.stop();
});

await t.it('D6: completed and lobby rooms are restored unchanged', async () => {
  let srv = await start();
  const a = await liveAuction(srv.url);
  assert.ok((await emit(a.host, 'finish_auction', { roomCode: a.code })).success);
  const lobby = await createRoom(srv.url, { hostName: 'Lobby', hostToken: strongToken('lb') });
  const done = await roomState(srv.url, a.code);
  assert.strictEqual(done.status, 'completed');
  await waitSaved(srv.url);
  await kill9(srv);
  srv = await start();
  const st = await roomState(srv.url, a.code);
  assert.strictEqual(st.status, 'completed');
  assert.deepStrictEqual(st.evaluationResults, done.evaluationResults);
  assert.strictEqual((await roomState(srv.url, lobby.body.roomCode)).status, 'lobby');
  await srv.stop();
});

await t.it('D7: a pending migration blocks startup (clear error, no fallback); DB_AUTO_MIGRATE=true migrates and starts', async () => {
  const fresh = await requireTestDatabase('recoveryfresh');
  const storageFile = tempStorageFile('d7');
  await assert.rejects(
    startServer({ storageFile, env: { PERSISTENCE: 'postgres', DATABASE_URL: fresh.url }, timeoutMs: 8000 }),
    err => /Pending migration/.test(err.message) && /exited early \(code 1/.test(err.message)
  );
  assert.ok(!fs.existsSync(storageFile), 'fell back to JSON storage');
  const srv = await startPgServer({ PERSISTENCE: 'postgres', DATABASE_URL: fresh.url, DB_AUTO_MIGRATE: 'true' }, { storageFile });
  assert.strictEqual((await health(srv.url)).storage.kind, 'postgres');
  await srv.stop();
});

process.exit(await t.finish());
