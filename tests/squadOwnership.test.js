// Squad ownership for Playing XI: a franchise may only field players it has PURCHASED.
// Authoritative ownership = franchise.squad on the server (written when a lot is SOLD),
// cross-checked against the catalogue sale record (status 'sold', soldTo === franchise).
import assert from 'node:assert';
import fs from 'node:fs';
import {
  startServer, connect, emit, waitFor, createRoom, makeRunner, strongToken, tempStorageFile,
  trackManager, mockIo, assertRejected, freePort
} from './helpers/harness.js';

process.env.ROOM_STORAGE_FILE = process.env.ROOM_STORAGE_FILE || tempStorageFile('squad-unit');
const { RoomManager } = await import('../server/roomManager.js');

const t = makeRunner('Squad Ownership Suite (Playing XI may only use purchased players)');

// ── helpers ───────────────────────────────────────────────────
function setup(file = tempStorageFile('squad')) {
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const tok = { CSK: strongToken('host'), MI: strongToken('mi'), RCB: strongToken('rcb') };
  const room = rm.createRoom({ hostName: 'Host', hostToken: tok.CSK, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30 } });
  let n = 1;
  for (const [fid, token] of Object.entries(tok)) {
    rm.joinRoom({ roomCode: room.roomCode, participantName: fid, participantToken: token, socketId: `s${n++}` });
    rm.selectFranchise({ roomCode: room.roomCode, participantToken: token, franchiseId: fid });
  }
  return { rm, room, tok, file };
}
const start = ({ rm, room, tok }) => assert.ok(rm.startAuction({ roomCode: room.roomCode, hostToken: tok.CSK }).success);

// Run lots; chooser(player) returns the buying franchise id, or null for UNSOLD
function runLots(ctx, count, chooser) {
  const { rm, room, tok } = ctx;
  for (let i = 0; i < count && room.status === 'active'; i++) {
    const lot = room.currentLot;
    rm.clearRoomTimer(room.roomCode);
    const buyer = chooser(lot.player);
    if (buyer) {
      const r = rm.placeBid({ roomCode: room.roomCode, participantToken: tok[buyer], franchiseId: buyer, bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
      assert.ok(r.success, `buy ${lot.player.name} for ${buyer}: ${r.error}`);
    }
    rm.closeCurrentLot(room);
    rm.nextPlayer(room);
  }
}
// Deterministic squads: MI collects 10 Indian non-WK players + 1 Indian WK (alternate lots),
// CSK buys every third remaining lot until it has 4, everything else goes UNSOLD.
function buildSquads(ctx) {
  let i = 0, ind = 0, miNonWK = 0, miWK = 0, csk = 0;
  const done = () => miNonWK >= 10 && miWK >= 1 && csk >= 4;
  for (let guard = 0; guard < 150 && !done() && ctx.room.status === 'active'; guard++) {
    runLots(ctx, 1, p => {
      i++;
      if (!p.isOverseas && p.category === 'WK' && miWK < 1) { miWK++; return 'MI'; }
      // every second Indian non-WK player (catalogue alternates IND/OS, so count Indians only)
      if (!p.isOverseas && p.category !== 'WK' && miNonWK < 10 && ind++ % 2 === 0) { miNonWK++; return 'MI'; }
      if (csk < 4 && i % 3 === 0) { csk++; return 'CSK'; }
      return null; // UNSOLD
    });
  }
  assert.strictEqual(ctx.room.franchises.MI.squad.length, 11, 'setup: MI should own 11');
  assert.ok(ctx.room.franchises.CSK.squad.length >= 4, 'setup: CSK should own players');
  assert.ok(ctx.room.playersCatalog.some(p => p.status === 'unsold'), 'setup: need unsold players');
  return ctx;
}
const update = (ctx, fid, body, token = ctx.tok[fid]) =>
  ctx.rm.updatePlayingXI({ roomCode: ctx.room.roomCode, participantToken: token, franchiseId: fid, ...body });
const miXI = room => {
  const sq = room.franchises.MI.squad;
  const wk = sq.find(p => p.category === 'WK');
  const xi = [wk.id, ...sq.filter(p => p.id !== wk.id).slice(0, 10).map(p => p.id)];
  return { playingXI: xi, captainId: xi[1], viceCaptainId: xi[2] };
};
const lineup = (room, fid) => JSON.stringify({
  cfg: (({ confirmedAt, ...c }) => c)(room.playingXIConfigurations[fid] || {}),
  xi: room.franchises[fid].playingXI, c: room.franchises[fid].captainId, vc: room.franchises[fid].viceCaptainId,
  wk: room.franchises[fid].wicketKeeperId, ip: room.franchises[fid].impactPlayerId
});
const squadIds = (room, fid) => room.franchises[fid].squad.map(p => p.id).join(',');
const byStatus = (room, s) => room.playersCatalog.filter(p => p.status === s);

// ── tests ─────────────────────────────────────────────────────
await t.it('before the auction: squads are empty, so any player is rejected (empty lineup is fine)', () => {
  const ctx = setup();
  const anyPlayer = ctx.room.playersCatalog[0].id;
  const r = update(ctx, 'MI', { playingXI: [anyPlayer] });
  assert.strictEqual(r.success, false, 'unpurchased player accepted in lobby');
  assert.strictEqual(r.code, 'PLAYER_NOT_IN_SQUAD');
  assert.ok(update(ctx, 'MI', { playingXI: [] }).success, 'empty lineup should be allowed');
});

const ctx = buildSquads((() => { const c = setup(); start(c); return c; })());
const { room } = ctx;

await t.it('1. owner can select players purchased by their franchise (full valid XI)', () => {
  const r = update(ctx, 'MI', miXI(room));
  assert.ok(r.success, r.error);
  assert.deepStrictEqual(room.playingXIConfigurations.MI.playingXI, miXI(room).playingXI);
});

await t.it('2. cannot select an unpurchased player (never auctioned, or the lot currently on the block)', () => {
  const notYet = byStatus(room, 'available')[0];
  const onBlock = room.currentLot.player;
  for (const p of [notYet, onBlock]) {
    const r = update(ctx, 'MI', { playingXI: [p.id] });
    assertRejected(r, `unpurchased ${p.name}`);
    assert.strictEqual(r.code, 'PLAYER_NOT_IN_SQUAD');
  }
});

await t.it('3. cannot select an UNSOLD player', () => {
  const unsold = byStatus(room, 'unsold')[0];
  assert.ok(unsold, 'setup: need an unsold player');
  const r = update(ctx, 'MI', { playingXI: [unsold.id] });
  assertRejected(r, 'unsold');
  assert.strictEqual(r.code, 'PLAYER_NOT_IN_SQUAD');
});

await t.it("4. franchise A cannot select a player purchased by franchise B", () => {
  const cskPlayer = room.franchises.CSK.squad[0];
  assert.ok(cskPlayer, 'setup: CSK must own a player');
  const r = update(ctx, 'MI', { playingXI: [cskPlayer.id] });
  assertRejected(r, 'MI fielding CSK player');
  assert.strictEqual(r.code, 'PLAYER_NOT_IN_SQUAD');
  // impact player slot is held to the same rule
  assertRejected(update(ctx, 'MI', { playingXI: [], impactPlayerId: cskPlayer.id }), 'impact from CSK');
});

await t.it('5. a player cannot appear in two franchises\' lineups (even with inconsistent saved state)', () => {
  const cskPlayer = room.franchises.CSK.squad[0];
  assert.ok(update(ctx, 'CSK', { playingXI: [cskPlayer.id] }).success, 'CSK fields its own player');
  // Simulate a corrupted / hand-edited save: MI's squad wrongly holds a copy of CSK's player
  room.franchises.MI.squad.push({ ...cskPlayer });
  const r = update(ctx, 'MI', { playingXI: [cskPlayer.id] });
  assertRejected(r, 'player in two lineups');
  room.franchises.MI.squad.pop(); // restore true state
  // And even if the catalogue were also wrongly flipped to MI, the other franchise's lineup blocks it
  const cat = room.playersCatalog.find(p => p.id === cskPlayer.id);
  cat.soldTo = 'MI'; room.franchises.MI.squad.push({ ...cskPlayer });
  assertRejected(update(ctx, 'MI', { playingXI: [cskPlayer.id] }), 'player already in CSK lineup');
  cat.soldTo = 'CSK'; room.franchises.MI.squad.pop();
  assert.ok(update(ctx, 'CSK', { playingXI: [] }).success);
});

await t.it('5b. a STALE pre-rule lineup elsewhere does not block the rightful owner (no false rejection)', () => {
  // Before the squad rule, lineups could hold any catalogue player (lobby planning). Simulate an
  // old saved room where RCB's lineup lists a player RCB never bought, which MI then buys.
  const c = setup(); start(c);
  const target = c.room.currentLot.player;
  c.room.playingXIConfigurations.RCB.playingXI = [target.id];   // stale legacy entry
  c.room.franchises.RCB.playingXI = [target.id];
  rm_buy(c, 'MI');
  const r = update(c, 'MI', { playingXI: [target.id] });
  assert.ok(r.success, `rightful owner wrongly blocked: ${r.error}`);
  assert.deepStrictEqual(c.room.franchises.RCB.playingXI, [target.id], 'stale lineup should not be silently rewritten');
});

await t.it('9. a failed update leaves the existing lineup and squad untouched', () => {
  assert.ok(update(ctx, 'MI', miXI(room)).success);
  const before = lineup(room, 'MI'); const squadBefore = squadIds(room, 'MI');
  const outsider = byStatus(room, 'available')[0].id;
  const bad = [
    { playingXI: [...miXI(room).playingXI.slice(0, 10), outsider] },
    { playingXI: [miXI(room).playingXI[0], miXI(room).playingXI[0]] },
    { playingXI: [...miXI(room).playingXI, outsider] },
    { ...miXI(room), impactPlayerId: outsider }
  ];
  for (const b of bad) assertRejected(update(ctx, 'MI', b), JSON.stringify(b).slice(0, 60));
  assert.strictEqual(lineup(room, 'MI'), before, 'lineup changed');
  assert.strictEqual(squadIds(room, 'MI'), squadBefore, 'squad changed');
});

await t.it('10. a purchase is eligible immediately (same lot, mid-auction, no reload)', () => {
  const lot = room.currentLot;
  const p = lot.player;
  assertRejected(update(ctx, 'RCB', { playingXI: [p.id] }), 'before sale');
  rm_buy(ctx, 'RCB');
  assert.ok(update(ctx, 'RCB', { playingXI: [p.id] }).success, 'just-bought player should be eligible');
  ctx.rm.nextPlayer(room);
});
function rm_buy({ rm, room, tok }, fid) {
  const lot = room.currentLot;
  rm.clearRoomTimer(room.roomCode);
  assert.ok(rm.placeBid({ roomCode: room.roomCode, participantToken: tok[fid], franchiseId: fid, bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion }).success);
  rm.closeCurrentLot(room);
}

await t.it('11. existing lineup rules still apply: size, duplicates, wicketkeeper, captain/VC, impact, overseas', () => {
  const xi = miXI(room);
  const noWK = { ...xi, playingXI: [...room.franchises.MI.squad.filter(p => p.category !== 'WK').slice(0, 10).map(p => p.id)] };
  // 11 without a WK: MI owns exactly one WK, so build 10 non-WK + duplicate to reach 11 is a dup; use RCB-less approach:
  const cases = [
    ['more than 11', { playingXI: [...xi.playingXI, xi.playingXI[0]] }, /more than 11|duplicate/i],
    ['duplicate player', { playingXI: [xi.playingXI[0], xi.playingXI[0]] }, /duplicate/i],
    ['captain not in XI', { playingXI: xi.playingXI.slice(0, 5), captainId: xi.playingXI[9] }, /Captain/i],
    ['captain == VC', { ...xi, viceCaptainId: xi.captainId }, /distinct/i],
    ['full XI without captain', { ...xi, captainId: null }, /Captain/i],
    ['wicketKeeperId not a WK', { ...xi, wicketKeeperId: xi.playingXI[5] }, /wicket/i],
    ['wicketKeeperId not in XI', { playingXI: xi.playingXI.slice(1, 5), wicketKeeperId: xi.playingXI[0] }, /wicket/i],
    ['impact also in XI', { ...xi, impactPlayerId: xi.playingXI[3] }, /Impact/i],
    ['non-string ids', { playingXI: [{ id: xi.playingXI[0] }] }, /./],
    ['playingXI not an array', { playingXI: 'abc' }, /./]
  ];
  for (const [label, body, re] of cases) {
    const r = update(ctx, 'MI', body);
    assertRejected(r, label);
    assert.match(r.error, re, `${label}: ${r.error}`);
  }
  // 11 players, no wicketkeeper (needs a squad of >= 11 non-WK)
  if (noWK.playingXI.length === 11) assertRejected(update(ctx, 'MI', { ...noWK, captainId: noWK.playingXI[0], viceCaptainId: noWK.playingXI[1] }), 'no WK');
  // the auto-picked wicketkeeper is valid
  assert.ok(update(ctx, 'MI', xi).success);
  const wk = room.franchises.MI.squad.find(p => p.category === 'WK');
  assert.strictEqual(room.franchises.MI.wicketKeeperId, wk.id);
});

await t.it('skipped players cannot be selected', () => {
  const c = setup(); start(c);
  const r0 = c.rm.skipCurrentSet({ roomCode: c.room.roomCode, hostToken: c.tok.CSK });
  assert.ok(r0.success);
  const skipped = byStatus(c.room, 'SKIPPED')[0];
  assertRejected(update(c, 'CSK', { playingXI: [skipped.id] }), 'skipped player');
});

await t.it('12. restored room keeps squads and valid lineups; ownership still enforced after restart', () => {
  const file = tempStorageFile('squad-restore');
  const c = buildSquads((() => { const x = setup(file); start(x); return x; })());
  assert.ok(update(c, 'MI', miXI(c.room)).success);
  const savedLineup = lineup(c.room, 'MI'); const savedSquad = squadIds(c.room, 'MI');
  const cskPlayer = c.room.franchises.CSK.squad[0].id;
  c.rm.shutdown();

  const rm2 = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const r2 = rm2.getRoom(c.room.roomCode);
  assert.strictEqual(squadIds(r2, 'MI'), savedSquad, 'squad lost on restore');
  assert.strictEqual(lineup(r2, 'MI'), savedLineup, 'valid lineup lost on restore');
  const c2 = { rm: rm2, room: r2, tok: c.tok };
  assertRejected(update(c2, 'MI', { playingXI: [cskPlayer] }), 'CSK player after restore');
  assert.ok(update(c2, 'MI', miXI(r2)).success, 'owned players still eligible after restore');
});

// ── over the wire: spoofing, host, other owners, stale client ──
const srv = await startServer();
try {
  const H = strongToken('wh'); const A = strongToken('wa'); const B = strongToken('wb');
  const { body } = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2 } });
  const code = body.roomCode;
  const host = await connect(srv.url); const alice = await connect(srv.url); const bob = await connect(srv.url);
  await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(bob, 'join_room', { roomCode: code, participantName: 'Bob', participantToken: B });
  await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  await emit(bob, 'select_franchise', { roomCode: code, franchiseId: 'RCB' });
  const lp = waitFor(alice, 'lot_presented');
  await emit(host, 'start_auction', { roomCode: code });
  let lot = (await lp).currentLot;
  // Lot 1 → MI, Lot 2 → CSK, Lot 3 → UNSOLD
  const sell = async (sock, fid) => {
    const r = await emit(sock, 'place_bid', { roomCode: code, franchiseId: fid, bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
    assert.ok(r.success, r.error);
  };
  const next = async () => { const p = waitFor(alice, 'lot_presented'); await emit(host, 'advance_lot', { roomCode: code }); lot = (await p).currentLot; };
  const close = async () => { const p = waitFor(alice, 'lot_completed'); await emit(host, 'advance_lot', { roomCode: code }); return p; };
  await sell(alice, 'MI'); const miBuy = (await close()).historyEntry.player.id; await next();
  await sell(host, 'CSK'); const cskBuy = (await close()).historyEntry.player.id; await next();
  const unsoldId = (await close()).historyEntry.player.id; await next();
  const pub = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  const miBefore = JSON.stringify(pub.playingXIConfigurations.MI);

  await t.it('6. payload spoofing of ownership is ignored (fake squad, soldTo, owner ids, franchise swaps)', async () => {
    const spoofs = [
      { franchiseId: 'MI', playingXI: [cskBuy], squad: [{ id: cskBuy }], ownedPlayers: [cskBuy] },
      { franchiseId: 'MI', playingXI: [cskBuy], players: [{ id: cskBuy, soldTo: 'MI', status: 'sold' }] },
      { franchiseId: 'MI', playingXI: [unsoldId], franchise: { id: 'MI', squad: [{ id: unsoldId }] } },
      { franchiseId: 'MI', playingXI: [cskBuy], ownerId: pub.franchises.CSK.ownerId, soldTo: 'MI' },
      { franchiseId: 'MI', playingXI: [lot.player.id], isPurchased: true },
      { franchiseId: 'MI', playingXI: [miBuy], impactPlayerId: cskBuy, wicketKeeperId: cskBuy }
    ];
    for (const s of spoofs) {
      const r = await emit(alice, 'update_playing_xi', { roomCode: code, ...s });
      assertRejected(r, `spoof ${JSON.stringify(s).slice(0, 70)}`);
    }
  });

  await t.it('7. the host cannot bypass ownership: not in their own lineup, not in another franchise', async () => {
    const r1 = await emit(host, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [miBuy] });
    assertRejected(r1, 'host fielding MI player');
    assert.strictEqual(r1.code, 'PLAYER_NOT_IN_SQUAD');
    const r2 = await emit(host, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [miBuy] });
    assertRejected(r2, 'host editing MI');
    assert.strictEqual(r2.code, 'FORBIDDEN');
    assert.ok((await emit(host, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [cskBuy] })).success, 'host fields own purchase');
  });

  await t.it('8. another owner cannot modify a franchise lineup, even with that franchise\'s own players', async () => {
    const r = await emit(bob, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [miBuy] });
    assertRejected(r, 'Bob → MI');
    assert.strictEqual(r.code, 'FORBIDDEN');
    const now = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    assert.strictEqual(JSON.stringify(now.playingXIConfigurations.MI), miBefore, 'MI lineup changed');
  });

  await t.it('stale client state cannot bypass validation; the owner\'s real purchase works over the socket', async () => {
    // e.g. a browser that cached an old lineup containing a player it never owned
    assertRejected(await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [miBuy, unsoldId] }), 'stale cached lineup');
    const ok = await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [miBuy] });
    assert.ok(ok.success, ok.error);
  });
} finally {
  await srv.stop();
}

// ── real process restart ──────────────────────────────────────
await t.it('12b. real server restart: squad + lineup restored; rules still enforced over the socket', async () => {
  const file = tempStorageFile('squad-srv');
  const port = await freePort();
  const H = strongToken('rh'); const A = strongToken('ra');
  let s = await startServer({ storageFile: file, port });
  const { body } = await createRoom(s.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2 } });
  const code = body.roomCode;
  let h = await connect(s.url); let a = await connect(s.url);
  await emit(h, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(a, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(h, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(a, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  const lp = waitFor(a, 'lot_presented');
  await emit(h, 'start_auction', { roomCode: code });
  const lot = (await lp).currentLot;
  await emit(a, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
  const done = waitFor(a, 'lot_completed');
  await emit(h, 'advance_lot', { roomCode: code });
  const bought = (await done).historyEntry.player.id;
  assert.ok((await emit(a, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [bought] })).success);
  await s.stop();

  s = await startServer({ storageFile: file, port });
  h = await connect(s.url); a = await connect(s.url);
  const aj = await emit(a, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(h, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  assert.deepStrictEqual(aj.room.franchises.MI.squad.map(p => p.id), [bought], 'squad not restored');
  assert.deepStrictEqual(aj.room.playingXIConfigurations.MI.playingXI, [bought], 'lineup not restored');
  assertRejected(await emit(h, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [bought] }), 'host takes MI player after restart');
  assert.ok((await emit(a, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [bought] })).success);
  await s.stop();
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
