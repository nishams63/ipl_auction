import fs from 'fs';

const rooms = JSON.parse(fs.readFileSync('server/data/persisted_rooms.json', 'utf-8'));
console.log('Total rooms:', Object.keys(rooms).length);
for (const [code, r] of Object.entries(rooms)) {
  const claimed = Object.entries(r.franchises || {}).filter(([_, f]) => f.isClaimed).map(([id, f]) => id);
  console.log(`${code} [${r.status}]: claimed=${claimed.length} (${claimed.join(',')}), participants=${r.participants?.length || 0}, created=${r.createdAt || 'no-date'}, currentLot=${r.currentLot ? r.currentLot.player?.name : 'none'}`);
}
