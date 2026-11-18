import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { RoomManager } from '../../server/roomManager.js';
import { mockIo } from '../../tests/helpers/harness.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const persistedPath = path.join(ROOT, 'server', 'data', 'persisted_rooms.json');

console.log('Testing historical room loading...');
const rm = new RoomManager(mockIo(), { storageFile: persistedPath });

// Verify all 7 active rooms
const activeCodes = ['R8VNTD', '6HBFKN', '6J8BTZ', 'K6WFQ6', 'TJ6HGV', 'LDACKW', 'A5GLQ7'];
activeCodes.forEach(code => {
  const r = rm.getRoom(code);
  assert.ok(r, `Active room ${code} must exist`);
  assert.ok(r.status === 'active' || r.status === 'paused', `Active room ${code} must be active or paused`);
  assert.strictEqual(r.playersCatalog.length, 290, `Active room ${code} must retain its exact 290 player snapshot`);
  assert.strictEqual(r.currentLot.player.name, 'Virat Kohli');
  console.log(`Active room ${code} verified: catalog=290, currentLot=${r.currentLot.player.name}, history=${r.history.length}`);
});

console.log('Testing new room creation...');
const newRoom = rm.createRoom({
  hostName: 'BrandNewHost',
  hostFranchise: 'CSK'
});
assert.strictEqual(newRoom.playersCatalog.length, 409, 'Brand new room must receive new 409 player catalogue');
console.log(`Brand new room ${newRoom.roomCode} verified: catalog=${newRoom.playersCatalog.length}`);

console.log('HISTORICAL ROOM AND NEW ROOM VERIFICATION PASSED!');
process.exit(0);
