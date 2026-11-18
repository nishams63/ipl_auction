import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const persistedPath = path.join(ROOT, 'server', 'data', 'persisted_rooms.json');
const roomsObj = JSON.parse(fs.readFileSync(persistedPath, 'utf-8'));

const lobbyRooms = Object.values(roomsObj).filter(r => r.status === 'lobby');
console.log(`Lobby rooms count: ${lobbyRooms.length}`);
lobbyRooms.forEach(r => {
  console.log(`Lobby room ${r.roomCode}: catalogLength=${r.playersCatalog?.length}, currentPlayerIndex=${r.currentPlayerIndex}, history=${r.history?.length}, participants=${r.participants?.length}`);
});
