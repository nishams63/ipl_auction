// Persistence & restart-recovery regression tests.
// NOTE: these exercise the CURRENT TEMPORARY JSON-file storage. It is not durable on Render
// (ephemeral disk). The same behaviours are the acceptance contract for the planned Neon store.
import assert from 'node:assert';
import fs from 'node:fs';
import {
  startServer, connect, emit, waitFor, createRoom, makeRunner, strongToken, sleep, tempStorageFile,
  trackManager, mockIo, freePort
} from './helpers/harness.js';

const { RoomManager } = await import('../server/roomManager.js');

const t = makeRunner('Persistence & Restart Recovery Suite (temporary JSON storage)');
const make = file => trackManager(new RoomManager(mockIo(), { storageFile: file }));
const readFile = file => JSON.parse(fs.readFileSync(file, 'utf-8'));

function lobbyRoom(rm, cfg = {}) {
  const H = strongToken('ph'); const A = strongToken('pa');
  const room = rm.createRoom({ hostName: 'Host', hostToken: H, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30, ...cfg } });
  rm.joinRoom({ roomCode: room.roomCode, participantName: 'Host', participantToken: H, socketId: 's1' });
  rm.joinRoom({ roomCode: room.roomCode, participantName: 'Alice', participantToken: A, socketId: 's2' });
  rm.selectFranchise({ roomCode: room.roomCode, participantToken: H, franchiseId: 'CSK' });
  rm.selectFranchise({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI' });
  return { room, H, A };
}
function liveRoom(rm, cfg) {
  const r = lobbyRoom(rm, cfg);
  rm.startAuction({ roomCode: r.room.roomCode, hostToken: r.H });
  return r;
}
const bid = (rm, room, token, fid) => {
  const lot = room.currentLot;
  const res = rm.placeBid({ roomCode: room.roomCode, participantToken: token, franchiseId: fid, bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
  assert.ok(res.success, res.error);
};

// ── P8: every important mutation reaches the file ─────────────
await t.it('P8: each important mutation is persisted (checked in the raw file after flush)', () => {
  const file = tempStorageFile('p8');
  const rm = make(file);
  const H = strongToken('mh'); const A = strongToken('ma');
  const saved = () => { rm.flushStorage(); return readFile(file)[code]; };
  const pending = () => assert.ok(rm.saveTimer, 'mutation did not schedule a save');

  // room creation (immediate write)
  const room = rm.createRoom({ hostName: 'Host', hostToken: H, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = room.roomCode;
  assert.ok(readFile(file)[code], 'room creation');

  rm.joinRoom({ roomCode: code, participantName: 'Host', participantToken: H, socketId: 's1' }); pending();
  rm.joinRoom({ roomCode: code, participantName: 'Alice', participantToken: A, socketId: 's2' }); pending();
  assert.strictEqual(saved().participants.length, 2, 'participant join');

  rm.joinRoom({ roomCode: code, participantName: 'Alice', participantToken: A, socketId: 's2b' }); pending();
  assert.strictEqual(new Map(saved().participants).get(A).socketId, 's2b', 'reconnection');

  rm.selectFranchise({ roomCode: code, participantToken: A, franchiseId: 'RR' }); pending();
  assert.strictEqual(saved().franchises.RR.isClaimed, true, 'franchise selection');
  rm.selectFranchise({ roomCode: code, participantToken: A, franchiseId: 'MI' }); pending();
  let s = saved();
  assert.strictEqual(s.franchises.RR.isClaimed, false, 'franchise release');
  assert.strictEqual(s.franchises.MI.isClaimed, true);
  rm.selectFranchise({ roomCode: code, participantToken: H, franchiseId: 'CSK' });

  assert.ok(rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { timerDuration: 25 } }).success); pending();
  assert.strictEqual(saved().config.timerDuration, 25, 'config change');

  assert.ok(rm.startAuction({ roomCode: code, hostToken: H }).success); pending();
  s = saved();
  assert.strictEqual(s.status, 'active', 'auction start');
  assert.strictEqual(s.currentLot.lotNumber, 1);

  const firstLot = room.currentLot;

  bid(rm, room, A, 'MI'); pending();
  s = saved();
  assert.strictEqual(s.currentLot.highestBidderFranchiseId, 'MI', 'bid acceptance');
  assert.strictEqual(s.allBids.length, 1);

  assert.ok(rm.pauseAuction({ roomCode: code, hostToken: H }).success); pending();
  assert.strictEqual(saved().status, 'paused', 'pause');
  assert.ok(rm.resumeAuction({ roomCode: code, hostToken: H }).success); pending();
  assert.strictEqual(saved().status, 'active', 'resume');

  rm.closeCurrentLot(room); pending();
  s = saved();
  assert.strictEqual(s.currentLot.hammerStatus, 'SOLD', 'SOLD result');
  assert.strictEqual(s.franchises.MI.squad.length, 1);
  assert.strictEqual(s.history[0].status, 'SOLD');

  // Playing XI may only use purchased players, so set it after MI's first purchase
  const xiRes = rm.updatePlayingXI({ roomCode: code, participantToken: A, franchiseId: 'MI', playingXI: [firstLot.player.id] });
  assert.ok(xiRes.success, xiRes.error);
  assert.deepStrictEqual(readFile(file)[code].playingXIConfigurations.MI.playingXI, [firstLot.player.id], 'Playing XI (immediate write)');

  rm.nextPlayer(room); pending();
  s = saved();
  assert.strictEqual(s.currentLot.lotNumber, 2, 'queue advancement');
  assert.strictEqual(s.currentPlayerIndex, 1);

  rm.closeCurrentLot(room); pending(); // no bids → UNSOLD
  s = saved();
  assert.strictEqual(s.history[0].status, 'UNSOLD', 'UNSOLD result');
  assert.strictEqual(s.playersCatalog[1].status, 'unsold');

  rm.nextPlayer(room);
  assert.ok(rm.skipCurrentSet({ roomCode: code, hostToken: H }).success);
  assert.ok(readFile(file)[code].history.some(h => h.status === 'SKIPPED'), 'skip set (immediate write)');

  rm.finishAuction(room); pending();
  s = saved();
  assert.strictEqual(s.status, 'completed', 'auction completion');
  assert.ok(s.evaluationResults, 'evaluation persisted');
});

await t.it('P8b: countdown ticks are NOT written to disk (documented: no per-second writes)', () => {
  const file = tempStorageFile('p8b');
  const rm = make(file);
  const { room } = liveRoom(rm);
  rm.flushStorage();
  for (let i = 0; i < 3; i++) rm.tickRoom(room);
  assert.strictEqual(room.currentLot.countdown, 12, 'in-memory clock ticked');
  assert.strictEqual(rm.saveTimer, null, 'a tick scheduled a write');
  assert.strictEqual(readFile(file)[room.roomCode].currentLot.countdown, 15, 'file still holds the last mutation value');
});

// ── P9: countdown recovery rule ───────────────────────────────
await t.it('P9: restart of an ACTIVE auction → paused, countdown reset to full timer, bid kept', () => {
  const file = tempStorageFile('p9');
  const rm1 = make(file);
  const { room, A } = liveRoom(rm1, { timerDuration: 30 });
  bid(rm1, room, A, 'MI');
  for (let i = 0; i < 27; i++) rm1.tickRoom(room); // 3 s left → GOING_TWICE
  assert.strictEqual(room.currentLot.hammerStatus, 'GOING_TWICE');
  rm1.flushStorage();
  rm1.saveToStorage(); // capture the in-memory value too, to prove recovery resets it
  rm1.shutdown();

  const rm2 = make(file);
  const r2 = rm2.getRoom(room.roomCode);
  assert.strictEqual(r2.status, 'paused');
  assert.strictEqual(r2.currentLot.countdown, 30, 'countdown reset to full timer');
  assert.strictEqual(r2.currentLot.hammerStatus, 'OPEN');
  assert.strictEqual(r2.currentLot.highestBidderFranchiseId, 'MI', 'highest bid kept');
  assert.match(r2.auditLog[0].message, /countdown reset to 30s/);
});

await t.it('P9: restart of a host-PAUSED auction keeps the exact paused countdown', () => {
  const file = tempStorageFile('p9b');
  const rm1 = make(file);
  const { room, H } = liveRoom(rm1);
  for (let i = 0; i < 6; i++) rm1.tickRoom(room); // 9 s left
  rm1.pauseAuction({ roomCode: room.roomCode, hostToken: H });
  rm1.shutdown(); // flushes

  const rm2 = make(file);
  const r2 = rm2.getRoom(room.roomCode);
  assert.strictEqual(r2.status, 'paused');
  assert.strictEqual(r2.currentLot.countdown, 9);
  assert.ok(rm2.resumeAuction({ roomCode: room.roomCode, hostToken: H }).success);
  rm2.tickRoom(r2);
  assert.strictEqual(r2.currentLot.countdown, 8, 'clock continues from 9');
});

await t.it('P3: a sale persists and the sold player is never re-auctioned after restart', () => {
  const file = tempStorageFile('p3');
  const rm1 = make(file);
  const { room, H } = liveRoom(rm1);
  const lot = room.currentLot;
  bid(rm1, room, H, 'CSK');
  rm1.closeCurrentLot(room); // restart happens in the post-sale gap
  rm1.shutdown();

  const rm2 = make(file);
  const r2 = rm2.getRoom(room.roomCode);
  assert.strictEqual(r2.franchises.CSK.squad.length, 1);
  assert.strictEqual(r2.franchises.CSK.remainingPurse, 120 - lot.highestBid);
  rm2.resumeAuction({ roomCode: room.roomCode, hostToken: H });
  assert.notStrictEqual(r2.currentLot.player.id, lot.player.id, 'sold player reintroduced');
  assert.strictEqual(r2.playersCatalog.find(p => p.id === lot.player.id).status, 'sold');
  assert.strictEqual(r2.franchises.CSK.squad.length, 1, 'no double sale');
});

await t.it('P5: saves are atomic (valid JSON, no leftover temp file)', () => {
  const file = tempStorageFile('p5');
  const rm = make(file);
  liveRoom(rm);
  rm.saveToStorage();
  assert.doesNotThrow(() => readFile(file));
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

await t.it('P6: rooms saved in the pre-Stage-0.5 format are migrated and never leak tokens', () => {
  const file = tempStorageFile('p6');
  const rmSeed = make(file);
  const { room, A } = liveRoom(rmSeed);
  rmSeed.shutdown();
  const legacy = readFile(file);
  for (const [, p] of legacy[room.roomCode].participants) delete p.publicId;
  for (const f of Object.values(legacy[room.roomCode].franchises)) delete f.ownerId;
  fs.writeFileSync(file, JSON.stringify(legacy));

  const rm2 = make(file);
  const r2 = rm2.getRoom(room.roomCode);
  const alice = r2.participants.get(A);
  assert.ok(alice.publicId, 'publicId assigned');
  assert.strictEqual(r2.franchises.MI.ownerId, alice.publicId, 'ownership mapped');
  assert.ok(!JSON.stringify(rm2.getPublicRoomState(r2)).includes(A), 'token leaked after migration');
});

await t.it('P11: /api/health reports storage as non-durable JSON (cannot be mistaken for production storage)', async () => {
  const srv = await startServer();
  const h = await (await fetch(`${srv.url}/api/health`)).json();
  assert.strictEqual(h.storage.kind, 'json-file');
  assert.strictEqual(h.storage.durable, false);
  assert.match(h.storage.warning, /Not durable/);
  assert.ok(!h.storage.file.includes('/'), 'server path exposed');
  assert.match(srv.getLog(), /\[storage\].*Not durable/, 'startup warning missing');
  await srv.stop();
});

// ── P10: real restart on the SAME port, clients reconnect by themselves ──
await t.it('P10: server restart → auto-reconnecting clients rejoin, see same lot (paused, 15s), host resumes', async () => {
  const file = tempStorageFile('p10');
  const port = await freePort();
  const H = strongToken('rh'); const A = strongToken('ra');
  let srv = await startServer({ storageFile: file, port });
  const { body } = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2 } });
  const code = body.roomCode;

  // Clients behave like the real app: reconnect automatically and rejoin on every 'connect'
  const h = await connect(srv.url, { reconnection: true });
  const a = await connect(srv.url, { reconnection: true });
  const rejoins = { h: [], a: [] };
  const wire = (sock, name, token, key) => sock.on('connect', async () => {
    rejoins[key].push(await emit(sock, 'join_room', { roomCode: code, participantName: name, participantToken: token }));
  });
  wire(h, 'Host', H, 'h'); wire(a, 'Alice', A, 'a');
  await emit(h, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(h, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(a, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(a, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  const lp = waitFor(a, 'lot_presented');
  await emit(h, 'start_auction', { roomCode: code });
  const lot = (await lp).currentLot;
  assert.ok((await emit(a, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion })).success);
  await waitFor(a, 'timer_tick', d => d.countdown <= 13, 4000); // let the clock run down a bit

  await srv.stop();                                   // SIGTERM → flush
  srv = await startServer({ storageFile: file, port }); // same port, same file

  const deadline = Date.now() + 8000;
  while ((rejoins.h.length === 0 || rejoins.a.length === 0) && Date.now() < deadline) await sleep(100);
  const aj = rejoins.a.at(-1); const hj = rejoins.h.at(-1);
  assert.ok(aj?.success && hj?.success, 'clients did not rejoin automatically');
  assert.strictEqual(aj.room.status, 'paused');
  assert.strictEqual(aj.room.currentLot.player.id, lot.player.id, 'same lot');
  assert.strictEqual(aj.room.currentLot.highestBidderFranchiseId, 'MI', 'bid survived');
  assert.strictEqual(aj.room.currentLot.countdown, 15, 'countdown reset to full timer');
  assert.strictEqual(aj.participant.franchiseId, 'MI');

  const tick = waitFor(a, 'timer_tick', () => true, 3000);
  assert.ok((await emit(h, 'resume_auction', { roomCode: code })).success);
  assert.strictEqual((await tick).countdown, 14, 'clock resumes from the full timer');
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
