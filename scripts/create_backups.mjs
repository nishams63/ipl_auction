import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const filesToBackup = [
  'server/data/players.json',
  'server/data/persisted_rooms.json',
  'server/data/buildPlayers.js'
];

filesToBackup.forEach(rel => {
  const src = path.join(ROOT, rel);
  const dest = `${src}.bak`;
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Backed up: ${rel} -> ${rel}.bak (${fs.statSync(dest).size} bytes)`);
  }
});
console.log('Backups completed successfully.');
