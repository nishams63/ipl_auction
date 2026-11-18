// Automatic cleanup of invalid legacy Playing XI data when a room is restored.
// Restoration path: RoomManager.loadFromStorage() (run by the constructor at server start, and
// callable directly for a reload). Covered here: constructor, direct reload, real server boot,
// and a room file written by the ORIGINAL code (tests/fixtures/pre-stage-0.5-room.json).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startServer, connect, emit, makeRunner, strongToken, tempStorageFile, trackManager, mockIo
} from './helpers/harness.js';

process.env.ROOM_STORAGE_FILE = process.env.ROOM_STORAGE_FILE || tempStorageFile('cleanup-unit');
const { RoomManager, getOwnedPlayers } = await import('../server/roomManager.js');
const dir = path.dirname(fileURLToPath(import.meta.url));
const t = makeRunner('Legacy Playing XI Cleanup Suite (on room restore)');

// ── build a realistic saved room by actually running the auction ──
function buildSavedRoom() {
  const file = tempStorageFile('cleanup');
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const tok = { CSK: strongToken('h'), MI: strongToken('m'), RCB: strongToken('r') };
  const room = rm.createRoom({ hostName: 'Host', hostToken: tok.CSK, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30 } });
  let n = 1;
  for (const [fid, token] of Object.entries(tok)) {
    rm.joinRoom({ roomCode: room.roomCode, participantName: fid, participantToken: token, socketId: `s${n++}` });
    rm.selectFranchise({ roomCode: room.roomCode, participantToken: token, franchiseId: fid });
  }
  rm.startAuction({ roomCode: room.roomCode, hostToken: tok.CSK });
  // MI: 1 Indian WK + 10 Indian others + 1 overseas; CSK: 3 players; some lots UNSOLD
  let ind = 0, i = 0;
  const q = { MIWK: 0, MIIND: 0, MIOS: 0, CSK: 0 };
  for (let g = 0; g < 150; g++) {
    if (q.MIWK >= 1 && q.MIIND >= 10 && q.MIOS >= 1 && q.CSK >= 3) break;
    const lot = room.currentLot; const p = lot.player; i++;
    rm.clearRoomTimer(room.roomCode);
    let buyer = null;
    if (!p.isOverseas && p.category === 'WK' && q.MIWK < 1) { buyer = 'MI'; q.MIWK++; }
    else if (!p.isOverseas && p.category !== 'WK' && q.MIIND < 10 && ind++ % 2 === 0) { buyer = 'MI'; q.MIIND++; }
    else if (p.isOverseas && q.MIOS < 1) { buyer = 'MI'; q.MIOS++; }
    else if (q.CSK < 3 && i % 3 === 0) { buyer = 'CSK'; q.CSK++; }
    if (buyer) {
      const r = rm.placeBid({ roomCode: room.roomCode, participantToken: tok[buyer], franchiseId: buyer, bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
      assert.ok(r.success, r.error);
    }
    rm.closeCurrentLot(room);
    rm.nextPlayer(room);
  }
  // A live bid on the current lot so bid history includes an open lot too
  const lot = room.currentLot;
  rm.clearRoomTimer(room.roomCode);
  rm.placeBid({ roomCode: room.roomCode, participantToken: tok.RCB, franchiseId: 'RCB', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
  rm.pauseAuction({ roomCode: room.roomCode, hostToken: tok.CSK }); // paused: restart recovery leaves it alone
  rm.shutdown();
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return { file, code: room.roomCode, tok, saved };
}

const readRaw = file => fs.readFileSync(file, 'utf-8');
const writeJSON = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj));
const sq = r => r.franchises.MI.squad;
const miValidXI = r => {
  const wk = sq(r).find(p => p.category === 'WK');
  const rest = sq(r).filter(p => p.id !== wk.id && !p.isOverseas).slice(0, 10);
  return [wk.id, ...rest.map(p => p.id)];
};
// Everything cleanup must never touch (compared as exact JSON)
const protectedState = r => JSON.stringify({
  squads: Object.fromEntries(Object.entries(r.franchises).map(([k, f]) => [k, f.squad])),
  purses: Object.fromEntries(Object.entries(r.franchises).map(([k, f]) => [k, [f.initialPurse, f.remainingPurse, f.totalSpent, f.overseasCount, f.isEliminated]])),
  owners: Object.fromEntries(Object.entries(r.franchises).map(([k, f]) => [k, [f.ownerToken, f.ownerId, f.ownerName, f.isClaimed]])),
  catalog: r.playersCatalog, history: r.history, allBids: r.allBids, currentLot: r.currentLot,
  evaluation: r.evaluationResults, config: r.config,
  participants: r.participants instanceof Map ? [...r.participants.entries()] : r.participants, status: r.status,
  currentPlayerIndex: r.currentPlayerIndex, hostToken: r.hostToken
});

// Inject a messy legacy lineup into the saved JSON (what pre-rule versions could save)
function injectLegacy(base) {
  const data = JSON.parse(JSON.stringify(base.saved));
  const r = data[base.code];
  const valid = miValidXI(r);
  const unpurchased = r.playersCatalog.find(p => p.status === 'available').id;
  const unsold = r.playersCatalog.find(p => p.status === 'unsold').id;
  const cskPlayer = r.franchises.CSK.squad[0].id;
  const miOverseas = sq(r).find(p => p.isOverseas).id;
  const xi = [valid[0], unpurchased, valid[1], unsold, valid[2], cskPlayer, valid[1] /* dup */, valid[3]];
  const lineup = {
    playingXI: xi,
    captainId: valid[2],          // valid, stays
    viceCaptainId: unsold,        // invalid, cleared
    wicketKeeperId: valid[0],     // valid WK, stays
    impactPlayerId: cskPlayer     // another franchise's player, cleared
  };
  Object.assign(r.franchises.MI, lineup, { isConfirmed: true });
  r.playingXIConfigurations.MI = { franchiseId: 'MI', ...lineup, playingXI: [...xi], isConfirmed: true, confirmedAt: '2026-11-01T00:00:00.000Z' };
  // CSK legacy lineup: its own player (valid) + MI's player + impact also in XI
  Object.assign(r.franchises.CSK, { playingXI: [cskPlayer, valid[4]], captainId: valid[4], viceCaptainId: cskPlayer, impactPlayerId: cskPlayer });
  r.playingXIConfigurations.CSK = { franchiseId: 'CSK', playingXI: [cskPlayer, valid[4]], captainId: valid[4], viceCaptainId: cskPlayer, wicketKeeperId: null, impactPlayerId: cskPlayer, isConfirmed: false, confirmedAt: null };
  // MI keeps an owned overseas player on the bench as a VALID impact sub in a second scenario
  return { data, r, valid, unpurchased, unsold, cskPlayer, miOverseas };
}

const base = buildSavedRoom();
const legacy = injectLegacy(base);
writeJSON(base.file, legacy.data);
const beforeProtected = protectedState(legacy.r);
const rm1 = trackManager(new RoomManager(mockIo(), { storageFile: base.file })); // path (a): constructor
const R = rm1.getRoom(base.code);
const cfgMI = () => R.playingXIConfigurations.MI;

await t.it('1. unpurchased players are removed', () => {
  assert.ok(!R.franchises.MI.playingXI.includes(legacy.unpurchased));
  assert.ok(!cfgMI().playingXI.includes(legacy.unpurchased));
});
await t.it('2. unsold players are removed', () => {
  assert.ok(!R.franchises.MI.playingXI.includes(legacy.unsold));
  assert.ok(!cfgMI().playingXI.includes(legacy.unsold));
});
await t.it('3. players purchased by another franchise are removed (both directions)', () => {
  assert.ok(!R.franchises.MI.playingXI.includes(legacy.cskPlayer));
  assert.ok(!R.franchises.CSK.playingXI.includes(legacy.valid[4]), 'CSK kept an MI player');
  assert.deepStrictEqual(R.franchises.CSK.playingXI, [legacy.cskPlayer], 'CSK own player must stay');
});
await t.it('4. valid purchased players remain, in their original order', () => {
  const expected = [legacy.valid[0], legacy.valid[1], legacy.valid[2], legacy.valid[3]];
  assert.deepStrictEqual(R.franchises.MI.playingXI, expected);
  assert.deepStrictEqual(cfgMI().playingXI, expected);
});
await t.it('5. valid captain and wicketkeeper designations remain', () => {
  assert.strictEqual(R.franchises.MI.captainId, legacy.valid[2]);
  assert.strictEqual(cfgMI().captainId, legacy.valid[2]);
  assert.strictEqual(R.franchises.MI.wicketKeeperId, legacy.valid[0]);
  assert.strictEqual(R.franchises.CSK.captainId, null, 'CSK captain pointed at a removed MI player');
});
await t.it('6. invalid vice-captain selections are cleared (removed player, or same as captain)', () => {
  assert.strictEqual(R.franchises.MI.viceCaptainId, null);
  assert.strictEqual(cfgMI().viceCaptainId, null);
  // CSK: VC was its own (still valid) player in the XI and captain was cleared, so VC stays valid
  assert.strictEqual(R.franchises.CSK.viceCaptainId, legacy.cskPlayer);
});
await t.it('7. invalid impact-player selections are cleared (other franchise; also in XI)', () => {
  assert.strictEqual(R.franchises.MI.impactPlayerId, null, 'impact from another franchise kept');
  assert.strictEqual(R.franchises.CSK.impactPlayerId, null, 'impact also in starting XI kept');
});
await t.it('8. duplicate player ids are removed', () => {
  for (const xi of [R.franchises.MI.playingXI, cfgMI().playingXI]) {
    assert.strictEqual(new Set(xi).size, xi.length);
  }
});
await t.it('9–12. squads (byte-for-byte), sale records, results, purses, bids, config, ownership unchanged', () => {
  assert.strictEqual(protectedState(R), beforeProtected);
  const onDisk = JSON.parse(readRaw(base.file))[base.code];
  assert.strictEqual(protectedState(onDisk), beforeProtected, 'saved file differs in protected state');
  for (const fid of Object.keys(R.franchises)) {
    assert.strictEqual(JSON.stringify(R.franchises[fid].squad), JSON.stringify(legacy.r.franchises[fid].squad), `${fid} squad bytes changed`);
  }
});
await t.it('after cleanup: no lineup holds an unowned or duplicated player, no player in two lineups', () => {
  const seen = new Map();
  for (const fid of Object.keys(R.franchises)) {
    const owned = getOwnedPlayers(R, fid);
    for (const src of [R.franchises[fid], R.playingXIConfigurations[fid]]) {
      const ids = [...(src?.playingXI || []), src?.impactPlayerId].filter(Boolean);
      for (const id of ids) {
        assert.ok(owned.has(id), `${fid} holds unowned ${id}`);
        if (seen.has(id) && seen.get(id) !== fid) assert.fail(`${id} in ${fid} and ${seen.get(id)}`);
        seen.set(id, fid);
      }
    }
  }
});
await t.it('changed lineups are marked unconfirmed; an audit entry explains the cleanup (no tokens)', () => {
  assert.strictEqual(cfgMI().isConfirmed, false);
  assert.strictEqual(R.franchises.MI.isConfirmed, false);
  const entry = R.auditLog.find(e => e.type === 'LEGACY_LINEUP_CLEANUP');
  assert.ok(entry, 'no audit entry');
  for (const tokv of Object.values(base.tok)) assert.ok(!entry.message.includes(tokv), 'token in audit message');
});
await t.it('cleaned lineup passes the live validator, and the owner can save it unchanged', () => {
  const r = rm1.updatePlayingXI({ roomCode: base.code, participantToken: base.tok.MI, franchiseId: 'MI',
    playingXI: R.franchises.MI.playingXI, captainId: R.franchises.MI.captainId, wicketKeeperId: R.franchises.MI.wicketKeeperId });
  assert.ok(r.success, r.error);
});

await t.it('13. repeated loading produces no further changes (file bytes identical, no new audit entry)', () => {
  rm1.shutdown();
  const afterFirst = readRaw(base.file);
  const rm2 = trackManager(new RoomManager(mockIo(), { storageFile: base.file }));
  rm2.shutdown();
  assert.strictEqual(readRaw(base.file), afterFirst, 'second load rewrote the file');
  const rm3 = trackManager(new RoomManager(mockIo(), { storageFile: base.file }));
  const r3 = rm3.getRoom(base.code);
  assert.strictEqual(r3.auditLog.filter(e => e.type === 'LEGACY_LINEUP_CLEANUP').length, 1);
  rm3.shutdown();
  assert.strictEqual(readRaw(base.file), afterFirst, 'third load rewrote the file');
});

await t.it('14. an already-valid legacy room is left completely unchanged (no save at all)', () => {
  const b2 = buildSavedRoom();
  const data = JSON.parse(readRaw(b2.file));
  const r = data[b2.code];
  const xi = miValidXI(r);
  const os = sq(r).find(p => p.isOverseas).id;
  Object.assign(r.franchises.MI, { playingXI: xi, captainId: xi[1], viceCaptainId: xi[2], wicketKeeperId: xi[0], impactPlayerId: os, isConfirmed: true });
  r.playingXIConfigurations.MI = { franchiseId: 'MI', playingXI: [...xi], captainId: xi[1], viceCaptainId: xi[2], wicketKeeperId: xi[0], impactPlayerId: os, isConfirmed: true, confirmedAt: '2026-11-01T00:00:00.000Z' };
  writeJSON(b2.file, data);
  const bytes = readRaw(b2.file);
  const mtime = fs.statSync(b2.file).mtimeMs;
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: b2.file }));
  const loaded = rm.getRoom(b2.code);
  rm.shutdown();
  assert.strictEqual(readRaw(b2.file), bytes, 'valid room was rewritten');
  assert.strictEqual(fs.statSync(b2.file).mtimeMs, mtime);
  assert.deepStrictEqual(loaded.playingXIConfigurations.MI.playingXI, xi);
  assert.strictEqual(loaded.franchises.MI.impactPlayerId, os, 'valid impact player cleared');
  assert.strictEqual(loaded.franchises.MI.viceCaptainId, xi[2], 'valid VC cleared');
  assert.strictEqual(loaded.playingXIConfigurations.MI.isConfirmed, true, 'valid lineup unconfirmed');
  assert.ok(!loaded.auditLog.some(e => e.type === 'LEGACY_LINEUP_CLEANUP'));
});

await t.it('15a. path: direct reload via loadFromStorage() on a running manager', () => {
  const b3 = buildSavedRoom();
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: b3.file }));
  const inj = injectLegacy(b3);
  writeJSON(b3.file, inj.data); // file changed underneath the running manager
  rm.loadFromStorage();
  const r = rm.getRoom(b3.code);
  assert.deepStrictEqual(r.franchises.MI.playingXI, [inj.valid[0], inj.valid[1], inj.valid[2], inj.valid[3]]);
  assert.strictEqual(r.franchises.MI.impactPlayerId, null);
});

await t.it('15b. path: real server boot; cleaned lineup is what clients receive (REST + rejoin)', async () => {
  const b4 = buildSavedRoom();
  const inj = injectLegacy(b4);
  writeJSON(b4.file, inj.data);
  const srv = await startServer({ storageFile: b4.file });
  try {
    const pub = await (await fetch(`${srv.url}/api/rooms/${b4.code}`)).json();
    const expected = [inj.valid[0], inj.valid[1], inj.valid[2], inj.valid[3]];
    assert.deepStrictEqual(pub.playingXIConfigurations.MI.playingXI, expected);
    assert.deepStrictEqual(pub.franchises.MI.playingXI, expected);
    const s = await connect(srv.url);
    const j = await emit(s, 'join_room', { roomCode: b4.code, participantName: 'MI', participantToken: b4.tok.MI });
    assert.ok(j.success, j.error);
    assert.deepStrictEqual(j.room.playingXIConfigurations.MI.playingXI, expected);
    assert.match(srv.getLog(), /Legacy lineup cleanup applied to room/);
  } finally {
    await srv.stop();
  }
});

await t.it('15c. path: room written by the ORIGINAL code (pre-Stage-0.5 file) with injected legacy lineups', () => {
  const file = tempStorageFile('cleanup-orig');
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'pre-stage-0.5-room.json'), 'utf-8'));
  const code = Object.keys(data)[0];
  const r = data[code];
  const miOwn = r.franchises.MI.squad[0].id;                       // MI bought lot 1 in the fixture
  const notBought = r.playersCatalog.find(p => p.status === 'available').id;
  // The original code allowed lobby lineups of any catalogue player
  Object.assign(r.franchises.MI, { playingXI: [notBought, miOwn, miOwn], captainId: notBought, viceCaptainId: miOwn, impactPlayerId: notBought });
  delete r.playingXIConfigurations; // oldest format: config created by the loader from franchise data
  fs.writeFileSync(file, JSON.stringify(data));
  const before = protectedState(r);
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const R2 = rm.getRoom(code);
  assert.deepStrictEqual(R2.franchises.MI.playingXI, [miOwn]);
  assert.deepStrictEqual(R2.playingXIConfigurations.MI.playingXI, [miOwn]);
  assert.strictEqual(R2.franchises.MI.captainId, null);
  assert.strictEqual(R2.franchises.MI.viceCaptainId, miOwn);
  assert.strictEqual(R2.franchises.MI.impactPlayerId, null);
  // The loader used to share one array between franchise and config; cleanup must not alias them
  assert.notStrictEqual(R2.playingXIConfigurations.MI.playingXI, R2.franchises.MI.playingXI, 'arrays aliased');
  // Loading legitimately (a) migrates old rooms (adds public ids → participants/owner ids) and
  // (b) pauses this ACTIVE room and resets its countdown. Everything else must be identical.
  const strip = s => { const o = JSON.parse(s); delete o.status; delete o.currentLot; delete o.participants; delete o.owners; return JSON.stringify(o); };
  assert.strictEqual(strip(protectedState(R2)), strip(before), 'protected state changed');
  assert.strictEqual(JSON.stringify(R2.currentLot.bidHistory), JSON.stringify(r.currentLot.bidHistory), 'bid history changed');
});

await t.it('a cleanup failure leaves that room untouched and does not stop other rooms loading/cleaning', () => {
  const good = buildSavedRoom();
  const inj = injectLegacy(good);
  const broken = JSON.parse(JSON.stringify(inj.data[good.code]));
  broken.roomCode = 'BROKEN';
  // Structurally valid (passes the restore shape check) but makes the cleanup's ownership
  // lookup throw: a null catalogue entry. (A structurally invalid room is quarantined instead,
  // see tests/roomIsolation.test.js.)
  broken.playersCatalog = [null, ...broken.playersCatalog];
  broken.franchises.MI.playingXI = ['PL_001', 'PL_001'];
  const all = { BROKEN: broken, ...inj.data };
  writeJSON(good.file, all);
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: good.file }));
  const b = rm.getRoom('BROKEN');
  assert.ok(b, 'room whose cleanup failed should still load (unchanged)');
  assert.deepStrictEqual(b.franchises.MI.playingXI, ['PL_001', 'PL_001'], 'broken room was half-modified');
  assert.strictEqual(b.playersCatalog[0], null);
  assert.ok(!b.auditLog.some(e => e.type === 'LEGACY_LINEUP_CLEANUP'));
  const g = rm.getRoom(good.code);
  assert.deepStrictEqual(g.franchises.MI.playingXI, [inj.valid[0], inj.valid[1], inj.valid[2], inj.valid[3]], 'good room not cleaned');
});

await t.it('invalid keeper designation is replaced by the automatic rule; lineup positions are never filled', () => {
  const b5 = buildSavedRoom();
  const data = JSON.parse(readRaw(b5.file));
  const r = data[b5.code];
  const xi = miValidXI(r);
  // keeper points at a non-WK; XI has only 3 players → stays 3 (no auto-fill)
  Object.assign(r.franchises.MI, { playingXI: xi.slice(0, 3), wicketKeeperId: xi[2] });
  r.playingXIConfigurations.MI = { franchiseId: 'MI', playingXI: xi.slice(1, 3), wicketKeeperId: xi[0], isConfirmed: false };
  writeJSON(b5.file, data);
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: b5.file }));
  const R5 = rm.getRoom(b5.code);
  assert.strictEqual(R5.franchises.MI.playingXI.length, 3, 'lineup was auto-filled');
  assert.strictEqual(R5.franchises.MI.wicketKeeperId, xi[0], 'keeper should fall back to the WK in the XI');
  assert.deepStrictEqual(R5.playingXIConfigurations.MI.playingXI, xi.slice(1, 3));
  assert.strictEqual(R5.playingXIConfigurations.MI.wicketKeeperId, null, 'keeper not in that XI must be cleared');
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
