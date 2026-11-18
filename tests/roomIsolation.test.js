// Room-loading isolation: every saved room is restored independently.
// A corrupted room is QUARANTINED (kept verbatim on disk + recovery copy, not loaded) and can't
// block, delete or alter other rooms. An unreadable save file is preserved and never replaced.
// All data here lives in isolated temp files (never the real server/data/persisted_rooms.json).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, connect, emit, makeRunner, strongToken, tempStorageFile, trackManager, mockIo
} from './helpers/harness.js';

process.env.ROOM_STORAGE_FILE = process.env.ROOM_STORAGE_FILE || tempStorageFile('iso-unit');
const { RoomManager } = await import('../server/roomManager.js');
const t = makeRunner('Room Loading Isolation Suite');

// ── fixtures: real rooms with auction state, built by the RoomManager itself ──
function buildRooms(n = 3) {
  const file = tempStorageFile('iso-seed');
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const codes = [];
  const tokens = {};
  for (let k = 0; k < n; k++) {
    const tok = { CSK: strongToken(`h${k}`), MI: strongToken(`m${k}`) };
    const room = rm.createRoom({ hostName: `Host${k}`, hostToken: tok.CSK, configOverrides: { minParticipants: 2, autoAdvanceDelay: 30 } });
    rm.joinRoom({ roomCode: room.roomCode, participantName: 'H', participantToken: tok.CSK, socketId: `a${k}` });
    rm.joinRoom({ roomCode: room.roomCode, participantName: 'M', participantToken: tok.MI, socketId: `b${k}` });
    rm.selectFranchise({ roomCode: room.roomCode, participantToken: tok.CSK, franchiseId: 'CSK' });
    rm.selectFranchise({ roomCode: room.roomCode, participantToken: tok.MI, franchiseId: 'MI' });
    rm.startAuction({ roomCode: room.roomCode, hostToken: tok.CSK });
    for (let lot = 0; lot < 4 + k; lot++) { // sales to both, plus unsold lots
      const L = room.currentLot; rm.clearRoomTimer(room.roomCode);
      const buyer = lot % 3 === 0 ? 'MI' : lot % 3 === 1 ? 'CSK' : null;
      if (buyer) assert.ok(rm.placeBid({ roomCode: room.roomCode, participantToken: tok[buyer], franchiseId: buyer, bidAmount: L.nextValidBid, expectedVersion: L.stateVersion }).success);
      rm.closeCurrentLot(room); rm.nextPlayer(room);
    }
    const L = room.currentLot; rm.clearRoomTimer(room.roomCode);
    rm.placeBid({ roomCode: room.roomCode, participantToken: tok.MI, franchiseId: 'MI', bidAmount: L.nextValidBid, expectedVersion: L.stateVersion });
    rm.pauseAuction({ roomCode: room.roomCode, hostToken: tok.CSK }); // paused: restart recovery leaves it alone
    codes.push(room.roomCode);
    tokens[room.roomCode] = tok;
  }
  rm.shutdown();
  return { saved: JSON.parse(fs.readFileSync(file, 'utf-8')), codes, tokens };
}
const seed = buildRooms(3);
const fresh = () => JSON.parse(JSON.stringify(seed.saved));

// Everything restoration must preserve for a valid room (exact JSON)
const auctionState = r => JSON.stringify({
  squads: Object.fromEntries(Object.entries(r.franchises).map(([k, f]) => [k, f.squad])),
  purses: Object.fromEntries(Object.entries(r.franchises).map(([k, f]) => [k, [f.initialPurse, f.remainingPurse, f.totalSpent]])),
  owners: Object.fromEntries(Object.entries(r.franchises).map(([k, f]) => [k, [f.ownerToken, f.ownerId, f.ownerName, f.isClaimed]])),
  catalog: r.playersCatalog, history: r.history, allBids: r.allBids, currentLot: r.currentLot,
  evaluation: r.evaluationResults, config: r.config, status: r.status, idx: r.currentPlayerIndex,
  participants: r.participants instanceof Map ? [...r.participants.entries()] : r.participants
});
const writeFile = (file, data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
const load = file => trackManager(new RoomManager(mockIo(), { storageFile: file }));
const recoveryCopies = file => fs.readdirSync(path.dirname(file)).filter(f => f.startsWith(path.basename(file) + '.quarantined-'));

// Corruptions of different kinds
const CORRUPT = {
  BADNUL: null,
  BADSTR: 'not a room',
  BADARR: [1, 2, 3],
  BADFRN: (() => { const r = fresh()[seed.codes[0]]; delete r.franchises; return r; })(),
  BADPAR: (() => { const r = fresh()[seed.codes[0]]; r.participants = 5; return r; })(),
  BADSQD: (() => { const r = fresh()[seed.codes[0]]; r.franchises.MI.squad = 'oops'; return r; })(),
  BADSTA: (() => { const r = fresh()[seed.codes[0]]; r.status = 'exploded'; return r; })(),
  BADCAT: (() => { const r = fresh()[seed.codes[0]]; r.playersCatalog = 12345; return r; })()
};

// ── tests ─────────────────────────────────────────────────────
await t.it('1 + 10. multiple valid rooms all load with their auction and participant data intact', () => {
  const file = tempStorageFile('iso1');
  writeFile(file, fresh());
  const rm = load(file);
  assert.strictEqual(rm.rooms.size, 3);
  assert.strictEqual(rm.quarantinedRooms.size, 0);
  for (const code of seed.codes) {
    const r = rm.getRoom(code);
    assert.ok(r, `${code} missing`);
    assert.strictEqual(auctionState(r), auctionState(seed.saved[code]), `${code} data changed`);
    assert.ok(r.franchises.MI.squad.length > 0 && r.allBids.length > 0, 'fixture should have purchases and bids');
  }
});

await t.it('2. a corrupted room does not block valid rooms after it (corrupted first and in the middle)', () => {
  const file = tempStorageFile('iso2');
  const v = fresh();
  writeFile(file, { BADPAR: CORRUPT.BADPAR, [seed.codes[0]]: v[seed.codes[0]], BADSQD: CORRUPT.BADSQD, [seed.codes[1]]: v[seed.codes[1]], [seed.codes[2]]: v[seed.codes[2]] });
  const rm = load(file);
  for (const code of seed.codes) assert.ok(rm.getRoom(code), `valid room ${code} after a corrupted room did not load`);
  assert.deepStrictEqual([...rm.quarantinedRooms.keys()].sort(), ['BADPAR', 'BADSQD']);
  assert.strictEqual(rm.getRoom('BADPAR'), null, 'corrupted room must not be served');
});

await t.it('3 + 4. corrupted rooms are never deleted: kept verbatim in the save file (also after later saves) and in a recovery copy', () => {
  const file = tempStorageFile('iso3');
  const v = fresh();
  const data = { ...CORRUPT, ...v };
  writeFile(file, data);
  const rm = load(file);
  rm.createRoom({ hostName: 'New', hostToken: strongToken('new') }); // forces a full save
  rm.shutdown();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  for (const [code, original] of Object.entries(CORRUPT)) {
    assert.ok(code in onDisk, `${code} was deleted by a later save`);
    assert.strictEqual(JSON.stringify(onDisk[code]), JSON.stringify(original), `${code} was altered on disk`);
  }
  // per-room recovery copies with the exact original content
  const copies = recoveryCopies(file);
  assert.strictEqual(copies.length, Object.keys(CORRUPT).length, `expected one recovery copy per room, got ${copies}`);
  for (const [code, original] of Object.entries(CORRUPT)) {
    const name = copies.find(c => c.includes(`.quarantined-${code}-`));
    assert.ok(name, `no recovery copy for ${code}`);
    const copy = JSON.parse(fs.readFileSync(path.join(path.dirname(file), name), 'utf-8'));
    assert.strictEqual(JSON.stringify(copy[code]), JSON.stringify(original), `recovery copy for ${code} differs`);
  }
});

await t.it('5. every kind of malformed room is isolated: valid rooms load, each malformed room is quarantined', () => {
  for (const [code, bad] of Object.entries(CORRUPT)) {
    const file = tempStorageFile('iso5');
    writeFile(file, { ...fresh(), [code]: bad });
    const rm = load(file);
    assert.strictEqual(rm.rooms.size, 3, `${code}: valid rooms affected`);
    assert.deepStrictEqual([...rm.quarantinedRooms.keys()], [code], `${code}: not quarantined`);
    for (const c of seed.codes) assert.strictEqual(auctionState(rm.getRoom(c)), auctionState(seed.saved[c]), `${code}: valid room ${c} altered`);
  }
});

await t.it('6. a cleanup failure in one room does not affect another room (legacy cleanup still runs elsewhere)', () => {
  const file = tempStorageFile('iso6');
  const v = fresh();
  const legacyCode = seed.codes[1];
  const notBought = v[legacyCode].playersCatalog.find(p => p.status === 'available').id;
  const miOwned = v[legacyCode].franchises.MI.squad[0].id;
  v[legacyCode].franchises.MI.playingXI = [notBought, miOwned];
  v[legacyCode].playingXIConfigurations.MI.playingXI = [notBought, miOwned];
  const cleanupBreaker = JSON.parse(JSON.stringify(v[seed.codes[0]]));
  cleanupBreaker.playersCatalog = [null, ...cleanupBreaker.playersCatalog]; // shape OK, cleanup throws
  cleanupBreaker.franchises.MI.playingXI = ['X1', 'X1'];
  writeFile(file, { CLNFAIL: cleanupBreaker, ...v });
  const rm = load(file);
  const broken = rm.getRoom('CLNFAIL');
  assert.ok(broken, 'room whose cleanup failed still loads');
  assert.deepStrictEqual(broken.franchises.MI.playingXI, ['X1', 'X1'], 'failed cleanup must leave the room unchanged');
  assert.deepStrictEqual(rm.getRoom(legacyCode).franchises.MI.playingXI, [miOwned], 'legacy room after it was not cleaned');
  assert.strictEqual(auctionState(rm.getRoom(seed.codes[2])), auctionState(seed.saved[seed.codes[2]]));
});

await t.it('7. an unreadable / malformed save file is preserved byte-for-byte and never replaced', () => {
  const variants = {
    'truncated JSON': '{"ROOM1": {"status": "lobby", "franch',
    'top-level array': '[{"roomCode":"X"}]',
    'top-level null': 'null',
    'empty file': '',
    'binary garbage': Buffer.from([0xff, 0xfe, 0x00, 0x13, 0x37, 0x80, 0x81]).toString('latin1')
  };
  for (const [label, content] of Object.entries(variants)) {
    const file = tempStorageFile('iso7');
    fs.writeFileSync(file, content, 'latin1');
    const before = fs.readFileSync(file);
    const rm = load(file);
    assert.strictEqual(rm.rooms.size, 0, label);
    assert.strictEqual(rm.writesDisabled, true, `${label}: writes not disabled`);
    assert.strictEqual(rm.storageStatus.loadError, 'UNREADABLE_SAVE_FILE');
    // The server keeps working in memory, but nothing may replace the original file
    const room = rm.createRoom({ hostName: 'Live', hostToken: strongToken('live') });
    assert.ok(rm.getRoom(room.roomCode), `${label}: server unusable`);
    rm.saveToStorage(); rm.shutdown();
    assert.ok(fs.readFileSync(file).equals(before), `${label}: original save file was modified`);
    const copyName = rm.storageStatus.preservedCopy;
    assert.ok(copyName, `${label}: no preserved copy`);
    assert.ok(fs.readFileSync(path.join(path.dirname(file), copyName)).equals(before), `${label}: preserved copy differs`);
  }
});

await t.it('8. an already-valid save file is left byte-identical (no rewrite on load)', () => {
  const file = tempStorageFile('iso8');
  writeFile(file, fresh());
  const bytes = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  load(file).shutdown();
  assert.ok(fs.readFileSync(file).equals(bytes));
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
  assert.strictEqual(recoveryCopies(file).length, 0);
});

await t.it('8b. a file containing a quarantined room is not rewritten just because of the quarantine', () => {
  const file = tempStorageFile('iso8b');
  writeFile(file, { BADSTA: CORRUPT.BADSTA, ...fresh() });
  const bytes = fs.readFileSync(file);
  load(file).shutdown();
  assert.ok(fs.readFileSync(file).equals(bytes), 'main file rewritten on load');
  assert.strictEqual(recoveryCopies(file).length, 1);
});

await t.it('repeated loading is idempotent: no new recovery copies, main file unchanged', () => {
  const file = tempStorageFile('iso-rep');
  writeFile(file, { BADSTA: CORRUPT.BADSTA, BADNUL: null, ...fresh() });
  load(file).shutdown();
  const copies1 = recoveryCopies(file).sort();
  const bytes = fs.readFileSync(file);
  load(file).shutdown();
  load(file).shutdown();
  assert.deepStrictEqual(recoveryCopies(file).sort(), copies1, 'repeat loads created extra copies');
  assert.ok(fs.readFileSync(file).equals(bytes));
});

await t.it('new rooms never reuse a quarantined room code', () => {
  const file = tempStorageFile('iso-code');
  writeFile(file, { BADSTA: CORRUPT.BADSTA });
  const rm = load(file);
  const seq = ['BADSTA', 'BADSTA', 'OKCODE'];
  rm.generateRoomCode = () => seq.shift();
  const room = rm.createRoom({ hostName: 'X', hostToken: strongToken('x') });
  assert.strictEqual(room.roomCode, 'OKCODE');
  rm.shutdown();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(JSON.stringify(onDisk.BADSTA), JSON.stringify(CORRUPT.BADSTA));
});

await t.it('9 + mixture: valid + corrupted + legacy rooms in one file on a real server boot', async () => {
  const file = tempStorageFile('iso-mix');
  const v = fresh();
  const legacyCode = seed.codes[2];
  const notBought = v[legacyCode].playersCatalog.find(p => p.status === 'available').id;
  const miOwned = v[legacyCode].franchises.MI.squad[0].id;
  Object.assign(v[legacyCode].franchises.MI, { playingXI: [notBought, miOwned, miOwned], captainId: notBought });
  delete v[legacyCode].playingXIConfigurations; // oldest format
  const mixed = { BADPAR: CORRUPT.BADPAR, [seed.codes[0]]: v[seed.codes[0]], BADNUL: null, [legacyCode]: v[legacyCode], [seed.codes[1]]: v[seed.codes[1]] };
  writeFile(file, mixed);
  const srv = await startServer({ storageFile: file });
  try {
    for (const code of seed.codes) {
      const r = await fetch(`${srv.url}/api/rooms/${code}`);
      assert.strictEqual(r.status, 200, `valid room ${code} not served`);
    }
    assert.strictEqual((await fetch(`${srv.url}/api/rooms/BADPAR`)).status, 404, 'quarantined room served');
    const legacy = await (await fetch(`${srv.url}/api/rooms/${legacyCode}`)).json();
    assert.deepStrictEqual(legacy.franchises.MI.playingXI, [miOwned], 'legacy cleanup did not run');
    assert.strictEqual(legacy.franchises.MI.captainId, null);
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.deepStrictEqual([...health.storage.quarantinedRooms].sort(), ['BADNUL', 'BADPAR']);
    assert.ok(!JSON.stringify(health).includes('/'.repeat(1) + 'tmp'), 'server path leaked in health');
    // a player can still rejoin a valid room
    const s = await connect(srv.url);
    const j = await emit(s, 'join_room', { roomCode: seed.codes[0], participantName: 'M', participantToken: seed.tokens[seed.codes[0]].MI });
    assert.ok(j.success, j.error);
    assert.strictEqual(j.participant.franchiseId, 'MI');
    const bad = await emit(s, 'join_room', { roomCode: 'BADPAR', participantName: 'M', participantToken: strongToken('z') });
    assert.strictEqual(bad.success, false);
    assert.match(srv.getLog(), /Room BADPAR could not be restored and was QUARANTINED/);
    assert.match(srv.getLog(), /Room BADNUL could not be restored/);
  } finally {
    await srv.stop();
  }
  // After the server ran (legacy cleanup saved the file), corrupted rooms are still on disk verbatim
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(JSON.stringify(onDisk.BADPAR), JSON.stringify(CORRUPT.BADPAR));
  assert.ok('BADNUL' in onDisk && onDisk.BADNUL === null);
  // seed.codes[1] was untouched while the server ran: must be identical
  assert.strictEqual(auctionState(onDisk[seed.codes[1]]), auctionState(seed.saved[seed.codes[1]]), 'untouched valid room altered on disk');
  // seed.codes[0] was legitimately rejoined in this test, which records the player's new socket id;
  // everything else (squads, purses, sales, bids, results, config, participants) must be identical
  const noSockets = r => JSON.parse(JSON.stringify({ ...r, participants: (r.participants || []).map(([tk, p]) => [tk, { ...p, socketId: null }]) }));
  assert.strictEqual(auctionState(noSockets(onDisk[seed.codes[0]])), auctionState(noSockets(seed.saved[seed.codes[0]])), 'rejoined valid room altered beyond its socket id');
});

await t.it('unreadable save file over a real server: health reports it, server still serves new rooms, file untouched', async () => {
  const file = tempStorageFile('iso-srv-bad');
  fs.writeFileSync(file, '{ this is not json');
  const before = fs.readFileSync(file);
  const srv = await startServer({ storageFile: file });
  try {
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.strictEqual(health.storage.loadError, 'UNREADABLE_SAVE_FILE');
    assert.match(health.storage.preservedCopy, /\.unreadable-\d+\.bak$/);
    const r = await fetch(`${srv.url}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostName: 'H', hostToken: strongToken('h') }) });
    assert.strictEqual(r.status, 200, 'cannot create rooms after an unreadable save file');
  } finally {
    await srv.stop(); // SIGTERM → flush: must still not touch the file
  }
  assert.ok(fs.readFileSync(file).equals(before), 'original unreadable file was modified');
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
