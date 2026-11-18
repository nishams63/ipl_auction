// Stage 0.5 security regression tests.
// Covers the three confirmed vulnerabilities from docs/PROJECT_UPGRADE_AUDIT.md §6
// plus lot-lifecycle validation gaps found while fixing them.
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  startServer, connect, emit, waitFor, createRoom, makeRunner, strongToken, sleep, tempStorageFile,
  trackManager, mockIo as makeMockIo
} from './helpers/harness.js';

process.env.ROOM_STORAGE_FILE = process.env.ROOM_STORAGE_FILE || tempStorageFile('security-unit');
const { RoomManager } = await import('../server/roomManager.js');
const { validateBid, calculateNextBid, DEFAULT_CONFIG } = await import('../server/auctionEngine.js');

const t = makeRunner('Stage 0.5 Security Regression Suite');
const mockIo = makeMockIo();

const containsSecret = (payload, secrets) => {
  const s = JSON.stringify(payload);
  return secrets.filter(sec => s.includes(sec));
};

// ─────────────────────────────────────────────────────────────
// Part 1: real server, real sockets
// ─────────────────────────────────────────────────────────────
const srv = await startServer();
const HOST = strongToken('host');
const ALICE = strongToken('alice');
const sockets = [];
const open = async () => { const s = await connect(srv.url); sockets.push(s); return s; };

try {
  const { body } = await createRoom(srv.url, { hostName: 'Host', hostToken: HOST, config: { minParticipants: 2 } });
  const code = body.roomCode;
  assert.ok(code, 'room created');

  const host = await open();
  const alice = await open();
  const aliceBroadcasts = [];
  for (const ev of ['state_updated', 'lot_presented', 'bid_accepted', 'lot_completed', 'timer_tick']) {
    alice.on(ev, d => aliceBroadcasts.push({ ev, d }));
  }

  await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: HOST });
  await emit(host, 'select_franchise', { roomCode: code, participantToken: HOST, franchiseId: 'CSK' });
  const aliceJoin = await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: ALICE });
  await emit(alice, 'select_franchise', { roomCode: code, participantToken: ALICE, franchiseId: 'MI' });

  await t.it('V1: GET /api/rooms/:code exposes no participant or host token', async () => {
    const pub = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    assert.deepStrictEqual(containsSecret(pub, [HOST, ALICE]), []);
    for (const f of Object.values(pub.franchises)) {
      assert.ok(!('ownerToken' in f), `${f.id} has ownerToken`);
      assert.ok(!('ownerSocketId' in f), `${f.id} has ownerSocketId`);
    }
    assert.ok(!('hostToken' in pub));
  });

  await t.it('V1: join ack gives a public id that maps to my franchise without any token', async () => {
    assert.ok(aliceJoin.success);
    assert.ok(aliceJoin.participant.publicId, 'publicId present');
    assert.ok(!('token' in aliceJoin.participant), 'join ack echoes a token');
    assert.ok(!JSON.stringify(aliceJoin).includes(ALICE), 'join ack contains own token');
    const pub = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    assert.strictEqual(pub.franchises.MI.ownerId, aliceJoin.participant.publicId);
  });

  await t.it('V2: outsider socket that never joined cannot use the REAL host token', async () => {
    const outsider = await open();
    const res = await emit(outsider, 'start_auction', { roomCode: code, hostToken: HOST });
    assert.strictEqual(res.success, false, 'start_auction must be rejected');
    const pub = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    assert.strictEqual(pub.status, 'lobby');
  });

  await t.it('V2: joined non-host cannot run host actions, even quoting the host token', async () => {
    for (const ev of ['start_auction', 'update_config']) {
      const res = await emit(alice, ev, { roomCode: code, hostToken: HOST, config: { basePurse: 999 } });
      assert.strictEqual(res?.success, false, `${ev} accepted from non-host`);
    }
    const pub = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    assert.strictEqual(pub.status, 'lobby');
    assert.notStrictEqual(pub.config.basePurse, 999);
  });

  await t.it('V2: weak / malformed tokens and names are rejected', async () => {
    const s = await open();
    for (const bad of ['abc', '', null, 12345, { $gt: '' }, 'x'.repeat(500), 'has spaces in it!!!!']) {
      const res = await emit(s, 'join_room', { roomCode: code, participantName: 'Eve', participantToken: bad });
      assert.strictEqual(res.success, false, `token ${JSON.stringify(bad)} accepted`);
    }
    const r = await createRoom(srv.url, { hostName: 'Eve', hostToken: 'short' });
    assert.strictEqual(r.status, 400, 'weak hostToken accepted at room creation');
    const res = await emit(s, 'join_room', { roomCode: code, participantName: 'x'.repeat(200), participantToken: strongToken('eve') });
    assert.strictEqual(res.success, false, 'over-long name accepted');
  });

  await t.it('V2: malformed payloads get an error ack and never crash the server', async () => {
    const s = await open();
    const junk = [
      ['join_room', { roomCode: 123, participantName: 'x', participantToken: strongToken('j') }],
      ['join_room', { roomCode: { $ne: 1 }, participantName: 'x', participantToken: strongToken('j') }],
      ['join_room', null],
      ['join_room', ['a', 'b']],
      ['place_bid', { roomCode: 42, franchiseId: 'MI' }],
      ['select_franchise', 'not-an-object'],
      ['update_config', { roomCode: code, config: 'x' }]
    ];
    for (const [ev, p] of junk) {
      const res = await emit(s, ev, p);
      assert.strictEqual(res?.success, false, `${ev} ${JSON.stringify(p)} not rejected`);
    }
    const health = await fetch(`${srv.url}/api/health`);
    assert.ok(health.ok, 'server died');
  });

  // Start auction legitimately
  const lotP = waitFor(alice, 'lot_presented');
  const startRes = await emit(host, 'start_auction', { roomCode: code, hostToken: HOST });
  assert.ok(startRes.success, 'host start');
  const lot1 = await lotP;

  await t.it('V2: outsider with only the room code cannot join, bid or control an active auction', async () => {
    const outsider = await open();
    const fresh = strongToken('outsider');
    const j = await emit(outsider, 'join_room', { roomCode: code, participantName: 'Mallory', participantToken: fresh });
    assert.strictEqual(j.success, false, 'late join accepted');
    const attempts = [
      ['place_bid', { roomCode: code, franchiseId: 'MI' }],
      ['place_bid', { roomCode: code, participantToken: fresh, franchiseId: 'MI' }],
      ['pause_auction', { roomCode: code, hostToken: '' }],
      ['advance_lot', { roomCode: code }],
      ['skip_set', { roomCode: code }],
      ['finish_auction', { roomCode: code }],
      ['update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [] }]
    ];
    for (const [ev, p] of attempts) {
      const res = await emit(outsider, ev, p);
      assert.strictEqual(res?.success, false, `${ev} accepted from outsider`);
    }
    const pub = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    assert.strictEqual(pub.status, 'active');
    assert.strictEqual(pub.currentLot.highestBid, 0);
  });

  await t.it('V2: participant cannot bid for another franchise', async () => {
    const res = await emit(alice, 'place_bid', { roomCode: code, participantToken: ALICE, franchiseId: 'CSK', bidAmount: lot1.currentLot.nextValidBid, expectedVersion: lot1.currentLot.stateVersion });
    assert.strictEqual(res.success, false);
  });

  await t.it('V1: live broadcasts (state/lot/bid/tick) never carry any token', async () => {
    const bidP = waitFor(alice, 'bid_accepted');
    const r = await emit(host, 'place_bid', { roomCode: code, participantToken: HOST, franchiseId: 'CSK', bidAmount: lot1.currentLot.nextValidBid, expectedVersion: lot1.currentLot.stateVersion });
    assert.ok(r.success, 'host bid ok: ' + r.error);
    await bidP;
    await sleep(1200); // capture at least one timer_tick
    assert.ok(aliceBroadcasts.length >= 3, 'captured broadcasts');
    for (const { ev, d } of aliceBroadcasts) {
      assert.deepStrictEqual(containsSecret(d, [HOST, ALICE]), [], `token found in ${ev}`);
    }
  });

  await t.it('V2: a newer session for the same token revokes the older socket', async () => {
    const replacedP = waitFor(alice, 'session_replaced', () => true, 3000);
    const alice2 = await open();
    const j = await emit(alice2, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: ALICE });
    assert.ok(j.success, 'reconnect with own token succeeds');
    await replacedP;
    const pub = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    const stale = await emit(alice, 'place_bid', { roomCode: code, participantToken: ALICE, franchiseId: 'MI', bidAmount: pub.currentLot.nextValidBid, expectedVersion: pub.currentLot.stateVersion });
    assert.strictEqual(stale.success, false, 'old socket could still bid');
    const fresh = await emit(alice2, 'place_bid', { roomCode: code, participantToken: ALICE, franchiseId: 'MI', bidAmount: pub.currentLot.nextValidBid, expectedVersion: pub.currentLot.stateVersion });
    assert.ok(fresh.success, 'new socket bid rejected: ' + fresh.error);
  });

  // Separate room for purse bypass over the wire
  await t.it('V3: omitting bidAmount does not bypass the purse check (socket)', async () => {
    // Purse and squad limits are fixed IPL rules (Stage 2), so the low-purse situation is
    // prepared in a save file: MI has ₹4.30 Cr left and needs 15 players (14 more after this
    // one at ≥ ₹0.30 Cr each = ₹4.20 Cr), so any opening bid above ₹0.10 Cr must be refused.
    const H2 = strongToken('h2'); const A2 = strongToken('a2');
    const file = tempStorageFile('v3');
    const prep = new RoomManager({ to: () => ({ emit: () => {} }), emit: () => {}, sockets: { sockets: new Map() } }, { storageFile: file });
    const r = prep.createRoom({ hostName: 'H2', hostToken: H2, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30 } });
    prep.joinRoom({ roomCode: r.roomCode, participantName: 'H2', participantToken: H2, socketId: 'p1' });
    prep.joinRoom({ roomCode: r.roomCode, participantName: 'A2', participantToken: A2, socketId: 'p2' });
    prep.selectFranchise({ roomCode: r.roomCode, participantToken: H2, franchiseId: 'CSK' });
    prep.selectFranchise({ roomCode: r.roomCode, participantToken: A2, franchiseId: 'MI' });
    prep.startAuction({ roomCode: r.roomCode, hostToken: H2 });
    r.franchises.MI.remainingPurse = 4.3;
    prep.flushStorage(); prep.shutdown();
    const s2 = await startServer({ storageFile: file });
    try {
      const h = await connect(s2.url); const a = await connect(s2.url);
      assert.ok((await emit(h, 'join_room', { roomCode: r.roomCode, participantName: 'H2', participantToken: H2 })).success);
      assert.ok((await emit(a, 'join_room', { roomCode: r.roomCode, participantName: 'A2', participantToken: A2 })).success);
      assert.ok((await emit(h, 'resume_auction', { roomCode: r.roomCode })).success);
      const lot = (await (await fetch(`${s2.url}/api/rooms/${r.roomCode}`)).json()).currentLot;
      assert.ok(lot.player.basePrice >= 0.3);
      const res = await emit(a, 'place_bid', { roomCode: r.roomCode, franchiseId: 'MI', expectedVersion: lot.stateVersion });
      assert.strictEqual(res.success, false, 'unaffordable bid accepted when bidAmount omitted');
      assert.match(res.error, /reserve|Feasibility|purse/i);
    } finally {
      await s2.stop();
    }
  });
} finally {
  sockets.forEach(s => s.close());
  await srv.stop();
}

// ─────────────────────────────────────────────────────────────
// Part 2: engine-level validation (server is the only authority)
// ─────────────────────────────────────────────────────────────
const baseLotRoom = (purse, extra = {}) => ({
  status: 'active',
  config: { ...DEFAULT_CONFIG, minSquadSize: 1 },
  franchises: { MI: { id: 'MI', isClaimed: true, squad: [], overseasCount: 0, remainingPurse: purse, ...extra } },
  currentLot: { player: { basePrice: 2, isOverseas: false }, highestBid: 0, highestBidderFranchiseId: null, stateVersion: 1, hammerStatus: 'OPEN' }
});

await t.it('V3: validateBid uses the server amount when bidAmount is omitted', () => {
  const r = validateBid({ room: baseLotRoom(0.5), franchiseId: 'MI', expectedVersion: 1 });
  assert.strictEqual(r.valid, false);
});

await t.it('V3: validateBid rejects non-numeric / non-finite bidAmount', () => {
  for (const bad of ['2', NaN, Infinity, {}, [2], true]) {
    const r = validateBid({ room: baseLotRoom(100), franchiseId: 'MI', bidAmount: bad, expectedVersion: 1 });
    assert.strictEqual(r.valid, false, `accepted ${String(bad)}`);
  }
});

await t.it('V3: eliminated or unclaimed franchises cannot bid', () => {
  assert.strictEqual(validateBid({ room: baseLotRoom(100, { isEliminated: true }), franchiseId: 'MI', bidAmount: 2, expectedVersion: 1 }).valid, false);
  assert.strictEqual(validateBid({ room: baseLotRoom(100, { isClaimed: false }), franchiseId: 'MI', bidAmount: 2, expectedVersion: 1 }).valid, false);
});

await t.it('V3: all eight specified increment examples still hold', () => {
  const ex = [[1, 1.25], [4.75, 5], [5, 5.25], [9.75, 10], [10, 10.5], [14.5, 15], [15, 16], [20, 21]];
  for (const [a, b] of ex) assert.strictEqual(calculateNextBid(a), b, `${a} → ${calculateNextBid(a)}`);
});

// Lot lifecycle (RoomManager with mocked io)
function setupRoom(rm, cfg = {}) {
  const H = strongToken('uh'); const A = strongToken('ua');
  const room = rm.createRoom({ hostName: 'H', hostToken: H, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30, ...cfg } });
  rm.joinRoom({ roomCode: room.roomCode, participantName: 'H', participantToken: H, socketId: 's1' });
  rm.joinRoom({ roomCode: room.roomCode, participantName: 'A', participantToken: A, socketId: 's2' });
  rm.selectFranchise({ roomCode: room.roomCode, participantToken: H, franchiseId: 'CSK' });
  rm.selectFranchise({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI' });
  assert.ok(rm.startAuction({ roomCode: room.roomCode, hostToken: H }).success);
  return { room, H, A };
}
const sellToCSK = (rm, room, H) => {
  const lot = room.currentLot;
  assert.ok(rm.placeBid({ roomCode: room.roomCode, participantToken: H, franchiseId: 'CSK', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion }).success);
  rm.closeCurrentLot(room); // simulate timer expiry → SOLD, 4s+ gap before next lot
};

const rm = trackManager(new RoomManager(mockIo));

await t.it('V3: bids are rejected after the hammer falls (gap before next lot)', () => {
  const { room, H, A } = setupRoom(rm);
  sellToCSK(rm, room, H);
  const lot = room.currentLot;
  const r = rm.placeBid({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI', bidAmount: calculateNextBid(lot.highestBid), expectedVersion: lot.stateVersion });
  assert.strictEqual(r.success, false, 'bid on a SOLD lot accepted');
});

await t.it('V3: host "advance" during the gap never sells the same player twice', () => {
  const { room, H } = setupRoom(rm);
  const firstId = room.currentLot.player.id;
  sellToCSK(rm, room, H);
  const purseAfterSale = room.franchises.CSK.remainingPurse;
  rm.skipOrAdvanceLot({ roomCode: room.roomCode, hostToken: H });
  assert.strictEqual(room.franchises.CSK.squad.filter(p => p.id === firstId).length, 1, 'duplicate squad entry');
  assert.strictEqual(room.franchises.CSK.remainingPurse, purseAfterSale, 'purse deducted twice');
  assert.strictEqual(room.history.filter(h => h.player.id === firstId).length, 1, 'duplicate history entry');
});

await t.it('V3: a second start_auction cannot skip the live player', () => {
  const { room, H } = setupRoom(rm);
  const before = room.currentLot.player.id;
  const r = rm.startAuction({ roomCode: room.roomCode, hostToken: H });
  assert.strictEqual(r.success, false, 'restart accepted');
  assert.strictEqual(room.currentLot.player.id, before);
});

await t.it('V3: pause during the gap then resume moves on cleanly (no stuck or double sale)', () => {
  const { room, H } = setupRoom(rm);
  const firstId = room.currentLot.player.id;
  sellToCSK(rm, room, H);
  assert.ok(rm.pauseAuction({ roomCode: room.roomCode, hostToken: H }).success || room.status === 'paused');
  assert.ok(rm.resumeAuction({ roomCode: room.roomCode, hostToken: H }).success);
  assert.notStrictEqual(room.currentLot.player.id, firstId, 'still stuck on sold player');
  assert.strictEqual(room.currentLot.hammerStatus, 'OPEN');
  assert.strictEqual(room.franchises.CSK.squad.length, 1);
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
