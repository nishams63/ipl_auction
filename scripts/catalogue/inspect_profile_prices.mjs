import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const existing = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'players.json'), 'utf-8'));

// Check basePrice vs profile level in the new catalogue!
// In the new catalogue, players are divided into 3 profiles:
// 1. High-profile (134 players)
// 2. Medium-profile (155 players)
// 3. Low-profile / Emerging (120 players)

// For the 242 matched players, let's see their base prices grouped by the NEW profile they belong to!
import { fileURLToPath as fURL } from 'node:url';
const HTML_PATH = path.join(ROOT, 'ipl_auction_round_wise_catalogue.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');

function normalize(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’`]/g, '').replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
const existingByNorm = new Map();
existing.forEach(p => existingByNorm.set(normalize(p.name), p));

const profileChunks = html.split('<section class="auction-level profile-section ');
for (let pIdx = 1; pIdx < profileChunks.length; pIdx++) {
  const pChunk = profileChunks[pIdx];
  const profile = pChunk.match(/^([^"]+)" id="([^"]+)">/)[1];
  const playerRegex = /<a class="player"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>[\s\S]*?<span class="meta"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>(?:<small class="alias-note">Also listed as:\s*([^<]*)<\/small>)?<\/span><\/a>/g;
  
  const prices = {};
  let matchedCount = 0;
  let totalCount = 0;
  for (const plMatch of pChunk.matchAll(playerRegex)) {
    totalCount++;
    const name = plMatch[5].trim();
    const alias = plMatch[7] ? plMatch[7].trim() : null;
    const match = existingByNorm.get(normalize(name)) || (alias ? existingByNorm.get(normalize(alias)) : null);
    if (match) {
      matchedCount++;
      prices[match.basePrice] = (prices[match.basePrice] || 0) + 1;
    }
  }
  console.log(`Profile: ${profile} (Total: ${totalCount}, Matched: ${matchedCount})`);
  console.log('  Matched base prices:', prices);
}
