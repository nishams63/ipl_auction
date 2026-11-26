// Auction integrity: ownership, post-completion actions, timer-close races, concurrent bids.
import assert from 'node:assert';
import {
  startServer, connect, emit, waitFor, createRoom, makeRunner, strongToken, sleep, tempStorageFile,
  trackManager, mockIo
} from './helpers/harness.js';

process.env.ROOM_STORAGE_FILE = process.env.ROOM_STORAGE_FILE || tempStorageFile('integrity-unit');
const { RoomManager } = await import('../server/roomManager.js');

const t = makeRunner('Auction Integrity Suite');
const srv = await startServer();

async function liveSocketRoom(config = {}) {
  const H = strongToken('ih'); const A = strongToken('ia');
  const { body } = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2, ...config } });
  const code = body.roomCode;
  const host = await connect(srv.url); const alice = await connect(srv.url);
  await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  const lp = waitFor(alice, 'lot_presented');
  assert.ok((await emit(host, 'start_auction', { roomCode: code })).success);
  return { code, host, alice, H, A, lot: (await lp).currentLot };
}
const getRoom = async code => (await fetch(`${srv.url}/api/rooms/${code}`)).json();

try {
  await t.it("a participant cannot update another franchise's Playing XI", async () => {
    const { code, alice, host, lot } = await liveSocketRoom();
    // give CSK a player so there is something to tamper with
    await emit(host, 'place_bid', { roomCode: code, franchiseId: 'CSK', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
    await emit(host, 'advance_lot', { roomCode: code });
    const room = await getRoom(code);
    const cskPlayer = room.franchises.CSK.squad[0].id;
    assert.ok((await emit(host, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [cskPlayer] })).success);

    const r = await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [] });
    assert.strictEqual(r.success, false, 'Alice edited CSK');
    const r2 = await emit(alice, 'update_playing_xi', { roomCode: code, participantToken: 'usr_spoofed_token_value_1234', franchiseId: 'CSK', playingXI: [] });
    assert.strictEqual(r2.success, false, 'spoofed token accepted');
    const after = await getRoom(code);
    assert.deepStrictEqual(after.playingXIConfigurations.CSK.playingXI, [cskPlayer], 'CSK XI changed');
    // Her own XI is still editable
    assert.ok((await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [] })).success);
  });

  await t.it('after completion, every host auction action is rejected and results are unchanged', async () => {
    const { code, host, alice, lot } = await liveSocketRoom();
    await emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
    const done = waitFor(alice, 'auction_completed');
    assert.ok((await emit(host, 'finish_auction', { roomCode: code })).success);
    await done;
    const before = await getRoom(code);
    const attempts = [
      ['finish_auction', {}], ['start_auction', {}], ['pause_auction', {}], ['resume_auction', {}],
      ['advance_lot', {}], ['skip_set', {}], ['update_config', { config: { timerDuration: 30 } }],
      ['select_franchise', { franchiseId: 'RR' }], ['place_bid', { franchiseId: 'CSK', expectedVersion: 1 }]
    ];
    for (const [ev, extra] of attempts) {
      const r = await emit(host, ev, { roomCode: code, ...extra });
      assert.strictEqual(r.success, false, `${ev} accepted after completion`);
    }
    const after = await getRoom(code);
    assert.strictEqual(after.status, 'completed');
    assert.deepStrictEqual(after.evaluationResults, before.evaluationResults, 'rankings changed');
    assert.deepStrictEqual(after.history, before.history, 'history changed');
    assert.strictEqual(after.config.timerDuration, before.config.timerDuration);
  });

  await t.it('two simultaneous bids with the same stateVersion → exactly one accepted (3 rooms)', async () => {
    for (let i = 0; i < 3; i++) {
      const { code, host, alice, lot } = await liveSocketRoom();
      const payload = fid => ({ roomCode: code, franchiseId: fid, bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
      const [rh, ra] = await Promise.all([emit(host, 'place_bid', payload('CSK')), emit(alice, 'place_bid', payload('MI'))]);
      const wins = [rh, ra].filter(r => r.success);
      assert.strictEqual(wins.length, 1, `round ${i}: ${JSON.stringify([rh, ra])}`);
      const loser = rh.success ? ra : rh;
      assert.match(loser.error, /Stale|another bid/i);
      const room = await getRoom(code);
      assert.strictEqual(room.currentLot.bidHistory.length, 1, 'more than one bid recorded');
      assert.strictEqual(room.currentLot.highestBidderFranchiseId, rh.success ? 'CSK' : 'MI');
      assert.strictEqual(room.currentLot.highestBid, lot.nextValidBid);
    }
  });

  await t.it('bid racing the final second over real sockets: outcome is always consistent', async () => {
    const { code, host, alice, lot } = await liveSocketRoom();
    await emit(host, 'place_bid', { roomCode: code, franchiseId: 'CSK', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
    const completed = waitFor(alice, 'lot_completed', () => true, 20000);
    const tick = await waitFor(alice, 'timer_tick', d => d.countdown === 1, 20000);
    const pub = await getRoom(code);
    const r = await emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: pub.currentLot.nextValidBid, expectedVersion: tick.stateVersion });
    if (r.success) {
      // Bid beat the hammer: lot must stay open with a fresh full countdown
      const after = await getRoom(code);
      assert.strictEqual(after.currentLot.highestBidderFranchiseId, 'MI');
      assert.strictEqual(after.currentLot.hammerStatus, 'OPEN');
      assert.ok(after.currentLot.countdown >= 14, 'countdown not reset');
      await emit(host, 'advance_lot', { roomCode: code });
      const done = await completed;
      assert.strictEqual(done.historyEntry.winningFranchiseId, 'MI');
    } else {
      // Hammer fell first: bid refused, sale goes to the previous highest bidder
      assert.match(r.error, /closed|Stale|not actively/i);
      const done = await completed;
      assert.strictEqual(done.historyEntry.winningFranchiseId, 'CSK');
      assert.strictEqual(done.lot.bidHistory.length, 1, 'late bid recorded');
    }
  });
} finally {
  await srv.stop();
}

// Deterministic versions of the timer-close race (no wall clock)
function unitRoom() {
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('race') }));
  const H = strongToken('uh'); const A = strongToken('ua');
  const room = rm.createRoom({ hostName: 'H', hostToken: H, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30 } });
  rm.joinRoom({ roomCode: room.roomCode, participantName: 'H', participantToken: H, socketId: 's1' });
  rm.joinRoom({ roomCode: room.roomCode, participantName: 'A', participantToken: A, socketId: 's2' });
  rm.selectFranchise({ roomCode: room.roomCode, participantToken: H, franchiseId: 'CSK' });
  rm.selectFranchise({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI' });
  rm.startAuction({ roomCode: room.roomCode, hostToken: H });
  rm.clearRoomTimer(room.roomCode); // drive the clock by hand
  const lot = room.currentLot;
  assert.ok(rm.placeBid({ roomCode: room.roomCode, participantToken: H, franchiseId: 'CSK', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion }).success);
  return { rm, room, H, A };
}

await t.it('hammer falls on the last tick, then a bid arrives → bid rejected, sale to prior bidder', () => {
  const { rm, room, A } = unitRoom();
  const lot = room.currentLot;
  lot.countdown = 1;
  const version = lot.stateVersion;
  rm.tickRoom(room); // countdown → 0 → SOLD
  assert.strictEqual(lot.hammerStatus, 'SOLD');
  const r = rm.placeBid({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: version });
  assert.strictEqual(r.success, false);
  assert.strictEqual(room.franchises.CSK.squad.length, 1);
  assert.strictEqual(room.franchises.MI.squad.length, 0);
  assert.strictEqual(lot.bidHistory.length, 1);
});

await t.it('bid arrives just before the last tick → accepted, clock reset, the tick does not close the lot', () => {
  const { rm, room, A } = unitRoom();
  const lot = room.currentLot;
  lot.countdown = 1;
  const r = rm.placeBid({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
  assert.ok(r.success, r.error);
  assert.strictEqual(lot.countdown, room.config.timerDuration);
  rm.tickRoom(room);
  assert.strictEqual(lot.hammerStatus, 'OPEN');
  assert.strictEqual(lot.countdown, room.config.timerDuration - 1);
  assert.strictEqual(room.franchises.MI.squad.length, 0, 'sold early');
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
