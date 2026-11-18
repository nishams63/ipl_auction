import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const persistedPath = path.join(ROOT, 'server', 'data', 'persisted_rooms.json');
const roomsObj = JSON.parse(fs.readFileSync(persistedPath, 'utf-8'));
const rooms = Object.values(roomsObj);

console.log(`Total rooms in persisted_rooms.json: ${rooms.length}`);

const activeRooms = rooms.filter(r => r.status === 'active');
const lobbyRooms = rooms.filter(r => r.status === 'lobby');
const completedRooms = rooms.filter(r => r.status === 'completed');

console.log(`Active rooms: ${activeRooms.length}`);
console.log(`Lobby rooms: ${lobbyRooms.length}`);
console.log(`Completed rooms: ${completedRooms.length}`);

activeRooms.forEach(r => {
  console.log(`\nActive Room ${r.roomCode}:`);
  console.log(`  playersCatalog length: ${r.playersCatalog ? r.playersCatalog.length : 'none'}`);
  console.log(`  currentPlayerIndex: ${r.currentPlayerIndex}`);
  console.log(`  currentLot player: ${r.currentLot?.player?.name} (ID: ${r.currentLot?.player?.id})`);
  console.log(`  history entries: ${r.history?.length}`);
  const squadPlayers = Object.values(r.franchises || {}).reduce((acc, f) => acc + (f.squad?.length || 0), 0);
  console.log(`  total squad players bought: ${squadPlayers}`);
  if (r.history && r.history.length > 0) {
    console.log(`  first history entry: ${r.history[0]?.player?.name} -> status: ${r.history[0]?.status}, winner: ${r.history[0]?.winningFranchiseName}`);
  }
});
