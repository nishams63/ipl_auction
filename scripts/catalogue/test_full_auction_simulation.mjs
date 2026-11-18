import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { RoomManager, shuffleWithinSets } from '../../server/roomManager.js';
import { calculateNextBid, validateBid, reserveFloorLakh } from '../../server/auctionEngine.js';
import { toLakh, fromLakh, nextBidLakh } from '../../server/money.js';
import { IPL_FRANCHISES } from '../../server/data/franchises.js';
import { lobbyRoom, liveRoom, bid } from '../../tests/helpers/auctionRooms.js';
import { tempStorageFile, mockIo } from '../../tests/helpers/harness.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testCatalogPath = path.join(ROOT, 'server', 'data', 'players_new_test.json');
const newCatalog = JSON.parse(fs.readFileSync(testCatalogPath, 'utf-8'));

console.log(`Starting complete 409-lot auction simulation...`);

const storage = tempStorageFile('test_full_sim');
const rm = new RoomManager(mockIo(), { storageFile: storage });
const { room, code, H, A } = lobbyRoom(rm);

// Replace room's catalog with new test catalog BEFORE auction starts
room.playersCatalog = JSON.parse(JSON.stringify(newCatalog));

// Start auction cleanly
const startRes = rm.startAuction({ roomCode: code, hostToken: H });
assert.strictEqual(startRes.success, true);

const seen = new Set();
let lots = 0;
let guard = 0;

while (room.status === 'active' && guard++ < 800) {
  const lot = room.currentLot;
  assert.ok(lot, 'lot must exist while status is active');
  assert.ok(!seen.has(lot.player.id), `player ${lot.player.id} (${lot.player.name}) presented twice!`);
  seen.add(lot.player.id);
  lots++;

  // Every 25 lots, skip the current set
  if (lots % 25 === 0) {
    rm.skipCurrentSet({ roomCode: code, hostToken: H });
    continue;
  }

  // Alternate bids between CSK and MI if valid
  const fid = lots % 3 === 0 ? 'CSK' : 'MI';
  const token = fid === 'CSK' ? H : A;
  const validation = validateBid({ room, franchiseId: fid, expectedVersion: lot.stateVersion });
  if (validation.valid) {
    bid(rm, room, token, fid);
  }

  rm.closeCurrentLot(room);
  rm.nextPlayer(room);
}

assert.strictEqual(room.status, 'completed', `Room must be completed, got: ${room.status}`);
assert.strictEqual(room.playersCatalog.length, 409, 'Catalog length must be 409');
assert.ok(room.playersCatalog.every(p => ['sold', 'unsold', 'SKIPPED'].includes(p.status)), 'unresolved players remain');

const ids = room.history.map(h => h.player.id);
assert.strictEqual(new Set(ids).size, ids.length, 'a player has two results in history');
assert.strictEqual(ids.length, room.playersCatalog.length, `history length (${ids.length}) must equal catalog length (${room.playersCatalog.length})`);

const owner = new Map();
for (const [fid, f] of Object.entries(room.franchises)) {
  for (const p of f.squad) {
    assert.ok(!owner.has(p.id), `${p.id} in two squads`);
    owner.set(p.id, fid);
  }
  const spent = f.squad.reduce((s, p) => s + toLakh(p.boughtPrice), 0);
  assert.strictEqual(toLakh(f.remainingPurse) + spent, 12000, `${fid} purse must reconcile to ₹120 Cr exactly`);
  assert.ok(f.squad.length <= 25, `${fid} squad exceeds max (25)`);
  assert.ok(f.squad.filter(p => p.isOverseas).length <= 8, `${fid} overseas players exceed max (8)`);
}

for (const p of room.playersCatalog) {
  if (p.status === 'sold') assert.strictEqual(owner.get(p.id), p.soldTo, `${p.id}: sale record does not match squad`);
  else assert.ok(!owner.has(p.id), `${p.id}: owned but not sold`);
}

assert.ok(owner.size > 20, `Must have sold at least 20 players, sold ${owner.size}`);

console.log(`Simulation finished successfully!`);
console.log(`  Total lots processed: ${lots}`);
console.log(`  History entries: ${room.history.length}`);
console.log(`  Players sold: ${owner.size}`);
console.log(`  Players unsold: ${room.playersCatalog.filter(p => p.status === 'unsold').length}`);
console.log(`  Players skipped: ${room.playersCatalog.filter(p => p.status === 'SKIPPED').length}`);
console.log(`  All squads valid, all purses reconciled to ₹120 Cr!`);

process.exit(0);
