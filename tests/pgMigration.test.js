// INTEGRATION (real PostgreSQL): JSON save file → PostgreSQL import tool.
// All source files are temporary copies built by the real JSON-mode RoomManager (or the
// committed legacy fixture). The user's real save file is never used here.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRunner, trackManager, mockIo, tempStorageFile, registerAsyncCleanup } from './helpers/harness.js';
import { requireTestDatabase } from './helpers/pg.js';
import { liveRoom, lobbyRoom, bid, sellCurrent, normalizeRoom } from './helpers/auctionRooms.js';

const t = makeRunner('JSON → PostgreSQL Import Suite — INTEGRATION (real PostgreSQL)');
const db = await requireTestDatabase('import');
if (!db) process.exit(await t.finish());

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(dir, '..');
const { createPool } = await import('../server/persistence/db.js');
const { runMigrations } = await import('../server/persistence/migrate.js');
const { importJsonFile, scanTopLevelEntries } = await import('../server/persistence/importJson.js');
const { PostgresStore } = await import('../server/persistence/postgresStore.js');
const { RoomManager, prepareRestoredRoom } = await import('../server/roomManager.js');

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const pools = [];
async function freshDb(label) {
  const d = await requireTestDatabase(label);
  const pool = createPool(d.url, { max: 3 });
  pools.push(pool);
  await runMigrations(pool);
  return { ...d, pool };
}
registerAsyncCleanup(async () => { for (const p of pools) await p.end(); });
const n = async (pool, sql, params) => (await pool.query(sql, params)).rows[0].n;
const TABLES = ['rooms', 'franchises', 'participants', 'room_players', 'squad_entries', 'lineups', 'lineup_players', 'bids', 'lot_results', 'audit_logs', 'quarantined_rooms', 'migration_runs'];
async function tableCounts(pool) {
  const out = {};
  for (const tbl of TABLES) out[tbl] = await n(pool, `SELECT count(*)::int AS n FROM ${tbl}`);
  return out;
}

// A save file with lobby / active (bids, sales, lineup) / paused / completed rooms
function buildSave() {
  const file = tempStorageFile('src');
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const lobby = lobbyRoom(rm);
  const active = liveRoom(rm);
  const ar = rm.getRoom(active.code);
  for (let i = 0; i < 3; i++) sellCurrent(rm, ar, active.A, 'MI');
  const xi = ar.franchises.MI.squad.map(p => p.id).slice(0, 2);
  assert.ok(rm.updatePlayingXI({ roomCode: active.code, participantToken: active.A, franchiseId: 'MI', playingXI: xi, captainId: xi[0], viceCaptainId: xi[1], isConfirmed: false }).success);
  bid(rm, ar, active.H, 'CSK');
  const paused = liveRoom(rm);
  bid(rm, rm.getRoom(paused.code), paused.A, 'MI');
  rm.pauseAuction({ roomCode: paused.code, hostToken: paused.H });
  const done = liveRoom(rm);
  sellCurrent(rm, rm.getRoom(done.code), done.H, 'CSK');
  rm.finishAuction(rm.getRoom(done.code));
  rm.flushStorage();
  rm.shutdown();
  return { file, rooms: { lobby, active, paused, done } };
}
// Rooms as the JSON loader would prepare them (no restart rule), for comparison
function preparedFromFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const out = {};
  for (const [code, r] of Object.entries(data)) { prepareRestoredRoom(code, r); out[code] = r; }
  return out;
}
async function loadFromDb(url) {
  const s = new PostgresStore({ connectionString: url, poolMax: 2 });
  await s.init({ log: () => {} });
  const res = await s.loadAll();
  await s.close();
  return res;
}
function runCli(args, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'db', 'import-json.mjs'), ...args], {
    cwd: path.dirname(tempStorageFile('cli')), env: { ...process.env, ...env }, encoding: 'utf-8', timeout: 60000
  });
}

await t.it('I1: a mixed save file imports completely and faithfully; the source file is byte-for-byte unchanged', async () => {
  const d = await freshDb('i1');
  const { file } = buildSave();
  const before = sha(file);
  const report = await importJsonFile({ pool: d.pool, file });
  assert.strictEqual(report.status, 'completed');
  assert.deepStrictEqual(report.counts, { total: 4, imported: 4, skipped: 0, quarantined: 0, failed: 0 });
  assert.strictEqual(sha(file), before, 'source file modified');
  assert.ok(report.source.unchanged && report.source.sha256Before === before);
  const expected = preparedFromFile(file);
  const { rooms, failures } = await loadFromDb(d.url);
  assert.deepStrictEqual(failures, []);
  assert.strictEqual(rooms.length, 4);
  for (const { code, room } of rooms) assert.deepStrictEqual(normalizeRoom(room), normalizeRoom(expected[code]), `room ${code} differs after import`);
  assert.ok(report.rooms.some(r => r.warnings.some(w => /ACTIVE/.test(w))), 'active-room restart note missing');
});

await t.it('I2: re-running the import is idempotent — every room skipped, no row changes', async () => {
  const d = await freshDb('i2');
  const { file } = buildSave();
  await importJsonFile({ pool: d.pool, file });
  const before = await tableCounts(d.pool);
  const again = await importJsonFile({ pool: d.pool, file });
  assert.deepStrictEqual(again.counts, { total: 4, imported: 0, skipped: 4, quarantined: 0, failed: 0 });
  assert.ok(again.rooms.every(r => r.reason === 'ALREADY_IMPORTED'));
  const after = await tableCounts(d.pool);
  assert.deepStrictEqual({ ...after, migration_runs: 0 }, { ...before, migration_runs: 0 });
});

await t.it('I3: a dry run reports what would happen and changes nothing', async () => {
  const d = await freshDb('i3');
  const { file } = buildSave();
  const report = await importJsonFile({ pool: d.pool, file, dryRun: true });
  assert.deepStrictEqual(report.counts, { total: 4, imported: 4, skipped: 0, quarantined: 0, failed: 0 });
  assert.ok(Object.values(await tableCounts(d.pool)).every(v => v === 0), 'dry run wrote rows');
});

await t.it('I4: a hard crash mid-import (SIGKILL via the CLI) leaves only whole rooms; re-running completes with no duplicates', async () => {
  const d = await freshDb('i4');
  const { file } = buildSave();
  const crashed = runCli(['--file', file, '--confirm'], { DATABASE_URL: d.url, IMPORT_JSON_TEST_CRASH_AFTER: '2' });
  assert.strictEqual(crashed.signal, 'SIGKILL', `CLI did not crash as instructed: ${crashed.stdout}${crashed.stderr}`);
  assert.strictEqual(await n(d.pool, 'SELECT count(*)::int AS n FROM rooms'), 2);
  assert.strictEqual(await n(d.pool, `SELECT count(*)::int AS n FROM migration_runs WHERE status = 'running'`), 1);
  // each imported room is complete: 10 franchises, full catalogue
  const per = await d.pool.query(`SELECT r.room_code, (SELECT count(*) FROM franchises f WHERE f.room_code = r.room_code)::int AS f,
    (SELECT count(*) FROM room_players p WHERE p.room_code = r.room_code)::int AS p FROM rooms r`);
  for (const row of per.rows) assert.ok(row.f === 10 && row.p === 290, `partial room ${row.room_code}: ${JSON.stringify(row)}`);

  const resumed = runCli(['--file', file, '--confirm'], { DATABASE_URL: d.url });
  assert.strictEqual(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /imported 2, skipped 2, quarantined 0, failed 0/);
  assert.strictEqual(await n(d.pool, 'SELECT count(*)::int AS n FROM rooms'), 4);
  const runs = (await d.pool.query('SELECT status FROM migration_runs ORDER BY run_id')).rows.map(r => r.status);
  assert.deepStrictEqual(runs, ['interrupted', 'completed']);
  // same database content as an uninterrupted import
  const clean = await freshDb('i4clean');
  await importJsonFile({ pool: clean.pool, file });
  const a = await tableCounts(d.pool); const b = await tableCounts(clean.pool);
  assert.deepStrictEqual({ ...a, migration_runs: 0 }, { ...b, migration_runs: 0 });
});

await t.it('I5: problem rooms are quarantined VERBATIM with a reason — nothing is silently dropped, good rooms still import', async () => {
  const d = await freshDb('i5');
  const { file } = buildSave();
  const good = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const codes = Object.keys(good);
  const doubleSale = structuredClone(good[codes[1]]);
  doubleSale.roomCode = 'DBLSAL';
  doubleSale.franchises.CSK.squad.push({ ...doubleSale.franchises.MI.squad[0] });
  const badBid = structuredClone(good[codes[1]]);
  badBid.roomCode = 'BADBID';
  badBid.allBids[0].bidAmount = 'lots';
  const extras = [
    ['DUPKEY', JSON.stringify({ roomCode: 'DUPKEY', status: 'lobby', note: 'first copy' })],
    ['DUPKEY', JSON.stringify({ roomCode: 'DUPKEY', status: 'lobby', note: 'second copy' })],
    ['NOSHAP', JSON.stringify({ status: 'lobby' })],
    ['lower1', JSON.stringify(good[codes[0]])],
    ['MISMAT', JSON.stringify({ ...good[codes[0]], roomCode: 'OTHER1' })],
    ['DBLSAL', JSON.stringify(doubleSale)],
    ['BADBID', JSON.stringify(badBid)]
  ];
  const text = fs.readFileSync(file, 'utf-8').replace(/}\s*$/, '') + extras.map(([k, v]) => `,${JSON.stringify(k)}:  ${v}`).join('') + '}';
  const src = tempStorageFile('i5');
  fs.writeFileSync(src, text);
  const report = await importJsonFile({ pool: d.pool, file: src });
  assert.deepStrictEqual(report.counts, { total: 11, imported: 4, skipped: 0, quarantined: 7, failed: 0 });
  const reasons = Object.fromEntries(report.rooms.filter(r => r.outcome === 'quarantined').map(r => [`${r.code}#${r.occurrence}`, r.reason.split(':')[0]]));
  assert.deepStrictEqual(reasons, {
    'DUPKEY#1': 'DUPLICATE_ROOM_KEY', 'DUPKEY#2': 'DUPLICATE_ROOM_KEY', 'NOSHAP#1': 'INVALID_ROOM_SHAPE',
    'lower1#1': 'INVALID_ROOM_CODE', 'MISMAT#1': 'ROOM_CODE_MISMATCH', 'DBLSAL#1': 'CANNOT_STORE_FAITHFULLY', 'BADBID#1': 'CANNOT_STORE_FAITHFULLY'
  });
  // the exact original text of every quarantined occurrence is stored
  const raw = new Map(scanTopLevelEntries(text).map((e, i) => [`${e.key}#${i}`, e.raw]));
  const stored = (await d.pool.query('SELECT room_code, occurrence, original_text FROM quarantined_rooms ORDER BY id')).rows;
  assert.strictEqual(stored.length, 7);
  for (const row of stored) assert.ok([...raw.entries()].some(([k, v]) => k.startsWith(`${row.room_code}#`) && v === row.original_text), `${row.room_code} not stored verbatim`);
  assert.ok(stored.some(r => r.original_text.includes('first copy')) && stored.some(r => r.original_text.includes('second copy')), 'a duplicate copy was lost');
  // every key in the file is accounted for
  const inDb = new Set([...(await d.pool.query('SELECT room_code FROM rooms')).rows, ...stored].map(r => r.room_code));
  for (const e of scanTopLevelEntries(text)) assert.ok(inDb.has(e.key), `${e.key} silently dropped`);
  assert.ok(report.notes.some(x => /DUPKEY appears 2 times/.test(x)));
  // quarantined codes are never reused for new rooms
  const s = new PostgresStore({ connectionString: d.url, poolMax: 2 });
  await s.init({ log: () => {} });
  const rm = trackManager(new RoomManager(mockIo(), { store: s }));
  await rm.init();
  assert.ok(rm.quarantinedRooms.has('DBLSAL') && rm.quarantinedRooms.has('DUPKEY'));
  assert.ok(rm.storageStatus.quarantinedRooms.includes('BADBID'));
  await rm.shutdown(); await s.close();
});

await t.it('I6: a different room already in the database is never overwritten — the incoming copy is quarantined as a conflict', async () => {
  const d = await freshDb('i6');
  const { file } = buildSave();
  await importJsonFile({ pool: d.pool, file });
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const code = Object.keys(data)[0];
  data[code].hostName = 'Changed Later';
  const changed = tempStorageFile('i6');
  fs.writeFileSync(changed, JSON.stringify(data));
  const before = (await d.pool.query('SELECT host_name, version, source_checksum FROM rooms WHERE room_code = $1', [code])).rows[0];
  const report = await importJsonFile({ pool: d.pool, file: changed });
  assert.deepStrictEqual(report.counts, { total: 4, imported: 0, skipped: 3, quarantined: 1, failed: 0 });
  assert.match(report.rooms.find(r => r.code === code).reason, /^CONFLICT_ROOM_EXISTS/);
  const after = (await d.pool.query('SELECT host_name, version, source_checksum FROM rooms WHERE room_code = $1', [code])).rows[0];
  assert.deepStrictEqual(after, before, 'existing room was modified');
});

await t.it('I7: restore fixes run during import — legacy lineup cleanup and sale-record repair — and legacy tokens reconnect', async () => {
  const d = await freshDb('i7');
  const file = tempStorageFile('i7src');
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const H = 'usr_1731740000000_h0st01';
  const A = 'usr_1731740000123_a1ice2';
  const room = rm.createRoom({ hostName: 'Host', hostToken: H, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = room.roomCode;
  rm.joinRoom({ roomCode: code, participantName: 'Host', participantToken: H, socketId: 'x1' });
  rm.joinRoom({ roomCode: code, participantName: 'Alice', participantToken: A, socketId: 'x2' });
  rm.selectFranchise({ roomCode: code, participantToken: H, franchiseId: 'CSK' });
  rm.selectFranchise({ roomCode: code, participantToken: A, franchiseId: 'MI' });
  rm.startAuction({ roomCode: code, hostToken: H });
  sellCurrent(rm, room, A, 'MI');
  sellCurrent(rm, room, H, 'CSK');
  rm.flushStorage(); rm.shutdown();
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const r = data[code];
  const miPlayer = r.franchises.MI.squad[0].id;
  const cskPlayer = r.franchises.CSK.squad[0].id;
  r.franchises.MI.playingXI = [miPlayer, cskPlayer, miPlayer, 'PL_999']; // foreign, duplicate, unknown
  r.franchises.MI.captainId = cskPlayer;
  // damage from the old restore bug: catalogue lost the CSK sale record
  Object.assign(r.playersCatalog.find(p => p.id === cskPlayer), { status: 'in_auction', soldTo: null, soldPrice: null });
  const src = tempStorageFile('i7');
  fs.writeFileSync(src, JSON.stringify(data));
  const report = await importJsonFile({ pool: d.pool, file: src });
  const entry = report.rooms[0];
  assert.strictEqual(entry.outcome, 'imported');
  assert.strictEqual(entry.reason, 'IMPORTED_WITH_RESTORE_FIXES');
  assert.ok(entry.legacyCleanup);
  assert.deepStrictEqual(entry.repairs.map(x => x.playerId), [cskPlayer]);

  const s = new PostgresStore({ connectionString: d.url, poolMax: 2 });
  await s.init({ log: () => {} });
  const rm2 = trackManager(new RoomManager(mockIo(), { store: s }));
  await rm2.init();
  const r2 = rm2.getRoom(code);
  assert.deepStrictEqual(r2.franchises.MI.playingXI, [miPlayer]);
  assert.strictEqual(r2.franchises.MI.captainId, null);
  assert.ok(r2.auditLog.some(e => e.type === 'LEGACY_LINEUP_CLEANUP'));
  assert.ok(r2.auditLog.some(e => e.type === 'RESTORE_SALE_RECORD_REPAIRED'));
  assert.ok(rm2.getOwnedPlayers(r2, 'CSK').has(cskPlayer));
  // legacy-format tokens reconnect (the database holds only their hashes)
  const j1 = rm2.joinRoom({ roomCode: code, participantName: 'Host', participantToken: H, socketId: 'n1' });
  const j2 = rm2.joinRoom({ roomCode: code, participantName: 'Alice', participantToken: A, socketId: 'n2' });
  assert.ok(j1.success && j1.participant.isHost && j2.success && j2.participant.franchiseId === 'MI');
  assert.ok(rm2.resumeAuction({ roomCode: code, hostToken: H }).success, 'legacy host cannot act as host');
  assert.ok(rm2.updatePlayingXI({ roomCode: code, participantToken: H, franchiseId: 'CSK', playingXI: [cskPlayer], isConfirmed: false }).success);
  await rm2.shutdown(); await s.close();
});

await t.it('I8: an unreadable source aborts before touching the database; the file is left unchanged', async () => {
  const d = await freshDb('i8');
  const { file } = buildSave();
  const truncated = tempStorageFile('i8');
  fs.writeFileSync(truncated, fs.readFileSync(file, 'utf-8').slice(0, 5000));
  const before = sha(truncated);
  const report = await importJsonFile({ pool: d.pool, file: truncated });
  assert.strictEqual(report.status, 'failed');
  assert.match(report.error, /^UNREADABLE_SOURCE/);
  assert.strictEqual(sha(truncated), before);
  assert.ok(Object.values(await tableCounts(d.pool)).every(v => v === 0));
  const cli = runCli(['--file', truncated, '--confirm'], { DATABASE_URL: d.url });
  assert.strictEqual(cli.status, 1);
});

await t.it('I9: CLI guards — --confirm required, live save file refused, report written, no credentials printed', async () => {
  const d = await freshDb('i9');
  const { file } = buildSave();
  const noConfirm = runCli(['--file', file], { DATABASE_URL: d.url });
  assert.strictEqual(noConfirm.status, 2);
  assert.match(noConfirm.stderr, /--confirm/);
  const live = path.join(ROOT, 'server', 'data', 'persisted_rooms.json');
  if (fs.existsSync(live)) {
    const liveBefore = sha(live);
    const refused = runCli(['--file', live, '--dry-run'], { DATABASE_URL: d.url });
    assert.strictEqual(refused.status, 2);
    assert.match(refused.stderr, /Refusing to read the live save file/);
    assert.strictEqual(sha(live), liveBefore);
  }
  const reportPath = path.join(path.dirname(file), 'report.json');
  const ok = runCli(['--file', file, '--confirm', '--report', reportPath], { DATABASE_URL: d.url });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  const rep = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  assert.deepStrictEqual(rep.counts, { total: 4, imported: 4, skipped: 0, quarantined: 0, failed: 0 });
  assert.ok(rep.source.unchanged);
  const pw = new URL(d.url).password;
  if (pw) assert.ok(!ok.stdout.includes(pw), 'password printed');
  assert.ok(!ok.stdout.includes('postgres://'), 'connection string printed');
  assert.match(ok.stdout, /Target database: [^\s]+\/ipl_test_i9_/);
});

await t.it('I10: the committed legacy fixture (written by the ORIGINAL code) imports; its legacy host reconnects', async () => {
  const fixture = path.join(dir, 'fixtures', 'pre-stage-0.5-room.json');
  assert.ok(fs.existsSync(fixture), 'fixture tests/fixtures/pre-stage-0.5-room.json is missing');
  const d = await freshDb('i10');
  const copy = tempStorageFile('i10');
  fs.copyFileSync(fixture, copy);
  const before = sha(fixture);
  const report = await importJsonFile({ pool: d.pool, file: copy });
  assert.strictEqual(report.counts.failed, 0);
  assert.strictEqual(report.counts.quarantined, 0, JSON.stringify(report.rooms));
  assert.ok(report.counts.imported >= 1);
  assert.strictEqual(sha(fixture), before);
  const s = new PostgresStore({ connectionString: d.url, poolMax: 2 });
  await s.init({ log: () => {} });
  const rm = trackManager(new RoomManager(mockIo(), { store: s }));
  await rm.init();
  const code = report.rooms[0].code;
  const j = rm.joinRoom({ roomCode: code, participantName: 'Host', participantToken: 'usr_1731740000000_h0st01', socketId: 'f1' });
  assert.ok(j.success && j.participant.isHost, `legacy host could not reconnect: ${j.error}`);
  assert.strictEqual(rm.getRoom(code).franchises.CSK.ownerToken, 'usr_1731740000000_h0st01');
  await rm.shutdown(); await s.close();
});

await t.it('I11: the importer hashes tokens exactly as the server will — a secret mismatch is refused, never a silent lockout', async () => {
  const d = await freshDb('i11');
  const SECRET = 'import-test-secret-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const { file } = buildSave();
  const prev = process.env.TOKEN_HASH_SECRET;
  try {
    process.env.TOKEN_HASH_SECRET = 'too-short';
    const weak = await importJsonFile({ pool: d.pool, file });
    assert.match(weak.error, /^TOKEN_HASH_SECRET_INVALID/);
    process.env.TOKEN_HASH_SECRET = SECRET;
    const ok = await importJsonFile({ pool: d.pool, file });
    assert.strictEqual(ok.counts.imported, 4);
    // a later import without the secret is refused, nothing written
    delete process.env.TOKEN_HASH_SECRET;
    const other = buildSave();
    const before = (await d.pool.query('SELECT count(*)::int AS n FROM rooms')).rows[0].n;
    const mismatch = await importJsonFile({ pool: d.pool, file: other.file });
    assert.match(mismatch.error, /^TOKEN_HASH_MISMATCH/);
    assert.strictEqual((await d.pool.query('SELECT count(*)::int AS n FROM rooms')).rows[0].n, before);
    // a server without the secret refuses to start against this database
    const s0 = new PostgresStore({ connectionString: d.url, poolMax: 1 });
    await assert.rejects(s0.init({ log: () => {} }), /scheme mismatch/);
    await s0.pool.end();
    // with the same secret, imported participants reconnect
    process.env.TOKEN_HASH_SECRET = SECRET;
    const s = new PostgresStore({ connectionString: d.url, poolMax: 2 });
    await s.init({ log: () => {} });
    const rm = trackManager(new RoomManager(mockIo(), { store: s }));
    await rm.init();
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const code = Object.keys(data)[1];
    const [token, p] = data[code].participants[1];
    const j = rm.joinRoom({ roomCode: code, participantName: p.name, participantToken: token, socketId: 'z1' });
    assert.ok(j.success && j.participant.franchiseId === p.franchiseId, `imported participant locked out: ${j.error}`);
    await rm.shutdown(); await s.close();
  } finally {
    if (prev === undefined) delete process.env.TOKEN_HASH_SECRET; else process.env.TOKEN_HASH_SECRET = prev;
  }
});

process.exit(await t.finish());
