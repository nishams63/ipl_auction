// INTEGRATION (real PostgreSQL): critical operations are durable BEFORE they are acknowledged
// or broadcast. Crash tests kill a real server process with SIGKILL the moment an ack arrives.
import assert from 'node:assert';
import { makeRunner, connect, emit, createRoom, strongToken, sleep, trackManager, registerAsyncCleanup } from './helpers/harness.js';
import { requireTestDatabase, startPgServer } from './helpers/pg.js';
import { liveRoom, bid, sellCurrent } from './helpers/auctionRooms.js';

const t = makeRunner('PostgreSQL Durability Suite — INTEGRATION (real PostgreSQL, real server processes)');
const db = await requireTestDatabase('durable');
if (!db) process.exit(await t.finish());

const { createPool } = await import('../server/persistence/db.js');
const { runMigrations } = await import('../server/persistence/migrate.js');
const { PostgresStore } = await import('../server/persistence/postgresStore.js');
const { RoomManager } = await import('../server/roomManager.js');
const admin = createPool(db.url, { max: 2 });
registerAsyncCleanup(() => admin.end());
await runMigrations(admin);

const ENV = { PERSISTENCE: 'postgres', DATABASE_URL: db.url };
const q1 = async (sql, p) => (await admin.query(sql, p)).rows[0];
const state = async (url, code) => (await fetch(`${url}/api/rooms/${code}`)).json();
const kill9 = srv => new Promise(r => { srv.child.once('exit', r); srv.child.kill('SIGKILL'); });

// In-process manager with a capturing io (records every room broadcast in order)
function capturingIo() {
  const sent = [];
  return { sent, to: code => ({ emit: (event, payload) => sent.push({ code, event, payload }) }), emit: () => {}, sockets: { sockets: new Map() } };
}
async function inProcess(opts = {}) {
  const store = new PostgresStore({ connectionString: db.url, poolMax: 3, retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 20 }, ...opts });
  await store.init({ log: () => {} });
  registerAsyncCleanup(async () => { store.dirty.clear(); store.conflicts.add('*'); try { await store.close(); } catch { /* closed */ } });
  const io = capturingIo();
  const rm = trackManager(new RoomManager(io, { store }));
  await rm.init();
  return { rm, store, io };
}

await t.it('K1: every acknowledged critical action survives a SIGKILL sent the instant its ack arrives', async () => {
  const H = strongToken('h'); const A = strongToken('a');
  let srv = await startPgServer(ENV);
  let host; let alice; let code;
  const restart = async () => { await kill9(srv); srv = await startPgServer(ENV); };
  const rejoin = async () => {
    host = await connect(srv.url); alice = await connect(srv.url);
    assert.ok((await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H })).success);
    assert.ok((await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A })).success);
  };

  // room creation (HTTP 200 = committed)
  const c = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  code = c.body.roomCode;
  await restart();
  assert.strictEqual((await fetch(`${srv.url}/api/rooms/${code}`)).status, 200, 'acknowledged room creation lost');

  // joins + franchise selection
  await rejoin();
  assert.ok((await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' })).success);
  assert.ok((await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' })).success);
  await restart();
  let st = await state(srv.url, code);
  assert.ok(st.franchises.CSK.isClaimed && st.franchises.MI.isClaimed, 'acknowledged franchise selection lost');

  // start
  await rejoin();
  assert.ok((await emit(host, 'start_auction', { roomCode: code })).success);
  await restart();
  st = await state(srv.url, code);
  assert.ok(st.status === 'paused' && st.currentLot, 'acknowledged auction start lost');

  // bid
  await rejoin();
  assert.ok((await emit(host, 'resume_auction', { roomCode: code })).success);
  st = await state(srv.url, code);
  const b = await emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: st.currentLot.nextValidBid, expectedVersion: st.currentLot.stateVersion });
  assert.ok(b.success, b.error);
  await restart();
  st = await state(srv.url, code);
  assert.strictEqual(st.currentLot.highestBidderFranchiseId, 'MI', 'acknowledged bid lost');
  assert.strictEqual(st.recentBids.length, 1);
  const price = st.currentLot.highestBid;
  const pid = st.currentLot.player.id;

  // sale (host advance closes the lot)
  await rejoin();
  assert.ok((await emit(host, 'resume_auction', { roomCode: code })).success);
  assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success);
  await restart();
  st = await state(srv.url, code);
  assert.ok(st.franchises.MI.squad.some(p => p.id === pid), 'acknowledged sale lost (squad)');
  assert.strictEqual(st.playersCatalog.find(p => p.id === pid).soldTo, 'MI', 'acknowledged sale lost (catalogue)');
  assert.strictEqual(st.franchises.MI.remainingPurse, Math.round((st.franchises.MI.initialPurse - price) * 100) / 100, 'purse not deducted exactly once');
  assert.strictEqual(st.history.filter(h => h.player.id === pid).length, 1);

  // Playing XI
  await rejoin();
  const xi = await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [pid] });
  assert.ok(xi.success, xi.error);
  await restart();
  st = await state(srv.url, code);
  assert.deepStrictEqual(st.playingXIConfigurations.MI.playingXI, [pid], 'acknowledged Playing XI lost');

  // pause keeps the exact countdown
  await rejoin();
  assert.ok((await emit(host, 'resume_auction', { roomCode: code })).success);
  await sleep(2200);
  const p = await emit(host, 'pause_auction', { roomCode: code });
  assert.ok(p.success);
  const countdown = p.room.currentLot.countdown;
  await restart();
  st = await state(srv.url, code);
  assert.strictEqual(st.status, 'paused');
  assert.strictEqual(st.currentLot.countdown, countdown, 'acknowledged pause countdown lost');
  await srv.stop();
});

await t.it('K2: no acknowledgement and no broadcast leaves the server before the transaction commits; health counts the in-flight write as pending', async () => {
  let gate = null;
  const { rm, io } = await inProcess({ faultInjector: async stage => { if (stage === 'beforeCommit' && gate) await gate.promise; } });
  const { code, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  assert.ok(await rm.persisted(room));
  let open; gate = { promise: new Promise(r => { open = r; }) };
  const before = io.sent.length;
  bid(rm, room, A, 'MI');                      // accepted in memory…
  let acked = false;
  const durable = rm.persisted(room).then(v => { acked = v; });
  rm.tickRoom(room);                           // a tick while the bid is uncommitted
  await sleep(150);
  assert.strictEqual(acked, false, 'acknowledged before commit');
  assert.strictEqual(rm.storageStatus.pendingWrites, 1, 'health does not count the in-flight write as pending');
  assert.strictEqual(io.sent.length, before, `broadcast before commit: ${io.sent.slice(before).map(m => m.event)}`);
  open(); gate = null;
  await durable;
  assert.strictEqual(acked, true);
  assert.strictEqual(rm.storageStatus.pendingWrites, 0);
  const events = io.sent.slice(before).map(m => m.event);
  assert.deepStrictEqual(events.slice(0, 2), ['bid_accepted', 'timer_tick'], `order not preserved: ${events}`);
  assert.strictEqual(io.sent[before].payload.bid.franchiseId, 'MI');
});

await t.it('K3: concurrent bids at the same lot version — exactly one accepted per round, all accepted bids survive a SIGKILL', async () => {
  const H = strongToken('h'); const A = strongToken('a');
  let srv = await startPgServer(ENV);
  const c = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = c.body.roomCode;
  const host = await connect(srv.url); const alice = await connect(srv.url);
  await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  await emit(host, 'start_auction', { roomCode: code });
  let accepted = 0;
  for (let round = 0; round < 10; round++) {
    const st = await state(srv.url, code);
    const lot = st.currentLot;
    const res = await Promise.all([
      emit(host, 'place_bid', { roomCode: code, franchiseId: 'CSK', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion }),
      emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion })
    ]);
    const ok = res.filter(r => r.success).length;
    assert.strictEqual(ok, 1, `round ${round}: ${ok} bids accepted for one lot version`);
    accepted += ok;
  }
  await kill9(srv);
  const n = await q1('SELECT count(*)::int AS n, count(DISTINCT state_version)::int AS v FROM bids WHERE room_code = $1', [code]);
  assert.strictEqual(n.n, accepted, 'acknowledged bids missing after crash');
  assert.strictEqual(n.v, accepted, 'duplicate lot state versions');
  srv = await startPgServer(ENV);
  const st = await state(srv.url, code);
  assert.strictEqual(st.currentLot.stateVersion, 1 + accepted);
  await srv.stop();
});

await t.it('K4: concurrent hammer requests (timer expiry + two host advances) cannot sell a player twice or deduct the purse twice', async () => {
  const { rm, store } = await inProcess();
  const { code, H, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  bid(rm, room, A, 'MI');
  const pid = room.currentLot.player.id;
  const price = room.currentLot.highestBid;
  // timer expiry and two host advances racing for the same open lot
  room.currentLot.countdown = 1;
  rm.tickRoom(room);
  rm.closeCurrentLot(room);
  rm.skipOrAdvanceLot({ roomCode: code, hostToken: H });
  assert.ok(await rm.persisted(room));
  const squad = await q1(`SELECT count(*)::int AS n FROM squad_entries WHERE room_code = $1 AND player_id = $2`, [code, pid]);
  const results = await q1(`SELECT count(*)::int AS n FROM lot_results WHERE room_code = $1 AND player_id = $2`, [code, pid]);
  const purse = await q1(`SELECT remaining_purse FROM franchises WHERE room_code = $1 AND franchise_id = 'MI'`, [code]);
  assert.strictEqual(squad.n, 1);
  assert.strictEqual(results.n, 1);
  assert.strictEqual(Number(purse.remaining_purse), Math.round((120 - price) * 100) / 100);
  assert.strictEqual(room.franchises.MI.squad.filter(p => p.id === pid).length, 1);
  void store;
});

await t.it('K5: when saving fails the room goes on STORAGE HOLD — paused, unconfirmed, nothing broadcast — and recovers without loss', async () => {
  let down = false;
  const { rm, store, io } = await inProcess({ faultInjector: async stage => { if (down && stage === 'afterLock') { const e = new Error('simulated outage'); e.code = '08006'; throw e; } } });
  const { code, H, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  assert.ok(await rm.persisted(room));
  down = true;
  const before = io.sent.length;
  bid(rm, room, A, 'MI');
  assert.strictEqual(await rm.persisted(room), false, 'reported durable during an outage');
  assert.strictEqual(room.storageHold, true);
  assert.strictEqual(room.status, 'paused', 'live auction not paused on hold');
  assert.ok(!rm.timerIntervals.has(code), 'clock still running on hold');
  assert.ok(rm.storageBlocked(room));
  assert.deepStrictEqual(rm.storageStatus.roomsOnHold, [code]);
  assert.strictEqual(io.sent.length, before, 'unsaved change was broadcast');
  assert.strictEqual(await q1('SELECT count(*)::int AS n FROM bids WHERE room_code = $1', [code]).then(r => r.n), 0);
  // storage comes back: background retry (here triggered directly) saves everything and releases the hold
  down = false;
  assert.strictEqual(await store.flushAll(), true);
  assert.strictEqual(room.storageHold, false);
  assert.deepStrictEqual(rm.storageStatus.roomsOnHold, []);
  const events = io.sent.slice(before).map(m => m.event);
  assert.strictEqual(events[0], 'bid_accepted', `held broadcasts not released in order: ${events}`);
  assert.strictEqual(await q1('SELECT count(*)::int AS n FROM bids WHERE room_code = $1', [code]).then(r => r.n), 1);
  assert.strictEqual((await q1('SELECT status FROM rooms WHERE room_code = $1', [code])).status, 'paused');
  assert.ok((await q1(`SELECT count(*)::int AS n FROM audit_logs WHERE room_code = $1 AND type = 'STORAGE_HOLD_PAUSED'`, [code])).n === 1);
  assert.ok(rm.resumeAuction({ roomCode: code, hostToken: H }).success);
  assert.ok(await rm.persisted(room));
});

await t.it('K6: a sale whose commit acknowledgement was lost is adopted on retry — no duplicate squad row, no double purse deduction (emulated lost ack)', async () => {
  const { rm, store } = await inProcess();
  const { code, H, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  assert.ok(await rm.persisted(room));
  const stale = store.cache.get(code);
  const staleSeq = store.committedSeq.get(code);
  sellCurrent(rm, room, A, 'MI');
  assert.ok(await rm.persisted(room));
  const committed = store.cache.get(code);
  const row = await q1('SELECT version, last_write_id FROM rooms WHERE room_code = $1', [code]);
  store.cache.set(code, stale);
  store.committedSeq.set(code, staleSeq);
  store.pendingAttempt.set(code, { writeId: row.last_write_id, version: row.version, fps: committed.fps });
  store.markDirty(code);
  bid(rm, room, H, 'CSK');
  assert.ok(await rm.persisted(room), `not adopted: ${store.status.lastError}`);
  const pid = room.franchises.MI.squad[0].id;
  assert.strictEqual((await q1('SELECT count(*)::int AS n FROM squad_entries WHERE room_code = $1', [code])).n, 1);
  assert.strictEqual((await q1('SELECT count(*)::int AS n FROM lot_results WHERE room_code = $1 AND player_id = $2', [code, pid])).n, 1);
  assert.strictEqual(Number((await q1(`SELECT remaining_purse FROM franchises WHERE room_code = $1 AND franchise_id = 'MI'`, [code])).remaining_purse), room.franchises.MI.remainingPurse);
  assert.deepStrictEqual(store.status.conflicts, []);
});

process.exit(await t.finish());
