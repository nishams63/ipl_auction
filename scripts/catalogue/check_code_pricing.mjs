import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const existing = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'players.json'), 'utf-8'));
const html = fs.readFileSync(path.join(ROOT, 'ipl_auction_round_wise_catalogue.html'), 'utf-8');

function normalize(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’`]/g, '').replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
const existingByNorm = new Map();
existing.forEach(p => existingByNorm.set(normalize(p.name), p));

// Extract all players and examine title code vs basePrice
const playerRegex = /<a class="player"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>[\s\S]*?<span class="meta"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>(?:<small class="alias-note">Also listed as:\s*([^<]*)<\/small>)?<\/span><\/a>/g;

const codeToPrices = {};

for (const match of html.matchAll(playerRegex)) {
  const title = match[2];
  const name = match[5].trim();
  const alias = match[7] ? match[7].trim() : null;
  const p = existingByNorm.get(normalize(name)) || (alias ? existingByNorm.get(normalize(alias)) : null);
  if (!p) continue;

  const codeMatch = title.match(/(BAT|FAST|SPIN|AR|WK)-(\d+)/);
  if (codeMatch) {
    const codeNum = parseInt(codeMatch[2], 10);
    const cat = codeMatch[1];
    const key = `${cat}-${codeNum}`;
    if (!codeToPrices[key]) codeToPrices[key] = [];
    codeToPrices[key].push(p.basePrice);
  }
}

console.log('Code number vs base prices among matched players:');
Object.keys(codeToPrices).sort().forEach(k => {
  const prices = codeToPrices[k];
  const avg = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
  console.log(`  ${k}: count=${prices.length}, avg=${avg}, min=${Math.min(...prices)}, max=${Math.max(...prices)}, prices=[${prices.join(', ')}]`);
});
