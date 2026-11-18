// JSON-mode restore: re-linking lot/history players to the catalogue (fixes a latent bug where a
// lot restored mid-auction and then sold updated only a COPY of the player, so the buyer could
// not field the player), repair of sale records written by that bug, audit seq back-fill, and
// refusal to silently merge duplicate participant entries.
import assert from 'node:assert';
import fs from 'node:fs';
import { makeRunner, trackManager, mockIo, tempStorageFile } from './helpers/harness.js';
import { liveRoom, bid, sellCurrent } from './helpers/auctionRooms.js';

const { RoomManager } = await import('../server/roomManager.js');
const t = makeRunner('Restore Re-link Suite (JSON storage)');
const make = file => trackManager(new RoomManager(mockIo(), { storageFile: file }));
const readFile = file => JSON.parse(fs.readFileSync(file, 'utf-8'));

await t.it('R1: restart mid-lot → resume → sell: the catalogue sale record is set and the buyer can field the player', () => {
  const file = tempStorageFile('rl1');
  const rm = make(file);
  const { code, H, A } = liveRoom(rm);
  const room = rm.getRoom(code);
  bid(rm, room, A, 'MI');
  const pid = room.currentLot.player.id;
  rm.flushStorage(); rm.shutdown();

  const rm2 = make(file);
  const r2 = rm2.getRoom(code);
  assert.strictEqual(r2.status, 'paused');
  assert.strictEqual(r2.currentLot.player, r2.playersCatalog[r2.currentPlayerIndex], 'restored lot player is a detached copy');
  rm2.joinRoom({ roomCode: code, participantName: 'Host', participantToken: H, socketId: 'h2' });
  rm2.joinRoom({ roomCode: code, participantName: 'Alice', participantToken: A, socketId: 'a2' });
  assert.ok(rm2.resumeAuction({ roomCode: code, hostToken: H }).success);
  rm2.closeCurrentLot(r2);
  const cat = r2.playersCatalog.find(p => p.id === pid);
  assert.strictEqual(cat.status, 'sold', 'catalogue entry not marked sold');
  assert.strictEqual(cat.soldTo, 'MI');
  const res = rm2.updatePlayingXI({ roomCode: code, participantToken: A, franchiseId: 'MI', playingXI: [pid], isConfirmed: false });
  assert.ok(res.success, `buyer cannot field the player: ${res.error}`);
});

await t.it('R2: a save file already damaged by that bug is repaired on load (sale record restored from the lot result) and audited', () => {
  const file = tempStorageFile('rl2');
  const rm = make(file);
  const { code, A } = liveRoom(rm);
  sellCurrent(rm, rm.getRoom(code), A, 'MI');
  rm.flushStorage(); rm.shutdown();
  // reproduce the damage: catalogue says in_auction, history copy + squad say sold to MI
  const data = readFile(file);
  const pid = data[code].history[0].player.id;
  const cat = data[code].playersCatalog.find(p => p.id === pid);
  Object.assign(cat, { status: 'in_auction', soldTo: null, soldPrice: null });
  fs.writeFileSync(file, JSON.stringify(data));

  const rm2 = make(file);
  const r2 = rm2.getRoom(code);
  const fixed = r2.playersCatalog.find(p => p.id === pid);
  assert.strictEqual(fixed.status, 'sold');
  assert.strictEqual(fixed.soldTo, 'MI');
  assert.strictEqual(r2.history[0].player, fixed, 'history not re-linked');
  assert.ok(r2.auditLog.some(e => e.type === 'RESTORE_SALE_RECORD_REPAIRED' && e.message.includes(pid)));
  assert.ok(rm2.getOwnedPlayers(r2, 'MI').has(pid), 'buyer still does not own the player');
  // persisted, and a second load changes nothing more
  rm2.flushStorage(); rm2.shutdown();
  const rm3 = make(file);
  const r3 = rm3.getRoom(code);
  assert.strictEqual(r3.auditLog.filter(e => e.type === 'RESTORE_SALE_RECORD_REPAIRED').length, 1, 'repair is not idempotent');
});

await t.it('R3: no repair without evidence — a "sold" copy whose buyer squad lacks the player is left as it was', () => {
  const file = tempStorageFile('rl3');
  const rm = make(file);
  const { code, A } = liveRoom(rm);
  sellCurrent(rm, rm.getRoom(code), A, 'MI');
  rm.flushStorage(); rm.shutdown();
  const data = readFile(file);
  const pid = data[code].history[0].player.id;
  Object.assign(data[code].playersCatalog.find(p => p.id === pid), { status: 'in_auction', soldTo: null, soldPrice: null });
  data[code].franchises.MI.squad = data[code].franchises.MI.squad.filter(p => p.id !== pid);
  fs.writeFileSync(file, JSON.stringify(data));
  const rm2 = make(file);
  const r2 = rm2.getRoom(code);
  assert.strictEqual(r2.playersCatalog.find(p => p.id === pid).status, 'in_auction', 'catalogue changed without evidence');
  assert.strictEqual(r2.history[0].player.status, 'sold', 'the differing copy was discarded');
  assert.notStrictEqual(r2.history[0].player, r2.playersCatalog.find(p => p.id === pid));
  assert.ok(!r2.auditLog.some(e => e.type === 'RESTORE_SALE_RECORD_REPAIRED'));
});

await t.it('R4: legacy audit entries without seq are numbered oldest-first; new entries continue the sequence', () => {
  const file = tempStorageFile('rl4');
  const rm = make(file);
  const { code } = liveRoom(rm);
  rm.flushStorage(); rm.shutdown();
  const data = readFile(file);
  for (const e of data[code].auditLog) delete e.seq;
  delete data[code].auditSeq;
  const n = data[code].auditLog.length;
  fs.writeFileSync(file, JSON.stringify(data));
  const rm2 = make(file);
  const r2 = rm2.getRoom(code);
  const seqs = r2.auditLog.map(e => e.seq);
  assert.strictEqual(seqs[seqs.length - 1], 1, 'oldest entry should be seq 1');
  assert.ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] - 1), `not consecutive: ${seqs.join(',')}`);
  assert.ok(r2.auditSeq >= n);
  const before = r2.auditSeq;
  rm2.pauseAuction({ roomCode: code, hostToken: [...r2.participants.keys()][0] });
  assert.strictEqual(r2.auditLog[0].seq, r2.auditSeq);
  assert.ok(r2.auditSeq >= before);
});

await t.it('R5: two participant entries with the same token are not silently merged — the room is quarantined, others load', () => {
  const file = tempStorageFile('rl5');
  const rm = make(file);
  const { code } = liveRoom(rm);
  const other = rm.createRoom({ hostName: 'Other', hostToken: 'usr_other_host_token_0001' });
  rm.flushStorage(); rm.shutdown();
  const data = readFile(file);
  data[code].participants.push([data[code].participants[0][0], { ...data[code].participants[0][1], name: 'Impostor' }]);
  fs.writeFileSync(file, JSON.stringify(data));
  const rm2 = make(file);
  assert.strictEqual(rm2.getRoom(code), null, 'room with duplicate tokens was loaded');
  assert.ok(rm2.quarantinedRooms.has(code));
  assert.ok(rm2.getRoom(other.roomCode), 'unrelated room not loaded');
  rm2.saveToStorage();
  assert.strictEqual(readFile(file)[code].participants.length, 3, 'quarantined room not preserved verbatim');
});

process.exit(await t.finish());
