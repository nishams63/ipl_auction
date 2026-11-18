// Playing XI authorization: only the authenticated OWNER of a franchise may change its XI.
// The host has no override over other franchises. Applies to legacy sessions too.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startServer, connect, emit, waitFor, createRoom, makeRunner, strongToken, tempStorageFile,
  trackManager, mockIo, assertRejected
} from './helpers/harness.js';

process.env.ROOM_STORAGE_FILE = process.env.ROOM_STORAGE_FILE || tempStorageFile('xi-unit');
const { RoomManager, PLAYING_XI_FORBIDDEN } = await import('../server/roomManager.js');

const t = makeRunner('Playing XI Authorization Suite');
const dir = path.dirname(fileURLToPath(import.meta.url));

// A valid full XI from a franchise's PURCHASED squad: 1 WK + 10 Indian players, captain/VC/impact
// (squad-ownership rule: lineups may only use players the franchise bought)
function validXI(squad) {
  const wk = squad.find(p => p.category === 'WK' && !p.isOverseas);
  const others = squad.filter(p => !p.isOverseas && p.category !== 'WK');
  const xi = [wk.id, ...others.slice(0, 10).map(p => p.id)];
  return { playingXI: xi, captainId: xi[0], viceCaptainId: xi[1], impactPlayerId: others[10].id };
}

// Run the live auction over real sockets until each franchise has bought its quota
async function buySquads({ code, host, sockets, quotas, getRoom }) {
  const counts = Object.fromEntries(Object.keys(quotas).map(f => [f, { WK: 0, IND: 0, OS: 0, ANY: 0 }]));
  const need = (f, p) => {
    const q = quotas[f], c = counts[f];
    if (p.isOverseas) return (q.OS || 0) > c.OS || (q.ANY || 0) > c.ANY;
    if (p.category === 'WK') return (q.WK || 0) > c.WK || (q.ANY || 0) > c.ANY;
    return (q.IND || 0) > c.IND || (q.ANY || 0) > c.ANY;
  };
  const done = () => Object.keys(quotas).every(f => ['WK', 'IND', 'OS', 'ANY'].every(k => (quotas[f][k] || 0) <= counts[f][k]));
  let room = await getRoom(code);
  for (let guard = 0; guard < 200 && !done(); guard++) {
    const lot = room.currentLot;
    const buyer = Object.keys(quotas).find(f => need(f, lot.player));
    if (buyer) {
      const r = await emit(sockets[buyer], 'place_bid', { roomCode: code, franchiseId: buyer, bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
      assert.ok(r.success, `buy ${lot.player.name} for ${buyer}: ${r.error}`);
      const c = counts[buyer], p = lot.player, q = quotas[buyer];
      if (p.isOverseas && (q.OS || 0) > c.OS) c.OS++;
      else if (!p.isOverseas && p.category === 'WK' && (q.WK || 0) > c.WK) c.WK++;
      else if (!p.isOverseas && p.category !== 'WK' && (q.IND || 0) > c.IND) c.IND++;
      else c.ANY++;
    }
    const presented = waitFor(host, 'lot_presented');
    assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success); // close (SOLD/UNSOLD)
    assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success); // next lot
    await presented;
    room = await getRoom(code);
  }
  assert.ok(done(), 'could not complete squad quotas');
  return room;
}
// Lineup content only (confirmedAt is a timestamp that legitimately changes on every owner save)
const xiOf = (room, fid) => {
  const { confirmedAt, ...cfg } = room.playingXIConfigurations[fid] || {};
  const f = room.franchises[fid];
  return JSON.stringify({ cfg, xi: f.playingXI, c: f.captainId, vc: f.viceCaptainId, ip: f.impactPlayerId });
};

// ─────────────────────────────────────────────────────────────
// Real server, real sockets
// ─────────────────────────────────────────────────────────────
const srv = await startServer();
const getRoom = async code => (await fetch(`${srv.url}/api/rooms/${code}`)).json();

try {
  const H = strongToken('xh'); const A = strongToken('xa'); const B = strongToken('xb');
  const { body } = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2 } });
  const code = body.roomCode;
  const host = await connect(srv.url); const alice = await connect(srv.url); const bob = await connect(srv.url);
  const hj = await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  const aj = await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(bob, 'join_room', { roomCode: code, participantName: 'Bob', participantToken: B });
  await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  await emit(bob, 'select_franchise', { roomCode: code, franchiseId: 'RCB' });
  assert.ok((await emit(host, 'start_auction', { roomCode: code })).success);
  const bought = await buySquads({
    code, host, getRoom,
    sockets: { MI: alice, CSK: host, RCB: bob },
    quotas: { MI: { WK: 1, IND: 11, OS: 5 }, CSK: { WK: 1, IND: 11 }, RCB: { ANY: 1 } }
  });
  const xiA = validXI(bought.franchises.MI.squad); const xiB = validXI(bought.franchises.CSK.squad);
  const miOverseas = bought.franchises.MI.squad.filter(p => p.isOverseas).map(p => p.id);

  // Give MI (Alice) and CSK (Host) an initial lineup to protect
  assert.ok((await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', ...xiA })).success, 'setup MI');
  assert.ok((await emit(host, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', ...xiB })).success, 'setup CSK');
  const snap = async () => { const r = await getRoom(code); return { MI: xiOf(r, 'MI'), CSK: xiOf(r, 'CSK'), RCB: xiOf(r, 'RCB') }; };
  const original = await snap();

  await t.it('1. franchise owner can edit their own Playing XI (full XI, captain, VC, impact)', async () => {
    const r = await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', ...xiA });
    assert.ok(r.success, r.error);
    const room = await getRoom(code);
    assert.deepStrictEqual(room.playingXIConfigurations.MI.playingXI, xiA.playingXI);
    assert.strictEqual(room.playingXIConfigurations.MI.captainId, xiA.captainId);
    assert.strictEqual(room.playingXIConfigurations.MI.impactPlayerId, xiA.impactPlayerId);
  });

  await t.it("2. franchise A's owner cannot edit franchise B's Playing XI", async () => {
    const r = await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [] });
    assertRejected(r, 'Alice → CSK');
    assert.strictEqual(r.error, PLAYING_XI_FORBIDDEN);
    assert.strictEqual(r.code, 'FORBIDDEN');
    assertRejected(await emit(bob, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', ...xiB }), 'Bob → MI');
  });

  await t.it('3. the host cannot edit another franchise\'s Playing XI', async () => {
    for (const fid of ['MI', 'RCB', 'KKR']) { // claimed by others, and unclaimed
      const r = await emit(host, 'update_playing_xi', { roomCode: code, franchiseId: fid, playingXI: [] });
      assertRejected(r, `host → ${fid}`);
      assert.strictEqual(r.error, PLAYING_XI_FORBIDDEN);
    }
    assert.strictEqual(hj.participant.isHost, true, 'precondition: host is host');
  });

  await t.it('4. the host can edit their own franchise (they own CSK)', async () => {
    const r = await emit(host, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', ...xiB, captainId: xiB.playingXI[2] });
    assert.ok(r.success, r.error);
    assert.strictEqual((await getRoom(code)).playingXIConfigurations.CSK.captainId, xiB.playingXI[2]);
    // restore for later snapshot comparisons
    await emit(host, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', ...xiB });
  });

  await t.it('5. payload tampering cannot impersonate another owner (token, ids, host flags)', async () => {
    const pub = await getRoom(code);
    const tampered = [
      { participantToken: H },                                   // another user's token
      { hostToken: H },
      { participantToken: A, hostToken: H },
      { ownerId: pub.franchises.CSK.ownerId },                   // public id of the real owner
      { participantId: pub.franchises.CSK.ownerId, publicId: pub.franchises.CSK.ownerId },
      { isHost: true, isOwner: true, owner: true },
      { franchiseId: 'CSK', franchise: { id: 'MI' } },
      { roomCode: code.toLowerCase() }                           // case games on the room code
    ];
    for (const extra of tampered) {
      const r = await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [], ...extra });
      assertRejected(r, `tamper ${JSON.stringify(extra)}`);
    }
    // Odd franchise ids never reach a lineup
    for (const fid of ['__proto__', 'constructor', 'toString', '', null, 42, ['CSK'], { id: 'CSK' }]) {
      assertRejected(await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: fid, playingXI: [] }), `franchiseId ${JSON.stringify(fid)}`);
    }
  });

  await t.it('6. unauthorized REST requests are rejected (no REST route can modify a Playing XI)', async () => {
    const attempts = [
      ['POST', `/api/rooms/${code}`], ['PUT', `/api/rooms/${code}`], ['PATCH', `/api/rooms/${code}`],
      ['POST', `/api/rooms/${code}/playing-xi`], ['PUT', `/api/rooms/${code}/playing-xi`],
      ['POST', `/api/rooms/${code}/franchises/CSK/playing-xi`], ['DELETE', `/api/rooms/${code}`]
    ];
    for (const [method, url] of attempts) {
      const r = await fetch(`${srv.url}${url}`, {
        method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participantToken: H, hostToken: H, franchiseId: 'CSK', playingXI: [] })
      });
      assert.ok(r.status === 404 || r.status === 405, `${method} ${url} → ${r.status}`);
    }
    // Smuggling lineup data through room creation is rejected by the config validator
    const smuggle = await createRoom(srv.url, { hostToken: strongToken('s'), config: { playingXIConfigurations: { CSK: { playingXI: [] } } } });
    assert.strictEqual(smuggle.status, 400);
  });

  await t.it('7. unauthorized Socket.IO requests are rejected (outsider, never-joined, revoked session)', async () => {
    const outsider = await connect(srv.url);
    assertRejected(await emit(outsider, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [] }), 'never joined');
    assertRejected(await emit(outsider, 'update_playing_xi', { roomCode: code, participantToken: A, franchiseId: 'MI', playingXI: [] }), 'never joined with real token');
    // Revoke Alice's first socket by opening a newer session for her
    const replaced = waitFor(alice, 'session_replaced');
    const alice2 = await connect(srv.url);
    assert.ok((await emit(alice2, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A })).success);
    await replaced;
    const r = await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [] });
    assertRejected(r, 'revoked socket');
    assert.strictEqual(r.code, 'FORBIDDEN');
    assert.ok((await emit(alice2, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', ...xiA })).success, 'current session can still edit');
  });

  await t.it('9. no failed request in this suite changed any lineup', async () => {
    const now = await snap();
    assert.strictEqual(now.CSK, original.CSK, 'CSK lineup changed');
    assert.strictEqual(now.MI, original.MI, 'MI lineup changed');
    assert.strictEqual(now.RCB, original.RCB, 'RCB lineup changed');
  });

  await t.it('10. legitimate features still work: validation rules, persistence of lineup, broadcast to room', async () => {
    const alice3 = await connect(srv.url);
    assert.ok((await emit(alice3, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A })).success);
    // Owner still gets normal validation errors (not authorization errors)
    const os = miOverseas.slice(0, 5); // five overseas players MI actually owns
    const bad = await emit(alice3, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: os });
    assertRejected(bad, 'five overseas');
    assert.match(bad.error, /overseas/i);
    assert.notStrictEqual(bad.code, 'FORBIDDEN');
    // A valid change is broadcast to everyone in the room
    const seen = waitFor(bob, 'state_updated', s => s.playingXIConfigurations?.MI?.captainId === xiA.playingXI[3]);
    assert.ok((await emit(alice3, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', ...xiA, captainId: xiA.playingXI[3] })).success);
    await seen;
  });
} finally {
  await srv.stop();
}

// ─────────────────────────────────────────────────────────────
// 8. Legacy sessions (room saved by the ORIGINAL code, old token format)
// ─────────────────────────────────────────────────────────────
{
  const FIXTURE = path.join(dir, 'fixtures', 'pre-stage-0.5-room.json');
  const storageFile = tempStorageFile('xi-legacy');
  fs.copyFileSync(FIXTURE, storageFile);
  const code = Object.keys(JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')))[0];
  const LEGACY_HOST = 'usr_1731740000000_h0st01';   // owns CSK, is host
  const LEGACY_ALICE = 'usr_1731740000123_a1ice2';  // owns MI
  const lsrv = await startServer({ storageFile });
  try {
    const h = await connect(lsrv.url); const a = await connect(lsrv.url);
    assert.ok((await emit(h, 'join_room', { roomCode: code, participantName: 'LegacyHost', participantToken: LEGACY_HOST })).success);
    assert.ok((await emit(a, 'join_room', { roomCode: code, participantName: 'LegacyAlice', participantToken: LEGACY_ALICE })).success);
    const room0 = await (await fetch(`${lsrv.url}/api/rooms/${code}`)).json();
    const miPlayer = room0.franchises.MI.squad[0].id;
    const before = { CSK: xiOf(room0, 'CSK'), MI: xiOf(room0, 'MI') };

    await t.it('8. legacy sessions follow the same rule: legacy host cannot edit MI; legacy owners edit their own', async () => {
      const r1 = await emit(h, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [] });
      assertRejected(r1, 'legacy host → MI');
      assert.strictEqual(r1.error, PLAYING_XI_FORBIDDEN);
      assertRejected(await emit(a, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [] }), 'legacy alice → CSK');
      assertRejected(await emit(a, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [], hostToken: LEGACY_HOST }), 'legacy alice quoting host token');
      const mid = await (await fetch(`${lsrv.url}/api/rooms/${code}`)).json();
      assert.strictEqual(xiOf(mid, 'CSK'), before.CSK, 'CSK changed by failed requests');
      assert.strictEqual(xiOf(mid, 'MI'), before.MI, 'MI changed by failed requests');
      assert.ok((await emit(a, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [miPlayer] })).success, 'legacy owner edits own');
      assert.ok((await emit(h, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [] })).success, 'legacy host edits own');
    });
  } finally {
    await lsrv.stop();
  }
}

// ─────────────────────────────────────────────────────────────
// Direct RoomManager checks (the single code path that writes lineups)
// ─────────────────────────────────────────────────────────────
await t.it('RoomManager: ownership needs BOTH franchise.ownerToken and participant.franchiseId to match', () => {
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('xi-rm') }));
  const H = strongToken('rh'); const A = strongToken('ra');
  const room = rm.createRoom({ hostName: 'H', hostToken: H, configOverrides: { minParticipants: 2 } });
  rm.joinRoom({ roomCode: room.roomCode, participantName: 'H', participantToken: H, socketId: 's1' });
  rm.joinRoom({ roomCode: room.roomCode, participantName: 'A', participantToken: A, socketId: 's2' });
  rm.selectFranchise({ roomCode: room.roomCode, participantToken: H, franchiseId: 'CSK' });
  rm.selectFranchise({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI' });
  const before = xiOf(room, 'MI');

  const hostTry = rm.updatePlayingXI({ roomCode: room.roomCode, participantToken: H, franchiseId: 'MI', playingXI: [] });
  assert.deepStrictEqual(hostTry, { success: false, error: PLAYING_XI_FORBIDDEN, code: 'FORBIDDEN' });

  // Inconsistent state (e.g. a hand-edited save file): token matches but participant record disagrees
  room.participants.get(A).franchiseId = 'CSK';
  assert.strictEqual(rm.updatePlayingXI({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI', playingXI: [] }).success, false);
  room.participants.get(A).franchiseId = 'MI';
  room.franchises.MI.isClaimed = false;
  assert.strictEqual(rm.updatePlayingXI({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI', playingXI: [] }).success, false);
  room.franchises.MI.isClaimed = true;

  for (const fid of ['__proto__', 'constructor', 'hasOwnProperty', 'NOPE', undefined]) {
    assert.strictEqual(rm.updatePlayingXI({ roomCode: room.roomCode, participantToken: A, franchiseId: fid, playingXI: [] }).code, 'FORBIDDEN', String(fid));
  }
  assert.strictEqual(rm.updatePlayingXI({ roomCode: room.roomCode, participantToken: undefined, franchiseId: 'MI', playingXI: [] }).code, 'FORBIDDEN');
  assert.strictEqual(xiOf(room, 'MI'), before, 'lineup changed by a failed call');
  assert.ok(rm.updatePlayingXI({ roomCode: room.roomCode, participantToken: A, franchiseId: 'MI', playingXI: [] }).success, 'owner still allowed');
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
