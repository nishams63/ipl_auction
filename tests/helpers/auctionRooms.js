// Builders for realistic room states, driven ONLY through the public RoomManager API
// (no hand-written room objects), plus the normalization used to compare a room with its
// restored copy.
import assert from 'node:assert';
import { strongToken } from './harness.js';
import { hashKeyOf } from '../../server/persistence/tokenHash.js';

export function lobbyRoom(rm, cfg = {}) {
  const H = strongToken('host');
  const A = strongToken('alice');
  const room = rm.createRoom({ hostName: 'Host', hostToken: H, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30, ...cfg } });
  const code = room.roomCode;
  assert.ok(rm.joinRoom({ roomCode: code, participantName: 'Host', participantToken: H, socketId: 'sock-host-1' }).success);
  assert.ok(rm.joinRoom({ roomCode: code, participantName: 'Alice', participantToken: A, socketId: 'sock-alice-1' }).success);
  assert.ok(rm.selectFranchise({ roomCode: code, participantToken: H, franchiseId: 'CSK' }).success);
  assert.ok(rm.selectFranchise({ roomCode: code, participantToken: A, franchiseId: 'MI' }).success);
  return { room, code, H, A };
}

export function liveRoom(rm, cfg) {
  const r = lobbyRoom(rm, cfg);
  const res = rm.startAuction({ roomCode: r.code, hostToken: r.H });
  assert.ok(res.success, res.error);
  return r;
}

export function bid(rm, room, token, fid) {
  const lot = room.currentLot;
  const res = rm.placeBid({ roomCode: room.roomCode, participantToken: token, franchiseId: fid, bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
  assert.ok(res.success, res.error);
}

// Sell the current lot to fid (one bid, then hammer) and present the next player
export function sellCurrent(rm, room, token, fid) {
  bid(rm, room, token, fid);
  rm.closeCurrentLot(room);
  rm.nextPlayer(room);
}

export function passCurrent(rm, room) {
  rm.closeCurrentLot(room);
  rm.nextPlayer(room);
}

/**
 * A room exercising every persisted structure: sales to two franchises, a contested lot,
 * an unsold lot, a skipped set, saved Playing XIs with captain / vice-captain / keeper /
 * impact player, and an OPEN current lot with live bids.
 */
export function richRoom(rm) {
  const r = liveRoom(rm);
  const { room, H, A, code } = r;
  // contested sale
  bid(rm, room, H, 'CSK'); bid(rm, room, A, 'MI'); bid(rm, room, H, 'CSK');
  rm.closeCurrentLot(room); rm.nextPlayer(room);
  for (let i = 0; i < 5; i++) sellCurrent(rm, room, H, 'CSK');
  for (let i = 0; i < 5; i++) sellCurrent(rm, room, A, 'MI');
  passCurrent(rm, room); // unsold
  const s = rm.skipCurrentSet({ roomCode: code, hostToken: H });
  assert.ok(s.success, s.error);
  // keep buying until each side owns a wicketkeeper (catalogue order is fixed)
  let guard = 0;
  // (other lots pass unsold, so the real squad limits are never hit)
  while (guard++ < 290 && !(['CSK', 'MI'].every(f => room.franchises[f].squad.some(p => p.category === 'WK')))) {
    if (room.currentLot?.player?.category !== 'WK') { passCurrent(rm, room); continue; }
    const fid = room.franchises.CSK.squad.some(p => p.category === 'WK') ? 'MI' : 'CSK';
    sellCurrent(rm, room, fid === 'CSK' ? H : A, fid);
  }
  assert.ok(['CSK', 'MI'].every(f => room.franchises[f].squad.some(p => p.category === 'WK')), 'no wicketkeeper reached');
  for (const [fid, token] of [['CSK', H], ['MI', A]]) {
    const squad = room.franchises[fid].squad;
    const wk = squad.find(p => p.category === 'WK');
    // Up to 5 players, never more than 4 overseas (lot order is shuffled, so pick by rule, not position)
    const picked = [wk];
    for (const p of squad.filter(x => x !== wk).sort((a, b) => Number(a.isOverseas) - Number(b.isOverseas))) {
      if (picked.length >= 5) break;
      if (p.isOverseas && picked.filter(x => x.isOverseas).length >= 4) continue;
      picked.push(p);
    }
    const xi = picked.map(p => p.id);
    const impact = squad.find(p => !xi.includes(p.id));
    const res = rm.updatePlayingXI({
      roomCode: code, participantToken: token, franchiseId: fid, playingXI: xi,
      captainId: xi[1], viceCaptainId: xi[2], wicketKeeperId: wk.id, impactPlayerId: impact ? impact.id : null, isConfirmed: false
    });
    assert.ok(res.success, res.error);
  }
  bid(rm, room, A, 'MI'); bid(rm, room, H, 'CSK'); // open lot with two live bids
  return r;
}

/**
 * Comparable form of a room: what a faithful restore must reproduce.
 * Documented normalizations only: tokens → hash keys, socket ids → null, newest 200 audit
 * entries, transient isSkippingSet/storageHold dropped, undefined-valued keys dropped (as JSON does).
 */
export function normalizeRoom(room) {
  const plain = JSON.parse(JSON.stringify({ ...room, participants: [...room.participants.entries()] }));
  delete plain.isSkippingSet;
  delete plain.storageHold;
  plain.hostToken = plain.hostToken ? hashKeyOf(plain.hostToken) : plain.hostToken;
  plain.participants = plain.participants.map(([k, p]) => [hashKeyOf(k), { ...p, token: hashKeyOf(k), socketId: null }]);
  for (const f of Object.values(plain.franchises)) {
    if ('ownerToken' in f) f.ownerToken = f.ownerToken ? hashKeyOf(f.ownerToken) : f.ownerToken;
    if ('ownerSocketId' in f) f.ownerSocketId = null;
  }
  plain.auditLog = plain.auditLog.slice(0, 200);
  return plain;
}
