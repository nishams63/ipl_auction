// Two-client multiplayer regression tests against a real server process.
import assert from 'node:assert';
import {
  startServer, connect, emit, waitFor, createRoom, makeRunner, strongToken, sleep
} from './helpers/harness.js';

const t = makeRunner('Multiplayer Regression Suite (2 clients)');
const srv = await startServer();
const sockets = [];
const open = async () => { const s = await connect(srv.url); sockets.push(s); return s; };

try {
  const H = strongToken('mh'); const A = strongToken('ma');
  // Default config on purpose: verifies the approved 20s timer / 15–25 squad
  const { body } = await createRoom(srv.url, { hostName: 'Host', hostToken: H });
  const code = body.roomCode;
  const host = await open();
  let alice = await open();
  await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' });

  const hl = waitFor(host, 'lot_presented'); const al = waitFor(alice, 'lot_presented');
  assert.ok((await emit(host, 'start_auction', { roomCode: code })).success);
  const [hLot, aLot] = await Promise.all([hl, al]);

  await t.it('M1: both clients see the same lot, catalogue order and the 15s default timer', () => {
    assert.strictEqual(hLot.currentLot.player.id, aLot.currentLot.player.id);
    assert.deepStrictEqual(hLot.playersCatalog.map(p => p.id), aLot.playersCatalog.map(p => p.id));
    assert.strictEqual(aLot.currentLot.countdown, 15);
    assert.strictEqual(aLot.config.minSquadSize, 15);
    assert.strictEqual(aLot.config.maxSquadSize, 25);
  });

  let lot = aLot.currentLot;
  await t.it('M2: an accepted bid reaches both clients identically and resets the timer to 15s', async () => {
    const hb = waitFor(host, 'bid_accepted'); const ab = waitFor(alice, 'bid_accepted');
    await sleep(1100); // let the clock tick down first
    const r = await emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
    assert.ok(r.success, r.error);
    const [h, a] = await Promise.all([hb, ab]);
    assert.strictEqual(h.currentLot.highestBidderFranchiseId, 'MI');
    assert.strictEqual(a.currentLot.highestBid, h.currentLot.highestBid);
    assert.strictEqual(a.currentLot.countdown, 15);
    lot = a.currentLot;
  });

  await t.it('M3: a duplicate bid (same stateVersion) is rejected, no double bid recorded', async () => {
    const r1 = await emit(host, 'place_bid', { roomCode: code, franchiseId: 'CSK', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
    const r2 = await emit(host, 'place_bid', { roomCode: code, franchiseId: 'CSK', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
    assert.ok(r1.success, r1.error);
    assert.strictEqual(r2.success, false);
    const pub = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    assert.strictEqual(pub.currentLot.bidHistory.length, 2);
    lot = pub.currentLot;
  });

  await t.it('M4: reconnecting client gets the same lot/bid/bidder/queue and keeps receiving live events', async () => {
    alice.close();
    alice = await open();
    const j = await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
    assert.ok(j.success, j.error);
    assert.strictEqual(j.participant.franchiseId, 'MI');
    assert.strictEqual(j.room.currentLot.player.id, lot.player.id);
    assert.strictEqual(j.room.currentLot.highestBid, lot.highestBid);
    assert.strictEqual(j.room.currentLot.highestBidderFranchiseId, 'CSK');
    assert.deepStrictEqual(j.room.playersCatalog.map(p => p.id), hLot.playersCatalog.map(p => p.id));
    // Still subscribed to the room channel after reconnect
    const ab = waitFor(alice, 'bid_accepted');
    const r = await emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: j.room.currentLot.nextValidBid, expectedVersion: j.room.currentLot.stateVersion });
    assert.ok(r.success, r.error);
    lot = (await ab).currentLot;
  });

  await t.it('M5: both clients receive the same SOLD result and purse update', async () => {
    const hc = waitFor(host, 'lot_completed'); const ac = waitFor(alice, 'lot_completed');
    assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success);
    const [h, a] = await Promise.all([hc, ac]);
    assert.strictEqual(h.result, 'SOLD');
    assert.strictEqual(a.result, 'SOLD');
    assert.strictEqual(a.historyEntry.winningFranchiseId, 'MI');
    assert.strictEqual(a.franchises.MI.remainingPurse, h.franchises.MI.remainingPurse);
    assert.strictEqual(a.franchises.MI.remainingPurse, 120 - lot.highestBid);
  });

  await t.it('M6: host advance during the post-sale gap moves both clients to the next player once', async () => {
    const soldId = lot.player.id;
    const hl2 = waitFor(host, 'lot_presented'); const al2 = waitFor(alice, 'lot_presented');
    assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success);
    const [h, a] = await Promise.all([hl2, al2]);
    assert.notStrictEqual(a.currentLot.player.id, soldId);
    assert.strictEqual(a.currentLot.player.id, h.currentLot.player.id);
    assert.strictEqual(a.franchises.MI.squad.length, 1);
    assert.strictEqual(a.playersCatalog.find(p => p.id === soldId).status, 'sold');
  });

  await t.it('M7: a new participant cannot join once the auction is running', async () => {
    const late = await open();
    const r = await emit(late, 'join_room', { roomCode: code, participantName: 'Late', participantToken: strongToken('late') });
    assert.strictEqual(r.success, false);
  });

  await t.it('M8: network interruption → client auto-reconnects (new socket id), rejoins, state intact, live again', async () => {
    // Behave like the app: reconnection on, rejoin on every 'connect' (App.jsx)
    const net = await connect(srv.url, { reconnection: true });
    let lastRejoin = null;
    net.on('connect', async () => {
      lastRejoin = await emit(net, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
    });
    const first = await emit(net, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
    assert.ok(first.success);
    const oldId = net.id;
    const before = (await (await fetch(`${srv.url}/api/rooms/${code}`)).json()).currentLot;

    net.io.engine.close(); // drop the transport, as a flaky network would
    const deadline = Date.now() + 5000;
    while ((!lastRejoin || net.id === oldId) && Date.now() < deadline) await sleep(50);
    assert.ok(lastRejoin?.success, 'did not rejoin after reconnect');
    assert.notStrictEqual(net.id, oldId, 'socket id should change after reconnect');
    assert.strictEqual(lastRejoin.participant.franchiseId, 'MI');
    assert.strictEqual(lastRejoin.room.currentLot.player.id, before.player.id);
    assert.strictEqual(lastRejoin.room.currentLot.stateVersion, before.stateVersion);

    // Receives live events again and can bid
    const got = waitFor(net, 'bid_accepted');
    const r = await emit(host, 'place_bid', { roomCode: code, franchiseId: 'CSK', bidAmount: before.nextValidBid, expectedVersion: before.stateVersion });
    assert.ok(r.success, r.error);
    const ev = await got;
    const mine = await emit(net, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: ev.currentLot.nextValidBid, expectedVersion: ev.currentLot.stateVersion });
    assert.ok(mine.success, mine.error);
  });
} finally {
  await srv.stop();
}

const failed = await t.finish();
process.exit(failed ? 1 : 0);
