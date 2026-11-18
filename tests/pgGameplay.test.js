// INTEGRATION (real PostgreSQL): Stage 2 gameplay state survives PostgreSQL persistence —
// locked lot order, exact purses, SOLD/UNSOLD/SKIPPED results, forced finish.
import assert from 'node:assert';
import { makeRunner, trackManager, mockIo, registerAsyncCleanup, connect, emit, createRoom, strongToken } from './helpers/harness.js';
import { requireTestDatabase, startPgServer } from './helpers/pg.js';
import { liveRoom, bid, normalizeRoom } from './helpers/auctionRooms.js';

const t = makeRunner('PostgreSQL Gameplay Suite — INTEGRATION (real PostgreSQL)');
const db = await requireTestDatabase('gameplay');
if (!db) process.exit(await t.finish());

const { createPool } = await import('../server/persistence/db.js');
const { runMigrations } = await import('../server/persistence/migrate.js');
const { PostgresStore } = await import('../server/persistence/postgresStore.js');
const { RoomManager } = await import('../server/roomManager.js');
const { toLakh } = await import('../server/money.js');
const admin = createPool(db.url, { max: 2 });
registerAsyncCleanup(() => admin.end());
await runMigrations(admin);

async function manager() {
  const store = new PostgresStore({ connectionString: db.url, poolMax: 2 });
  await store.init({ log: () => {} });
  registerAsyncCleanup(async () => { try { await store.close(); } catch { /* closed */ } });
  const rm = trackManager(new RoomManager(mockIo(), { store }));
  await rm.init();
  return { rm, store };
}

await t.it('PG1: the locked lot order, exact purses and every lot result round-trip through PostgreSQL unchanged', async () => {
  let { rm, store } = await manager();
  const { code, H, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  const order = room.playersCatalog.map(p => p.id);
  // sales at awkward amounts, an unsold lot, a skipped set, then a forced finish with a live bid
  for (let i = 0; i < 4; i++) {
    bid(rm, room, A, 'MI'); bid(rm, room, H, 'CSK'); bid(rm, room, A, 'MI');
    rm.closeCurrentLot(room); rm.nextPlayer(room);
  }
  rm.closeCurrentLot(room); rm.nextPlayer(room); // unsold
  assert.ok(rm.skipCurrentSet({ roomCode: code, hostToken: H }).success);
  bid(rm, room, H, 'CSK');
  const lastId = room.currentLot.player.id;
  rm.finishAuction(room);
  assert.ok(await rm.persisted(room));
  const positions = (await admin.query('SELECT player_id FROM room_players WHERE room_code = $1 ORDER BY position', [code])).rows.map(r => r.player_id);
  assert.deepStrictEqual(positions, order, 'database lot order differs from the locked order');
  const purse = (await admin.query(`SELECT remaining_purse::text AS p, total_spent::text AS s FROM franchises WHERE room_code = $1 AND franchise_id = 'MI'`, [code])).rows[0];
  assert.strictEqual(toLakh(Number(purse.p)) + toLakh(Number(purse.s)), 12000);
  assert.ok(/^\d+(\.\d{1,2})?$/.test(purse.p), `inexact purse stored: ${purse.p}`);
  const before = normalizeRoom(room);
  await rm.shutdown(); await store.close();
  ({ rm, store } = await manager());
  const r2 = rm.getRoom(code);
  assert.deepStrictEqual(normalizeRoom(r2), before);
  assert.strictEqual(r2.playersCatalog.find(p => p.id === lastId).soldTo, 'CSK', 'forced-finish sale lost');
  const dupes = await admin.query('SELECT player_id FROM lot_results WHERE room_code = $1 GROUP BY player_id HAVING count(*) > 1', [code]);
  assert.strictEqual(dupes.rowCount, 0);
});

await t.it('PG2: real server — the shuffled order shown to clients is identical after a crash and restart, and the auction continues from the same lot', async () => {
  const H = strongToken('h'); const A = strongToken('a');
  let srv = await startPgServer({ PERSISTENCE: 'postgres', DATABASE_URL: db.url });
  const c = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = c.body.roomCode;
  const h = await connect(srv.url); const a = await connect(srv.url);
  await emit(h, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(a, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(h, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(a, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  assert.ok((await emit(h, 'start_auction', { roomCode: code })).success);
  assert.ok((await emit(h, 'advance_lot', { roomCode: code })).success); // lot 1 unsold
  assert.ok((await emit(h, 'advance_lot', { roomCode: code })).success); // lot 2 presented
  const before = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  await new Promise(r => { srv.child.once('exit', r); srv.child.kill('SIGKILL'); });
  srv = await startPgServer({ PERSISTENCE: 'postgres', DATABASE_URL: db.url });
  const after = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  assert.deepStrictEqual(after.playersCatalog.map(p => p.id), before.playersCatalog.map(p => p.id), 'order regenerated after restart');
  assert.strictEqual(after.currentLot.player.id, before.currentLot.player.id);
  assert.strictEqual(after.currentPlayerIndex, 1);
  assert.strictEqual(after.status, 'paused');
  const h2 = await connect(srv.url);
  await emit(h2, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  assert.strictEqual((await emit(h2, 'start_auction', { roomCode: code })).success, false, 'auction restarted / order regenerable');
  await srv.stop();
});

process.exit(await t.finish());
