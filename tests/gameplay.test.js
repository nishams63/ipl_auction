// Stage 2 — auction engine gameplay rules (JSON storage; real server processes for multiplayer).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeRunner, trackManager, mockIo, tempStorageFile, strongToken, sleep, startServer, connect, emit, createRoom, waitFor, assertRejected } from './helpers/harness.js';
import { lobbyRoom, liveRoom, bid } from './helpers/auctionRooms.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { RoomManager, shuffleWithinSets } = await import('../server/roomManager.js');
const { calculateNextBid, validateBid, reserveFloorLakh } = await import('../server/auctionEngine.js');
const { toLakh, fromLakh, nextBidLakh } = await import('../server/money.js');
const { IPL_FRANCHISES } = await import('../server/data/franchises.js');

const t = makeRunner('Stage 2 Gameplay Suite (auction rules, order, timer, resolution, multiplayer)');
const make = file => trackManager(new RoomManager(mockIo(), { storageFile: file || tempStorageFile('gp') }));
const CATALOGUE = path.join(dir, '..', 'server', 'data', 'players.json');
const catalogueMd5 = () => crypto.createHash('md5').update(fs.readFileSync(CATALOGUE)).digest('hex');
const CATALOGUE_MD5 = catalogueMd5();
const twoDecimals = v => /^\d+(\.\d{1,2})?$/.test(String(v));

await t.it('G1: bid ladder — the 8 approved examples, and every step from every base price up to ₹30 Cr is exact', () => {
  const examples = [[1, 1.25], [4.75, 5], [5, 5.25], [9.75, 10], [10, 10.5], [14.5, 15], [15, 16], [20, 21]];
  for (const [from, to] of examples) assert.strictEqual(calculateNextBid(from, 2), to, `${from} → ${calculateNextBid(from, 2)} (expected ${to})`);
  for (const base of [0.3, 0.4, 0.5, 0.75, 1, 1.5, 2]) {
    assert.strictEqual(calculateNextBid(0, base), base, 'first bid must be the base price');
    let cur = base; let steps = 0;
    while (cur < 30) {
      const next = calculateNextBid(cur, base);
      const inc = toLakh(next) - toLakh(cur);
      const expected = cur < 10 ? 25 : cur < 15 ? 50 : 100;
      assert.strictEqual(inc, expected, `base ${base}: ${cur} → ${next}`);
      assert.ok(twoDecimals(next), `float artefact: ${next}`);
      assert.strictEqual(next, fromLakh(toLakh(next)));
      cur = next; steps++;
    }
    assert.ok(steps > 30);
  }
  assert.strictEqual(nextBidLakh(0, 30), 30);
  assert.strictEqual(nextBidLakh(1000, 30), 1050);
});

await t.it('G2: purse arithmetic is exact over a whole auction — remaining + spent reconciles to the lakh, no float artefacts after any sale', () => {
  const rm = make();
  const { room, H, A } = liveRoom(rm);
  // start from awkward (but whole-lakh) purses so float subtraction would show artefacts
  room.franchises.MI.remainingPurse = 116.45; room.franchises.MI.initialPurse = 116.45;
  room.franchises.CSK.remainingPurse = 117.35; room.franchises.CSK.initialPurse = 117.35;
  const startLakh = { MI: 11645, CSK: 11735 };
  let n = 0;
  while (room.status === 'active' && n < 60) {
    const fid = n % 2 ? 'CSK' : 'MI'; const tok = n % 2 ? H : A;
    const v = validateBid({ room, franchiseId: fid, expectedVersion: room.currentLot.stateVersion });
    if (v.valid) {
      bid(rm, room, tok, fid);
      // raise a few times to reach odd amounts
      for (let k = 0; k < (n % 5); k++) {
        const other = fid === 'MI' ? 'CSK' : 'MI';
        const ok = validateBid({ room, franchiseId: k % 2 ? fid : other, expectedVersion: room.currentLot.stateVersion });
        if (!ok.valid) break;
        bid(rm, room, k % 2 ? tok : (tok === H ? A : H), k % 2 ? fid : other);
      }
    }
    rm.closeCurrentLot(room);
    for (const f of ['CSK', 'MI']) assert.ok(twoDecimals(room.franchises[f].remainingPurse), `lot ${n}: ${f} purse ${room.franchises[f].remainingPurse}`);
    rm.nextPlayer(room); n++;
  }
  for (const fid of ['CSK', 'MI']) {
    const f = room.franchises[fid];
    const spent = f.squad.reduce((s, p) => s + toLakh(p.boughtPrice), 0);
    assert.strictEqual(toLakh(f.remainingPurse) + spent, startLakh[fid], `${fid}: purse does not reconcile`);
    assert.strictEqual(toLakh(f.totalSpent), spent);
    assert.ok(twoDecimals(f.remainingPurse) && twoDecimals(f.totalSpent), `${fid}: ${f.remainingPurse} / ${f.totalSpent}`);
    assert.ok(f.remainingPurse >= 0);
  }
  assert.ok(room.franchises.CSK.squad.length + room.franchises.MI.squad.length > 10, 'test bought too little to be meaningful');

  // Deterministic: sell cheap ₹0.30/₹0.40 players from an awkward purse (float subtraction of
  // these gives e.g. 115.60000000000001)
  const rm2 = make();
  const r2 = liveRoom(rm2);
  const room2 = r2.room;
  room2.franchises.MI.remainingPurse = 116.45;
  let cheapSales = 0;
  for (let guard = 0; guard < 400 && cheapSales < 6 && room2.status === 'active'; guard++) {
    if (room2.currentLot.player.basePrice < 0.5) {
      bid(rm2, room2, r2.A, 'MI');
      rm2.closeCurrentLot(room2);
      cheapSales++;
      assert.ok(twoDecimals(room2.franchises.MI.remainingPurse), `float artefact: ${room2.franchises.MI.remainingPurse}`);
    } else {
      rm2.closeCurrentLot(room2);
    }
    rm2.nextPlayer(room2);
  }
  assert.strictEqual(cheapSales, 6, 'catalogue did not offer six cheap lots');
});

// A minimal open-lot room for direct rule probes (validateBid is the server authority)
function probeRoom({ squad = [], purse = 120, player = { id: 'X', basePrice: 0.5, category: 'BAT', isOverseas: false }, overseas = 0 } = {}) {
  const catalog = JSON.parse(fs.readFileSync(CATALOGUE, 'utf-8'));
  return {
    status: 'active',
    config: { minSquadSize: 15, maxSquadSize: 25, maxOverseas: 8, minWKs: 1, minPlayerPrice: 0.2 },
    playersCatalog: catalog,
    franchises: { MI: { id: 'MI', isClaimed: true, isEliminated: false, squad, remainingPurse: purse, overseasCount: overseas } },
    currentLot: { player, highestBid: 0, highestBidderFranchiseId: null, stateVersion: 1, hammerStatus: 'OPEN' }
  };
}
const filler = (n, cat = 'BAT') => Array.from({ length: n }, (_, i) => ({ id: `F${i}`, category: cat, isOverseas: false }));

await t.it('G3: squad limits — max 25, max 8 overseas, and the last slot is kept for a wicketkeeper', () => {
  let r = validateBid({ room: probeRoom({ squad: filler(25) }), franchiseId: 'MI' });
  assert.ok(!r.valid && /Squad limit reached!/.test(r.error), r.error);
  r = validateBid({ room: probeRoom({ squad: filler(10), overseas: 8, player: { id: 'O', basePrice: 1, category: 'BAT', isOverseas: true } }), franchiseId: 'MI' });
  assert.ok(!r.valid && /Overseas/.test(r.error), r.error);
  // 24 players, none a keeper: a non-keeper would fill the squad without a WK
  r = validateBid({ room: probeRoom({ squad: filler(24) }), franchiseId: 'MI' });
  assert.ok(!r.valid && /wicketkeeper/.test(r.error), `non-keeper accepted into the last slot: ${r.error}`);
  r = validateBid({ room: probeRoom({ squad: filler(24), player: { id: 'W', basePrice: 0.5, category: 'WK', isOverseas: false } }), franchiseId: 'MI' });
  assert.ok(r.valid, `keeper refused for the last slot: ${r.error}`);
  r = validateBid({ room: probeRoom({ squad: [...filler(23), { id: 'K', category: 'WK' }] }), franchiseId: 'MI' });
  assert.ok(r.valid, `squad with a keeper refused: ${r.error}`);
  r = validateBid({ room: probeRoom({ squad: filler(23) }), franchiseId: 'MI' });
  assert.ok(r.valid, 'two slots left: a non-keeper must still be allowed');
});

await t.it('G4: purse — never negative, and the squad-completion reserve uses the real cheapest price (₹0.30 Cr), not ₹0.20', () => {
  assert.strictEqual(reserveFloorLakh(probeRoom()), 30);
  let r = validateBid({ room: probeRoom({ purse: 0.4, player: { id: 'X', basePrice: 0.5, category: 'BAT' } , squad: filler(14) }), franchiseId: 'MI' });
  assert.ok(!r.valid && /Insufficient purse/.test(r.error));
  // 10 players, ₹2.00 left, ₹0.50 bid → ₹1.50 for 4 more slots: enough at ₹0.20 (0.80) but also at ₹0.30 (1.20) → OK
  r = validateBid({ room: probeRoom({ purse: 2.0, squad: filler(10) }), franchiseId: 'MI' });
  assert.ok(r.valid, r.error);
  // ₹1.50 left → ₹1.00 for 4 slots: passes the old ₹0.20 floor (0.80) but cannot buy 4 players at ₹0.30 (1.20)
  r = validateBid({ room: probeRoom({ purse: 1.5, squad: filler(10) }), franchiseId: 'MI' });
  assert.ok(!r.valid && /reserve at least ₹1.20/.test(r.error), r.error);
  // custom / imprecise amounts are refused; the exact amount is accepted
  r = validateBid({ room: probeRoom(), franchiseId: 'MI', bidAmount: 0.5000001 });
  assert.ok(!r.valid);
  r = validateBid({ room: probeRoom(), franchiseId: 'MI', bidAmount: 0.75 });
  assert.ok(!r.valid && /Custom bids/.test(r.error));
  r = validateBid({ room: probeRoom(), franchiseId: 'MI', bidAmount: 0.5 });
  assert.ok(r.valid);
});

await t.it('G5: auction order — shuffled within each set once at start, set order kept, renumbered, persisted; catalogue file untouched', () => {
  const file = tempStorageFile('order');
  const rm = make(file);
  const original = JSON.parse(fs.readFileSync(CATALOGUE, 'utf-8'));
  const { code, H } = liveRoom(rm);
  const room = rm.getRoom(code);
  const order = room.playersCatalog.map(p => p.id);
  assert.strictEqual(new Set(order).size, original.length, 'duplicate or missing players');
  assert.deepStrictEqual(room.playersCatalog.map(p => p.categorySet), original.map(p => p.categorySet), 'set order changed');
  assert.notDeepStrictEqual(order, original.map(p => p.id), 'order was not shuffled');
  const bySet = new Map();
  room.playersCatalog.forEach((p, i) => {
    assert.strictEqual(p.overallLot, i + 1);
    bySet.set(p.categorySet, (bySet.get(p.categorySet) || 0) + 1);
    assert.strictEqual(p.lotInSet, bySet.get(p.categorySet));
  });
  assert.ok(room.auctionOrder?.locked && room.auditLog.some(e => e.type === 'AUCTION_ORDER_LOCKED'));
  assert.strictEqual(room.currentLot.player.id, order[0]);
  // locked: a second start is refused and changes nothing; restart restores the same order
  assert.strictEqual(rm.startAuction({ roomCode: code, hostToken: H }).success, false);
  assert.deepStrictEqual(room.playersCatalog.map(p => p.id), order);
  rm.flushStorage(); rm.shutdown();
  const rm2 = make(file);
  assert.deepStrictEqual(rm2.getRoom(code).playersCatalog.map(p => p.id), order, 'order regenerated on restart');
  assert.strictEqual(catalogueMd5(), CATALOGUE_MD5, 'catalogue file modified');
  // independent rooms get independent orders; a lobby room is not shuffled yet
  const other = liveRoom(rm2);
  assert.notDeepStrictEqual(rm2.getRoom(other.code).playersCatalog.map(p => p.id), order);
  const lobby = lobbyRoom(rm2);
  assert.deepStrictEqual(rm2.getRoom(lobby.code).playersCatalog.map(p => p.id), original.map(p => p.id));
  // deterministic check of the algorithm with an injected generator
  const sample = [{ id: 'a', categorySet: 'S1' }, { id: 'b', categorySet: 'S1' }, { id: 'c', categorySet: 'S1' }, { id: 'd', categorySet: 'S2' }];
  shuffleWithinSets(sample, n => n - 1); // always pick the last → identity
  assert.deepStrictEqual(sample.map(p => p.id), ['a', 'b', 'c', 'd']);
  shuffleWithinSets(sample, () => 0); // always pick the first
  assert.deepStrictEqual(sample.map(p => p.id).slice(3), ['d'], 'a player left its set');
});

await t.it('G6: timer — a valid bid resets it, an invalid one does not; expiry resolves the lot exactly once', async () => {
  const rm = make();
  const { room, code, H, A } = liveRoom(rm);
  rm.clearRoomTimer(code);
  for (let i = 0; i < 4; i++) rm.tickRoom(room);
  assert.strictEqual(room.currentLot.countdown, 11);
  const stale = rm.placeBid({ roomCode: code, participantToken: A, franchiseId: 'MI', expectedVersion: 99 });
  assert.strictEqual(stale.success, false);
  const imposter = rm.placeBid({ roomCode: code, participantToken: A, franchiseId: 'CSK', expectedVersion: room.currentLot.stateVersion });
  assert.strictEqual(imposter.success, false);
  assert.strictEqual(room.currentLot.countdown, 11, 'an invalid bid reset the timer');
  bid(rm, room, A, 'MI');
  assert.strictEqual(room.currentLot.countdown, 15, 'a valid bid did not reset the timer');
  rm.clearRoomTimer(code);
  const pid = room.currentLot.player.id;
  for (let i = 0; i < 20; i++) rm.tickRoom(room); // past zero: must close once
  assert.strictEqual(room.currentLot.hammerStatus, 'SOLD');
  assert.strictEqual(room.history.filter(h => h.player.id === pid).length, 1);
  assert.strictEqual(room.franchises.MI.squad.filter(p => p.id === pid).length, 1);
  void H;
});

await t.it('G7: a stale timer callback (its lot was replaced) stops itself and never ticks or sells the new lot', async () => {
  const rm = make();
  const { room, code } = liveRoom(rm);
  const oldLot = room.currentLot;
  // Simulate a leftover interval: replace the lot WITHOUT going through nextPlayer
  room.currentLot = { ...oldLot, player: room.playersCatalog[5], stateVersion: 1, countdown: 15, hammerStatus: 'OPEN', bidHistory: [] };
  const newLot = room.currentLot;
  await sleep(1300);
  assert.strictEqual(newLot.countdown, 15, 'the stale interval ticked the new lot');
  assert.ok(!rm.timerIntervals.has(code), 'the stale interval kept running');
  assert.strictEqual(oldLot.countdown, 15);
});

await t.it('G8: SOLD/UNSOLD resolve once — repeated hammer/advance/finish calls never duplicate a sale or deduct twice; UNSOLD changes no purse', () => {
  const rm = make();
  const { room, code, H, A } = liveRoom(rm);
  bid(rm, room, A, 'MI');
  const pid = room.currentLot.player.id;
  const price = room.currentLot.highestBid;
  rm.closeCurrentLot(room); rm.closeCurrentLot(room);
  assert.strictEqual(rm.placeBid({ roomCode: code, participantToken: H, franchiseId: 'CSK', expectedVersion: room.currentLot.stateVersion }).success, false, 'bid accepted after the hammer');
  assert.strictEqual(room.franchises.MI.remainingPurse, fromLakh(12000 - toLakh(price)));
  assert.strictEqual(room.history.filter(h => h.player.id === pid).length, 1);
  rm.skipOrAdvanceLot({ roomCode: code, hostToken: H }); // presents next
  const unsoldId = room.currentLot.player.id;
  const pursesBefore = JSON.stringify(Object.values(room.franchises).map(f => [f.remainingPurse, f.squad.length]));
  rm.skipOrAdvanceLot({ roomCode: code, hostToken: H }); // closes UNSOLD
  rm.skipOrAdvanceLot({ roomCode: code, hostToken: H }); // presents next
  assert.strictEqual(room.playersCatalog.find(p => p.id === unsoldId).status, 'unsold');
  assert.strictEqual(JSON.stringify(Object.values(room.franchises).map(f => [f.remainingPurse, f.squad.length])), pursesBefore, 'UNSOLD changed a purse or squad');
  assert.strictEqual(room.franchises.MI.squad.filter(p => p.id === pid).length, 1);
  // non-host cannot drive the auction
  for (const call of ['skipOrAdvanceLot', 'pauseAuction', 'skipCurrentSet']) {
    assert.strictEqual(rm[call]({ roomCode: code, hostToken: A }).success, false, `${call} allowed for a non-host`);
  }
});

await t.it('G9: the next lot never starts before the current one is resolved; Skip Set keeps its behaviour (current player skipped, not sold)', () => {
  const rm = make();
  const { room, code, H, A } = liveRoom(rm);
  bid(rm, room, A, 'MI');
  const pid = room.currentLot.player.id;
  rm.nextPlayer(room); // defensive path: resolves the open lot first
  assert.strictEqual(room.playersCatalog.find(p => p.id === pid).status, 'sold');
  assert.ok(room.franchises.MI.squad.some(p => p.id === pid));
  // Skip Set with a live bid: existing behaviour — the current player and the rest of the set are SKIPPED
  bid(rm, room, A, 'MI');
  const skippedId = room.currentLot.player.id;
  const set = room.currentLot.player.categorySet;
  const purse = room.franchises.MI.remainingPurse;
  assert.ok(rm.skipCurrentSet({ roomCode: code, hostToken: H }).success);
  assert.strictEqual(room.playersCatalog.find(p => p.id === skippedId).status, 'SKIPPED');
  assert.strictEqual(room.franchises.MI.remainingPurse, purse, 'skip set sold the skipped player');
  assert.notStrictEqual(room.currentLot.player.categorySet, set, 'still in the skipped set');
  assert.ok(room.playersCatalog.filter(p => p.categorySet === set).every(p => ['sold', 'unsold', 'SKIPPED'].includes(p.status)));
  // Defensive: an index pointing behind already-resolved players (e.g. a damaged save) never re-presents them
  rm.closeCurrentLot(room);
  const cur = room.currentPlayerIndex;
  room.currentPlayerIndex = -1;
  rm.nextPlayer(room);
  assert.strictEqual(room.currentPlayerIndex, cur + 1, 'a resolved player was presented again');
  assert.strictEqual(room.currentLot.player.status, 'in_auction');
});

await t.it('G10: force-finish resolves the open lot (highest bidder buys it) — no player is left "in auction"', () => {
  const rm = make();
  const { room, A } = liveRoom(rm);
  bid(rm, room, A, 'MI');
  const pid = room.currentLot.player.id;
  rm.finishAuction(room);
  assert.strictEqual(room.status, 'completed');
  assert.strictEqual(room.playersCatalog.find(p => p.id === pid).status, 'sold');
  assert.ok(room.franchises.MI.squad.some(p => p.id === pid));
  assert.ok(!room.playersCatalog.some(p => p.status === 'in_auction'));
});

await t.it('G11: a complete 409-lot auction with skips — every player resolved exactly once, squads disjoint, sale records match squads, purses reconcile', () => {
  const rm = make();
  const { room, code, H, A } = liveRoom(rm);
  const seen = new Set(); let lots = 0; let guard = 0;
  while (room.status === 'active' && guard++ < 600) {
    const lot = room.currentLot;
    assert.ok(!seen.has(lot.player.id), `player ${lot.player.id} presented twice`);
    seen.add(lot.player.id); lots++;
    if (lots % 37 === 0) { rm.skipCurrentSet({ roomCode: code, hostToken: H }); continue; }
    const fid = lots % 3 === 0 ? 'CSK' : 'MI';
    if (validateBid({ room, franchiseId: fid, expectedVersion: lot.stateVersion }).valid) bid(rm, room, fid === 'CSK' ? H : A, fid);
    rm.closeCurrentLot(room); rm.nextPlayer(room);
  }
  assert.strictEqual(room.status, 'completed');
  assert.strictEqual(room.playersCatalog.length, 409, 'Catalog length must be 409');
  assert.ok(room.playersCatalog.every(p => ['sold', 'unsold', 'SKIPPED'].includes(p.status)), 'unresolved players remain');
  const ids = room.history.map(h => h.player.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'a player has two results');
  assert.strictEqual(ids.length, room.playersCatalog.length);
  const owner = new Map();
  for (const [fid, f] of Object.entries(room.franchises)) {
    for (const p of f.squad) { assert.ok(!owner.has(p.id), `${p.id} in two squads`); owner.set(p.id, fid); }
    const spent = f.squad.reduce((s, p) => s + toLakh(p.boughtPrice), 0);
    assert.strictEqual(toLakh(f.remainingPurse) + spent, 12000, `${fid} purse`);
    assert.ok(f.squad.length <= 25 && f.squad.filter(p => p.isOverseas).length <= 8);
    if (f.squad.length === 25) assert.ok(f.squad.some(p => p.category === 'WK'), `${fid}: full squad without a keeper`);
  }
  for (const p of room.playersCatalog) {
    if (p.status === 'sold') assert.strictEqual(owner.get(p.id), p.soldTo, `${p.id}: sale record does not match squad`);
    else assert.ok(!owner.has(p.id), `${p.id}: owned but not sold`);
  }
  assert.ok(owner.size > 20);
});

await t.it('G12: franchises are exactly the 10 IPL teams, each at ₹120 Cr; fixed rules cannot be changed by the host', () => {
  assert.deepStrictEqual(IPL_FRANCHISES.map(f => f.id), ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'DC', 'PBKS', 'GT', 'LSG']);
  const rm = make();
  const { room, code, H } = lobbyRoom(rm);
  assert.ok(Object.values(room.franchises).every(f => f.initialPurse === 120 && f.remainingPurse === 120));
  assert.strictEqual(rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { basePurse: 200 } }).success, false);
  assert.strictEqual(rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { maxOverseas: 10 } }).success, false);
  assert.strictEqual(rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { timerDuration: 30 } }).success, false, 'timer must stay fixed at 15s');
});

// ── multiplayer over real sockets ──
const srv = await startServer();
await t.it('G13: three real participants see the same lot and bids in the same order; simultaneous bids resolve to one; identities and host powers are enforced', async () => {
  const tokens = { CSK: strongToken('c'), MI: strongToken('m'), RCB: strongToken('r') };
  const c = await createRoom(srv.url, { hostName: 'Host', hostToken: tokens.CSK, config: { minParticipants: 3, autoAdvanceDelay: 30 } });
  const code = c.body.roomCode;
  const socks = {};
  for (const [fid, tok] of Object.entries(tokens)) {
    socks[fid] = await connect(srv.url);
    assert.ok((await emit(socks[fid], 'join_room', { roomCode: code, participantName: fid, participantToken: tok })).success);
    assert.ok((await emit(socks[fid], 'select_franchise', { roomCode: code, franchiseId: fid })).success);
  }
  const seen = { CSK: [], MI: [], RCB: [] };
  for (const fid of Object.keys(socks)) socks[fid].on('bid_accepted', e => seen[fid].push(`${e.bid.franchiseId}@${e.bid.bidAmount}#${e.bid.stateVersion}`));
  const presented = Object.fromEntries(Object.keys(socks).map(f => [f, waitFor(socks[f], 'lot_presented')]));
  // non-hosts cannot start / advance / skip / pause / finish
  for (const ev of ['start_auction', 'advance_lot', 'skip_set', 'pause_auction', 'finish_auction']) assertRejected(await emit(socks.MI, ev, { roomCode: code }), `${ev} by non-host`);
  assert.ok((await emit(socks.CSK, 'start_auction', { roomCode: code })).success);
  const lots = await Promise.all(Object.values(presented));
  assert.ok(lots.every(l => l.currentLot.player.id === lots[0].currentLot.player.id), 'participants see different players');
  for (let round = 0; round < 6; round++) {
    const st = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    const v = st.currentLot.stateVersion;
    const bidders = ['CSK', 'MI', 'RCB'].filter(f => f !== st.currentLot.highestBidderFranchiseId);
    const res = await Promise.all(bidders.map(f => emit(socks[f], 'place_bid', { roomCode: code, franchiseId: f, expectedVersion: v })));
    assert.strictEqual(res.filter(r => r.success).length, 1, `round ${round}: simultaneous bids not resolved to exactly one`);
  }
  // bidding for another franchise is refused
  const st = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  const other = ['CSK', 'MI', 'RCB'].find(f => f !== st.currentLot.highestBidderFranchiseId && f !== 'RCB');
  assertRejected(await emit(socks.RCB, 'place_bid', { roomCode: code, franchiseId: other, expectedVersion: st.currentLot.stateVersion }), 'bid as another franchise');
  await sleep(200);
  assert.strictEqual(seen.CSK.length, 6);
  assert.deepStrictEqual(seen.MI, seen.CSK, 'MI saw a different bid order');
  assert.deepStrictEqual(seen.RCB, seen.CSK, 'RCB saw a different bid order');
  // a disconnected participant cannot keep bidding; reconnecting restores the same state
  socks.RCB.close();
  const stray = await connect(srv.url);
  assertRejected(await emit(stray, 'place_bid', { roomCode: code, franchiseId: 'RCB', expectedVersion: st.currentLot.stateVersion }), 'bid without a session');
  const back = await connect(srv.url);
  const j = await emit(back, 'join_room', { roomCode: code, participantName: 'RCB', participantToken: tokens.RCB });
  assert.ok(j.success && j.participant.franchiseId === 'RCB');
  assert.strictEqual(j.room.currentLot.player.id, st.currentLot.player.id);
  assert.strictEqual(j.room.currentLot.highestBid, st.currentLot.highestBid);
  assert.deepStrictEqual(j.room.recentBids.map(b => b.bidId), st.recentBids.map(b => b.bidId));
});

await t.it('G14: duplicate and replayed bid events — a resent or replayed bid is never accepted twice and never resets the timer again', async () => {
  const tokens = { CSK: strongToken('dc'), MI: strongToken('dm') };
  const c = await createRoom(srv.url, { hostName: 'Host', hostToken: tokens.CSK, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = c.body.roomCode;
  const s = {};
  for (const [fid, tok] of Object.entries(tokens)) {
    s[fid] = await connect(srv.url);
    assert.ok((await emit(s[fid], 'join_room', { roomCode: code, participantName: fid, participantToken: tok })).success);
    assert.ok((await emit(s[fid], 'select_franchise', { roomCode: code, franchiseId: fid })).success);
  }
  assert.ok((await emit(s.CSK, 'start_auction', { roomCode: code })).success);
  const st = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  const payload = { roomCode: code, franchiseId: 'MI', bidAmount: st.currentLot.nextValidBid, expectedVersion: st.currentLot.stateVersion };
  // the same event fired three times at once (double-click / network retry)
  const res = await Promise.all([emit(s.MI, 'place_bid', payload), emit(s.MI, 'place_bid', payload), emit(s.MI, 'place_bid', payload)]);
  assert.strictEqual(res.filter(r => r.success).length, 1, 'a duplicated bid event was accepted more than once');
  // CSK outbids; replaying MI's original event later is refused (stale version / old amount)
  const st2 = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  assert.ok((await emit(s.CSK, 'place_bid', { roomCode: code, franchiseId: 'CSK', bidAmount: st2.currentLot.nextValidBid, expectedVersion: st2.currentLot.stateVersion })).success);
  await sleep(1100);
  const before = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  assertRejected(await emit(s.MI, 'place_bid', payload), 'replayed bid');
  const after = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  assert.strictEqual(after.recentBids.length, 2);
  assert.strictEqual(after.currentLot.highestBidderFranchiseId, 'CSK');
  assert.ok(after.currentLot.countdown <= before.currentLot.countdown, 'a rejected replay reset the timer');
});

await t.it('G15: rooms saved with old rules (squad 11–15) — lobby rooms are brought to the fixed IPL rules on restore and at start; started auctions keep their rules', () => {
  const file = tempStorageFile('legacyrules');
  const rm = make(file);
  const lobby = lobbyRoom(rm);
  const live = liveRoom(rm);
  rm.flushStorage(); rm.shutdown();
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  for (const code of [lobby.code, live.code]) Object.assign(data[code].config, { minSquadSize: 11, maxSquadSize: 15 }); // the shape found in real save files
  fs.writeFileSync(file, JSON.stringify(data));
  const rm2 = make(file);
  const l2 = rm2.getRoom(lobby.code);
  assert.strictEqual(l2.config.minSquadSize, 15);
  assert.strictEqual(l2.config.maxSquadSize, 15, 'lobby room keeps its chosen maxSquadSize while minSquadSize normalizes to fixed 15');
  assert.ok(l2.auditLog.some(e => e.type === 'RULES_NORMALIZED' && /minSquadSize 11→15/.test(e.message)));
  const a2 = rm2.getRoom(live.code);
  assert.strictEqual(a2.config.minSquadSize, 11, 'a started auction had its rules changed mid-auction');
  assert.strictEqual(a2.config.maxSquadSize, 15);
  // persisted, idempotent
  rm2.flushStorage(); rm2.shutdown();
  const rm3 = make(file);
  assert.strictEqual(rm3.getRoom(lobby.code).auditLog.filter(e => e.type === 'RULES_NORMALIZED').length, 1);
  // a lobby room keeps its customizable maxOverseas & maxSquadSize on start, while fixed rules normalize
  const r3 = rm3.getRoom(lobby.code);
  r3.config.maxOverseas = 6;
  r3.config.timerDuration = 20;
  assert.ok(rm3.startAuction({ roomCode: lobby.code, hostToken: lobby.H }).success);
  assert.strictEqual(r3.config.maxOverseas, 6);
  assert.strictEqual(r3.config.timerDuration, 15);
});

await srv.stop();
process.exit(await t.finish());
