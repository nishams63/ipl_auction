import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { RoomManager, shuffleWithinSets } from '../../server/roomManager.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testCatalogPath = path.join(ROOT, 'server', 'data', 'players_new_test.json');
const newCatalog = JSON.parse(fs.readFileSync(testCatalogPath, 'utf-8'));

import { lobbyRoom, liveRoom } from '../../tests/helpers/auctionRooms.js';
import { tempStorageFile, mockIo } from '../../tests/helpers/harness.js';

// Test skipCurrentSet with a mock room
const rm = new RoomManager(mockIo(), { storageFile: tempStorageFile('test_skip') });
const { room, code, H } = lobbyRoom(rm);

// Replace room's catalog with new test catalog
room.playersCatalog = JSON.parse(JSON.stringify(newCatalog));

// Start auction
const startRes = rm.startAuction({ roomCode: code, hostToken: H });
assert.strictEqual(startRes.success, true, 'Auction start must succeed');
assert.strictEqual(room.status, 'active');

console.log(`Auction started. First lot: #${room.currentLot.lotNumber} ${room.currentLot.player.name} (${room.currentLot.setName})`);
const firstSetKey = room.currentLot.player.categorySet;
assert.strictEqual(firstSetKey, 'HIGH-R01-BAT');

// Skip current set
console.log(`Skipping set ${firstSetKey}...`);
const skipRes = rm.skipCurrentSet({ roomCode: code, hostToken: H });
assert.strictEqual(skipRes.success, true, 'skipCurrentSet must succeed');
assert.strictEqual(skipRes.skippedCount, 6, 'Must have skipped all 6 players in HIGH-R01-BAT');

// Advance lot to present next player
rm.nextPlayer(room);
console.log(`Next lot after skip: #${room.currentLot.lotNumber} ${room.currentLot.player.name} (${room.currentLot.setName})`);
assert.strictEqual(room.currentLot.player.categorySet, 'HIGH-R01-BOWL', 'Next lot must be in HIGH-R01-BOWL');

console.log('SKIP SET BEHAVIOUR VERIFIED SUCCESSFULLY!');
