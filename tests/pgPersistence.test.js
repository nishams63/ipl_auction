// INTEGRATION (real PostgreSQL): RoomManager + PostgresStore — durability of every mutation,
// faithful restore, diff writes, no duplicates, optimistic concurrency, rollback, retry.
import assert from 'node:assert';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeRunner, trackManager, mockIo, tempStorageFile, registerAsyncCleanup, strongToken } from './helpers/harness.js';
import { requireTestDatabase } from './helpers/pg.js';
import { lobbyRoom, liveRoom, richRoom, bid, sellCurrent, passCurrent, normalizeRoom } from './helpers/auctionRooms.js';

const t = makeRunner('PostgreSQL Persistence Suite — INTEGRATION (real PostgreSQL)');
const db = await requireTestDatabase('persist');
if (!db) process.exit(await t.finish());

const { createPool } = await import('../server/persistence/db.js');
const { runMigrations } = await import('../server/persistence/migrate.js');
const { PostgresStore } = await import('../server/persistence/postgresStore.js');
const { RoomManager } = await import('../server/roomManager.js');

const admin = createPool(db.url, { max: 3 });
registerAsyncCleanup(() => admin.end());
await runMigrations(admin);

const stores = [];
async function newStore(opts = {}) {
  const s = new PostgresStore({ connectionString: db.url, poolMax: 3, retry: { baseDelayMs: 20, maxDelayMs: 100 }, ...opts });
  await s.init({ log: () => {} });
  stores.push(s);
  return s;
}
registerAsyncCleanup(async () => { for (const s of stores) { try { if (!s.closed) { s.dirty.clear(); await s.close(); } } catch { /* ignore */ } } });

async function newManager(opts) {
  const store = await newStore(opts);
  const rm = trackManager(new RoomManager(mockIo(), { store }));
  await rm.init();
  return { rm, store };
}
// Read-only view of what the database holds (no RoomManager, so no restart rule applied)
async function dbRoom(code) {
  const s = await newStore();
  const { rooms } = await s.loadAll();
  await s.close();
  return rooms.find(r => r.code === code)?.room || null;
}
const count = async (table, code) => (await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE room_code = $1`, [code])).rows[0].n;

await t.it('P1: every important mutation is durable (verified by reading the database after each step)', async () => {
  const { rm } = await newManager();
  const H = strongToken('h'); const A = strongToken('a');
  const room = rm.createRoom({ hostName: 'Host', hostToken: H, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = room.roomCode;
  const saved = async () => { assert.strictEqual(await rm.flushStorage(), true, 'flush did not complete'); return dbRoom(code); };
  assert.ok(await saved(), 'room creation');
  rm.joinRoom({ roomCode: code, participantName: 'Host', participantToken: H, socketId: 's1' });
  rm.joinRoom({ roomCode: code, participantName: 'Alice', participantToken: A, socketId: 's2' });
  assert.strictEqual((await saved()).participants.size, 2, 'joins');
  rm.selectFranchise({ roomCode: code, participantToken: A, franchiseId: 'RR' });
  assert.strictEqual((await saved()).franchises.RR.isClaimed, true, 'franchise claim');
  rm.selectFranchise({ roomCode: code, participantToken: A, franchiseId: 'MI' });
  let s = await saved();
  assert.ok(!s.franchises.RR.isClaimed && s.franchises.MI.isClaimed, 'franchise release/re-claim');
  rm.selectFranchise({ roomCode: code, participantToken: H, franchiseId: 'CSK' });
  rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { autoAdvanceDelay: 7 } });
  assert.strictEqual((await saved()).config.autoAdvanceDelay, 7, 'config');
  rm.startAuction({ roomCode: code, hostToken: H });
  s = await saved();
  assert.ok(s.status === 'active' && s.currentLot && s.currentLot.player.id === room.currentLot.player.id, 'start + first lot');
  bid(rm, room, A, 'MI');
  s = await saved();
  assert.strictEqual(s.currentLot.highestBid, room.currentLot.highestBid, 'bid on lot');
  assert.strictEqual(s.allBids.length, 1, 'bid log');
  const soldId = room.currentLot.player.id;
  rm.closeCurrentLot(room);
  s = await saved();
  assert.ok(s.franchises.MI.squad.some(p => p.id === soldId), 'sale → squad');
  assert.strictEqual(s.playersCatalog.find(p => p.id === soldId).status, 'sold', 'sale → catalogue');
  assert.strictEqual(s.franchises.MI.remainingPurse, room.franchises.MI.remainingPurse, 'sale → purse');
  rm.nextPlayer(room);
  passCurrent(rm, room);
  s = await saved();
  assert.strictEqual(s.history[0].status, 'UNSOLD', 'unsold result');
  rm.skipCurrentSet({ roomCode: code, hostToken: H });
  s = await saved();
  assert.ok(s.history.some(h => h.status === 'SKIPPED'), 'skipped set');
  rm.updatePlayingXI({ roomCode: code, participantToken: A, franchiseId: 'MI', playingXI: [soldId], isConfirmed: false });
  s = await saved();
  assert.deepStrictEqual(s.playingXIConfigurations.MI.playingXI, [soldId], 'playing XI');
  bid(rm, room, H, 'CSK');
  for (let i = 0; i < 4; i++) rm.tickRoom(room);
  rm.pauseAuction({ roomCode: code, hostToken: H });
  s = await saved();
  assert.ok(s.status === 'paused' && s.currentLot.countdown === room.currentLot.countdown, 'pause keeps the exact countdown');
  rm.resumeAuction({ roomCode: code, hostToken: H });
  rm.finishAuction(room);
  s = await saved();
  assert.ok(s.status === 'completed' && s.evaluationResults, 'completion + evaluation');
  assert.deepStrictEqual(normalizeRoom(s), normalizeRoom(room), 'database copy differs from memory');
});

await t.it('P2: a paused rich room is restored EXACTLY after a restart; an active one follows the restart rule', async () => {
  let { rm } = await newManager();
  const { code, H } = richRoom(rm);
  const room = rm.getRoom(code);
  for (let i = 0; i < 6; i++) rm.tickRoom(room);
  rm.pauseAuction({ roomCode: code, hostToken: H });
  const before = normalizeRoom(room);
  await rm.shutdown();
  ({ rm } = await newManager());
  assert.deepStrictEqual(normalizeRoom(rm.getRoom(code)), before);

  // active room: paused on restart, open lot countdown reset to the full timer, bids kept
  rm.claimHashedSession(rm.getRoom(code), H);
  assert.ok(rm.resumeAuction({ roomCode: code, hostToken: H }).success);
  const live = rm.getRoom(code);
  for (let i = 0; i < 5; i++) rm.tickRoom(live);
  const high = live.currentLot.highestBid;
  await rm.flushStorage();
  ({ rm } = await newManager()); // previous manager not shut down: simulates a crash after the last write
  const r = rm.getRoom(code);
  assert.strictEqual(r.status, 'paused');
  assert.strictEqual(r.currentLot.countdown, r.config.timerDuration);
  assert.strictEqual(r.currentLot.hammerStatus, 'OPEN');
  assert.strictEqual(r.currentLot.highestBid, high);
  assert.strictEqual(r.auditLog[0].type, 'SERVER_RESTART_PAUSED');
});

await t.it('P3: writes are diffs — a bid writes 1 bid row; a sale touches only the rows that changed', async () => {
  const { rm, store } = await newManager();
  const { code, H, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  await rm.flushStorage();
  store.stats.upserted = {}; store.stats.deleted = {};
  bid(rm, room, A, 'MI');
  await rm.flushStorage();
  assert.deepStrictEqual(store.stats.upserted, { bids: 1, audit_logs: 1 }, `bid wrote ${JSON.stringify(store.stats.upserted)}`);
  store.stats.upserted = {};
  rm.closeCurrentLot(room);
  rm.nextPlayer(room);
  await rm.flushStorage();
  const u = store.stats.upserted;
  assert.strictEqual(u.room_players, 2, 'sold player + next player status');
  assert.strictEqual(u.franchises, 1, 'only the buyer changed');
  assert.strictEqual(u.squad_entries, 1);
  assert.strictEqual(u.lot_results, 1);
  assert.ok(!u.participants && !u.bids, `unexpected writes ${JSON.stringify(u)}`);
  assert.deepStrictEqual(store.stats.deleted, {});
  void H;
});

await t.it('P4: repeated and overlapping flushes never duplicate bids, results or audit entries', async () => {
  const { rm, store } = await newManager();
  const { code, H, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  const pending = [];
  for (let i = 0; i < 30; i++) {
    bid(rm, room, i % 2 ? H : A, i % 2 ? 'CSK' : 'MI');
    store.markDirty(code);
    pending.push(store.flushAll()); // deliberately overlapping
  }
  sellCurrent(rm, room, A, 'MI');
  for (let i = 0; i < 5; i++) { store.markDirty(code); pending.push(store.flushAll()); }
  await Promise.all(pending);
  await rm.flushStorage();
  assert.strictEqual(await count('bids', code), room.allBids.length);
  assert.strictEqual(await count('lot_results', code), room.history.length);
  assert.strictEqual(await count('audit_logs', code), room.auditSeq);
  assert.deepStrictEqual(normalizeRoom(await dbRoom(code)), normalizeRoom(room));
});

await t.it('P5: the database keeps every audit entry; memory and restore keep the newest 200', async () => {
  const { rm } = await newManager();
  const { code, H } = lobbyRoom(rm);
  for (let i = 0; i < 260; i++) rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { autoAdvanceDelay: 2 + (i % 3) } });
  await rm.flushStorage();
  const room = rm.getRoom(code);
  assert.strictEqual(room.auditLog.length, 200);
  assert.strictEqual(await count('audit_logs', code), room.auditSeq, 'trimmed entries were deleted from the database');
  const restored = await dbRoom(code);
  assert.deepStrictEqual(restored.auditLog.map(a => a.seq), room.auditLog.map(a => a.seq));
});

await t.it('P6: two writers → the stale one gets a CONFLICT; the database copy is never overwritten', async () => {
  const a = await newManager();
  const { code, H } = lobbyRoom(a.rm);
  await a.rm.flushStorage();
  const b = await newManager(); // second instance loads the same room
  b.rm.claimHashedSession(b.rm.getRoom(code), H);
  b.rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { autoAdvanceDelay: 10 } });
  assert.strictEqual(await b.rm.flushStorage(), true);
  a.rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { autoAdvanceDelay: 5 } });
  assert.strictEqual(await a.rm.flushStorage(), false, 'stale writer reported success');
  assert.deepStrictEqual(a.store.status.conflicts, [code]);
  assert.match(a.store.status.lastError, /CONFLICT/);
  assert.strictEqual((await dbRoom(code)).config.autoAdvanceDelay, 10, 'stale writer overwrote the database');
  a.store.dirty.clear();
});

await t.it('P7: a failure inside a write rolls back everything from that write; the room stays pending and later saves fully', async () => {
  let fail = false;
  const { rm, store } = await newManager({
    faultInjector: async stage => { if (fail && stage === 'after:squad_entries') throw new Error('injected failure'); }
  });
  const { code, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  await rm.flushStorage(); fail = true;
  const versionBefore = (await admin.query('SELECT version FROM rooms WHERE room_code = $1', [code])).rows[0].version;
  const soldId = room.currentLot.player.id;
  sellCurrent(rm, room, A, 'MI');
  assert.strictEqual(await rm.flushStorage(), false);
  assert.strictEqual(await count('squad_entries', code), 0, 'partial write: squad entry committed');
  assert.strictEqual(await count('bids', code), 0, 'partial write: bid committed');
  const db1 = await dbRoom(code);
  assert.notStrictEqual(db1.playersCatalog.find(p => p.id === soldId).status, 'sold', 'partial write: catalogue committed');
  assert.strictEqual((await admin.query('SELECT version FROM rooms WHERE room_code = $1', [code])).rows[0].version, versionBefore);
  assert.ok(store.dirty.has(code) && store.status.pendingWrites === 1);
  fail = false;
  assert.strictEqual(await rm.flushStorage(), true);
  assert.deepStrictEqual(normalizeRoom(await dbRoom(code)), normalizeRoom(room));
});

await t.it('P8: a dropped connection mid-write (real pg_terminate_backend) is retried and succeeds', async () => {
  let kills = 0;
  const { rm, store } = await newManager({
    faultInjector: async (stage, code, client) => {
      if (stage === 'after:room_players' && kills === 0) {
        kills++;
        await client.query('SELECT pg_terminate_backend(pg_backend_pid())');
      }
    }
  });
  const { code, A } = liveRoom(rm);
  sellCurrent(rm, rm.getRoom(code), A, 'MI');
  assert.strictEqual(await rm.flushStorage(), true, `write failed: ${store.status.lastError}`);
  assert.strictEqual(kills, 1);
  assert.ok(store.stats.retries >= 1, 'no retry recorded');
  assert.deepStrictEqual(normalizeRoom(await dbRoom(code)), normalizeRoom(rm.getRoom(code)));
});

await t.it('P9: a commit whose acknowledgement was lost is adopted, not reported as a conflict (emulated lost ack)', async () => {
  const { rm, store } = await newManager();
  const { code, H, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  await rm.flushStorage();
  const stale = store.cache.get(code);
  bid(rm, room, A, 'MI');
  await rm.flushStorage(); // commits
  // Emulate "COMMIT succeeded but the client never saw it": cache rolled back, attempt pending
  const committed = store.cache.get(code);
  const row = (await admin.query('SELECT version, last_write_id FROM rooms WHERE room_code = $1', [code])).rows[0];
  store.cache.set(code, stale);
  store.pendingAttempt.set(code, { writeId: row.last_write_id, version: row.version, fps: committed.fps });
  bid(rm, room, H, 'CSK');
  assert.strictEqual(await rm.flushStorage(), true, `not adopted: ${store.status.lastError}`);
  assert.deepStrictEqual(store.status.conflicts, []);
  assert.strictEqual(await count('bids', code), 2);
  assert.deepStrictEqual(normalizeRoom(await dbRoom(code)), normalizeRoom(room));
});

await t.it('P10: PostgreSQL mode never reads or writes the JSON file', async () => {
  const file = tempStorageFile('pgmode');
  const decoy = { DECOY1: { status: 'lobby' } };
  fs.writeFileSync(file, JSON.stringify(decoy));
  const md5 = () => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  const before = md5();
  const prev = process.env.ROOM_STORAGE_FILE;
  process.env.ROOM_STORAGE_FILE = file;
  try {
    const { rm } = await newManager();
    assert.strictEqual(rm.storageFile, null);
    assert.strictEqual(rm.getRoom('DECOY1'), null, 'JSON room loaded in PostgreSQL mode');
    const { code } = liveRoom(rm);
    await rm.flushStorage();
    assert.ok(await dbRoom(code));
    assert.strictEqual(md5(), before, 'JSON file changed in PostgreSQL mode');
    assert.ok(!fs.existsSync(`${file}.tmp`));
    assert.strictEqual(rm.storageStatus.kind, 'postgres');
    assert.strictEqual(rm.storageStatus.durable, true);
  } finally {
    if (prev === undefined) delete process.env.ROOM_STORAGE_FILE; else process.env.ROOM_STORAGE_FILE = prev;
  }
});

await t.it('P11: a room code created by another instance is never overwritten by a new room with the same code', async () => {
  const a = await newManager();
  const b = await newManager();
  const roomB = b.rm.createRoom({ hostName: 'B', hostToken: strongToken('b') });
  await b.rm.flushStorage();
  a.rm.generateRoomCode = () => roomB.roomCode; // force the collision
  a.rm.createRoom({ hostName: 'A', hostToken: strongToken('a') });
  assert.strictEqual(await a.rm.flushStorage(), false);
  assert.deepStrictEqual(a.store.status.conflicts, [roomB.roomCode]);
  assert.strictEqual((await dbRoom(roomB.roomCode)).hostName, 'B');
  a.store.dirty.clear();
});

await t.it('P12: changing a Playing XI replaces its rows exactly (order kept, removed players gone)', async () => {
  const { rm } = await newManager();
  const { code, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  for (let i = 0; i < 6; i++) {
    if (room.currentLot.player.isOverseas) { passCurrent(rm, room); i--; continue; }
    sellCurrent(rm, room, A, 'MI');
  }
  const ids = room.franchises.MI.squad.map(p => p.id);
  const set = async xi => {
    assert.ok(rm.updatePlayingXI({ roomCode: code, participantToken: A, franchiseId: 'MI', playingXI: xi, captainId: xi[0], viceCaptainId: xi[1], isConfirmed: false }).success);
    await rm.flushStorage();
    const r = await admin.query(`SELECT player_id FROM lineup_players WHERE room_code = $1 AND franchise_id = 'MI' AND kind = 'saved' ORDER BY slot`, [code]);
    assert.deepStrictEqual(r.rows.map(x => x.player_id), xi);
  };
  await set(ids.slice(0, 5));
  await set([ids[4], ids[2], ids[5]]);
  assert.deepStrictEqual((await dbRoom(code)).franchises.MI.playingXI, [ids[4], ids[2], ids[5]]);
});

process.exit(await t.finish());
