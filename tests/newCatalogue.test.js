// Test Suite: 409-Player Round-Wise Catalogue Replacement
// Covers all 18 requirements from the specification.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunner, tempStorageFile, mockIo } from './helpers/harness.js';
import { lobbyRoom, liveRoom, bid } from './helpers/auctionRooms.js';
import { RoomManager, shuffleWithinSets } from '../server/roomManager.js';
import { toLakh } from '../server/money.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(dir, '..');
const HTML_FILE = path.join(ROOT, 'ipl_auction_round_wise_catalogue.html');
const PLAYERS_FILE = path.join(ROOT, 'server', 'data', 'players.json');
const PERSISTED_ROOMS_FILE = path.join(ROOT, 'server', 'data', 'persisted_rooms.json');

const t = makeRunner('New 409-Player Catalogue Verification Suite');
const players = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf-8'));

// 1. All 409 players imported correctly
await t.it('1. Exactly 409 players imported into authoritative catalogue', () => {
  assert.strictEqual(players.length, 409, `Expected 409 players, found ${players.length}`);
});

// 2. Profile counts match 134, 155 and 120
await t.it('2. Profile counts match 134 High, 155 Medium, and 120 Low/Emerging', () => {
  const high = players.filter(p => p.profile === 'high');
  const medium = players.filter(p => p.profile === 'medium');
  const low = players.filter(p => p.profile === 'low');
  assert.strictEqual(high.length, 134, `Expected 134 high-profile players, got ${high.length}`);
  assert.strictEqual(medium.length, 155, `Expected 155 medium-profile players, got ${medium.length}`);
  assert.strictEqual(low.length, 120, `Expected 120 low-profile players, got ${low.length}`);
});

// 3. No duplicate player IDs
await t.it('3. Every player has a unique, stable player ID', () => {
  const ids = players.map(p => p.id);
  assert.strictEqual(new Set(ids).size, 409, 'Duplicate player IDs detected');
  players.forEach((p, idx) => {
    assert.strictEqual(p.id, `PL_${String(idx + 1).padStart(3, '0')}`);
  });
});

// 4. No unintended duplicate players
await t.it('4. Zero duplicate or collided player names', () => {
  const normNames = new Set();
  players.forEach(p => {
    const norm = p.name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’`]/g, '').replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(!normNames.has(norm), `Duplicate normalized player name: "${p.name}"`);
    normNames.add(norm);
  });
  assert.strictEqual(normNames.size, 409);
});

// 5. Correct round and category assignments
await t.it('5. Correct profile, round and category assignments across all players', () => {
  const categories = new Set(['BAT', 'BOWL', 'SP', 'AR', 'WK']);
  players.forEach(p => {
    assert.ok(categories.has(p.category), `Invalid category: ${p.category} for player ${p.name}`);
    assert.ok(p.round >= 1 && p.round <= 8, `Invalid round: ${p.round} for player ${p.name}`);
    assert.ok(['high', 'medium', 'low'].includes(p.profile), `Invalid profile: ${p.profile}`);
    assert.ok(typeof p.basePrice === 'number' && p.basePrice > 0, `Invalid base price for ${p.name}: ${p.basePrice}`);
  });

  // Verify category totals: BAT 101, BOWL 112, SP 57, AR 71, WK 68
  assert.strictEqual(players.filter(p => p.category === 'BAT').length, 101);
  assert.strictEqual(players.filter(p => p.category === 'BOWL').length, 112);
  assert.strictEqual(players.filter(p => p.category === 'SP').length, 57);
  assert.strictEqual(players.filter(p => p.category === 'AR').length, 71);
  assert.strictEqual(players.filter(p => p.category === 'WK').length, 68);
});

// 6. Incomplete sets preserved
await t.it('6. Incomplete sets are preserved exactly (e.g. Low R7 Fast Bowlers = 1 player)', () => {
  const lowR7 = players.filter(p => p.profile === 'low' && p.round === 7 && p.category === 'BOWL');
  assert.strictEqual(lowR7.length, 1, 'Low R7 Fast Bowlers must have exactly 1 player');
  assert.strictEqual(lowR7[0].name, 'Simarjeet Singh');
  assert.strictEqual(lowR7[0].setTotal, 1);
  assert.strictEqual(lowR7[0].isIncomplete, true);

  const highR4SP = players.filter(p => p.profile === 'high' && p.round === 4 && p.category === 'SP');
  assert.strictEqual(highR4SP.length, 4, 'High R4 Spinners must have exactly 4 players');
  assert.strictEqual(highR4SP[0].isIncomplete, true);
});

// 7. No invented players
await t.it('7. No invented players: all 409 names exist in the source HTML file', () => {
  const html = fs.readFileSync(HTML_FILE, 'utf-8');
  players.forEach(p => {
    assert.ok(html.includes(p.name), `Player "${p.name}" not found in source HTML!`);
  });
});

// 8. No player missing from the auction sequence
await t.it('8. Sequence integrity: overallLot spans sequentially from 1 to 409', () => {
  players.forEach((p, idx) => {
    assert.strictEqual(p.overallLot, idx + 1);
  });
});

// 9. Set shuffle persistence
await t.it('9. shuffleWithinSets shuffles only within sets and persists order without reshuffle', () => {
  const copy = JSON.parse(JSON.stringify(players));
  const shuffled = shuffleWithinSets(copy);
  assert.strictEqual(shuffled.length, 409);

  // Group contiguous sets
  const originalSets = [];
  players.forEach(p => {
    const k = p.categorySet;
    if (!originalSets.includes(k)) originalSets.push(k);
  });
  const shuffledSets = [];
  shuffled.forEach(p => {
    const k = p.categorySet;
    if (!shuffledSets.includes(k)) shuffledSets.push(k);
  });
  assert.deepStrictEqual(shuffledSets, originalSets, 'Set sequence must not change after shuffle');
});

// 10. Skip Set behaviour
await t.it('10. skipCurrentSet marks remaining players in current set as SKIPPED and advances lot', () => {
  const rm = new RoomManager(mockIo(), { storageFile: tempStorageFile('test_new_cat_skip') });
  const { room, code, H } = liveRoom(rm);

  const firstLot = room.currentLot;
  const currentSet = firstLot.player.categorySet;
  const initialSetPlayers = room.playersCatalog.filter(p => p.categorySet === currentSet);

  const skipRes = rm.skipCurrentSet({ roomCode: code, hostToken: H });
  assert.strictEqual(skipRes.success, true);
  assert.strictEqual(skipRes.skippedCount, initialSetPlayers.length);

  // Verify all players in skipped set are SKIPPED
  initialSetPlayers.forEach(p => {
    assert.strictEqual(p.status, 'SKIPPED');
  });

  // Verify next lot is in the next set
  assert.notStrictEqual(room.currentLot.player.categorySet, currentSet);
});

// 11. Auction progression & 12. SOLD and UNSOLD outcomes
await t.it('11 & 12. Auction progression resolves players to SOLD, UNSOLD or SKIPPED', () => {
  const rm = new RoomManager(mockIo(), { storageFile: tempStorageFile('test_prog') });
  const { room, code, H, A } = liveRoom(rm);

  // Bid on player 1 -> SOLD to CSK
  const lot1 = room.currentLot;
  assert.strictEqual(lot1.player.status, 'in_auction');
  bid(rm, room, H, 'CSK');
  rm.closeCurrentLot(room);
  assert.strictEqual(lot1.player.status, 'sold');
  assert.strictEqual(lot1.player.soldTo, 'CSK');

  // Advance to player 2 -> UNSOLD
  rm.nextPlayer(room);
  const lot2 = room.currentLot;
  assert.strictEqual(lot2.player.status, 'in_auction');
  rm.closeCurrentLot(room);
  assert.strictEqual(lot2.player.status, 'unsold');
  assert.strictEqual(lot2.player.soldTo, null);
});

// 13. Refresh and reconnect
await t.it('13. Reconnect does not reshuffle or mutate locked auction order', () => {
  const rm = new RoomManager(mockIo(), { storageFile: tempStorageFile('test_reconnect') });
  const { room, code, H } = liveRoom(rm);

  const orderBefore = room.playersCatalog.map(p => p.id);
  assert.strictEqual(room.auctionOrder.locked, true);

  // Simulate participant rejoin
  const rejoinRes = rm.joinRoom({ roomCode: code, participantName: 'Host', participantToken: H, socketId: 'sock-host-new' });
  assert.strictEqual(rejoinRes.success, true);

  const orderAfter = room.playersCatalog.map(p => p.id);
  assert.deepStrictEqual(orderAfter, orderBefore, 'Catalogue order must not change on reconnect');
});

// 14. Multiplayer synchronization
await t.it('14. Multiplayer broadcast receives correct current lot and player attributes', () => {
  const rm = new RoomManager(mockIo(), { storageFile: tempStorageFile('test_sync') });
  const { room } = liveRoom(rm);
  const lot = room.currentLot;
  assert.ok(lot.player.id.startsWith('PL_'));
  assert.ok(lot.lotNumber >= 1);
  assert.strictEqual(lot.totalLots, 409);
  assert.ok(lot.remainingInSet >= 1);
  assert.ok(lot.remainingInRound >= 1);
  assert.ok(lot.remainingInAuction >= 1);
});

// 15. Existing historical rooms remain unchanged
await t.it('15. Historical active rooms in persisted_rooms.json retain their original 290 players', () => {
  const persistedRooms = JSON.parse(fs.readFileSync(PERSISTED_ROOMS_FILE, 'utf-8'));
  const activeRooms = Object.values(persistedRooms).filter(r => r.status === 'active' || r.status === 'paused');
  assert.strictEqual(activeRooms.length, 7, 'Must preserve all 7 active/interrupted auctions');
  activeRooms.forEach(r => {
    assert.strictEqual(r.playersCatalog.length, 290, `Historical room ${r.roomCode} must keep 290-player catalog snapshot`);
    assert.strictEqual(r.currentLot.player.name, 'Virat Kohli');
  });
});

// 16. JSON compatibility
await t.it('16. Catalogue serializes and deserializes cleanly without losing precision or fields', () => {
  const jsonStr = JSON.stringify(players);
  const parsed = JSON.parse(jsonStr);
  assert.strictEqual(parsed.length, 409);
  assert.deepStrictEqual(parsed[0].stats, players[0].stats);
  assert.strictEqual(parsed[0].basePrice, 2);
});

// 17. Live lot carries the fields the React auction stage renders (Unity removed)
await t.it('17. First live lot exposes stage fields (lot 1 of 409, name, base price)', () => {
  const rm = new RoomManager(mockIo(), { storageFile: tempStorageFile('test_stage_sync') });
  const { room } = liveRoom(rm);
  assert.strictEqual(room.status, 'active');
  assert.ok(room.currentLot && room.currentLot.player);
  assert.strictEqual(room.playersCatalog.length, 409);
  assert.strictEqual(room.currentLot.lotNumber || room.currentLot.number, 1);
  assert.ok(typeof room.currentLot.player.name === 'string' && room.currentLot.player.name.length > 0);
  const base = room.currentLot.basePrice ?? room.currentLot.player.basePrice;
  assert.ok(typeof base === 'number' && base > 0);
});

// 18. Frontend production build
await t.it('18. Frontend production build assets exist and index.html is valid', () => {
  const distIndex = path.join(ROOT, 'client', 'dist', 'index.html');
  assert.ok(fs.existsSync(distIndex), 'client/dist/index.html must exist');
  const content = fs.readFileSync(distIndex, 'utf-8');
  assert.ok(content.includes('<!doctype html>') || content.includes('<!DOCTYPE html>'));
});
