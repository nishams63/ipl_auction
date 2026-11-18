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

// Test code-based pricing logic
function determineBasePrice(profile, codeNum, isDomesticProspect, country) {
  if (isDomesticProspect || codeNum >= 11) return 0.3;
  if (profile === 'low') {
    if (codeNum <= 3) return 0.5;
    if (codeNum <= 6) return 0.4;
    return 0.3;
  }
  if (profile === 'medium') {
    if (codeNum <= 2) return 1.5;
    if (codeNum <= 5) return 1.0;
    if (codeNum <= 8) return 0.75;
    return 0.5;
  }
  // High profile
  if (codeNum <= 2) return 2.0;
  if (codeNum <= 4) return 1.5;
  return 1.0;
}

const playerRegex = /<a class="player"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>[\s\S]*?<span class="meta"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>(?:<small class="alias-note">Also listed as:\s*([^<]*)<\/small>)?<\/span><\/a>/g;

const profileChunks = html.split('<section class="auction-level profile-section ');
const results = [];

for (let pIdx = 1; pIdx < profileChunks.length; pIdx++) {
  const pChunk = profileChunks[pIdx];
  const profile = pChunk.match(/^([^"]+)" id="([^"]+)">/)[1];
  for (const match of pChunk.matchAll(playerRegex)) {
    const title = match[2];
    const name = match[5].trim();
    const alias = match[7] ? match[7].trim() : null;
    const p = existingByNorm.get(normalize(name)) || (alias ? existingByNorm.get(normalize(alias)) : null);

    const codeMatch = title.match(/(BAT|FAST|SPIN|AR|WK)-(\d+)/);
    const codeNum = codeMatch ? parseInt(codeMatch[2], 10) : 99;
    const isDomestic = title.includes('Domestic prospect');
    const country = match[6].split('·')[0].trim();

    const assignedPrice = determineBasePrice(profile, codeNum, isDomestic, country);
    results.push({
      name,
      profile,
      codeNum,
      isDomestic,
      existingPrice: p ? p.basePrice : null,
      assignedPrice
    });
  }
}

const matched = results.filter(r => r.existingPrice !== null);
let exact = 0, diff = 0;
matched.forEach(r => {
  if (r.existingPrice === r.assignedPrice) exact++;
  else diff++;
});
console.log(`Matched players: ${matched.length}. Formula gave exact price for ${exact}, diff for ${diff}`);

const unmatched = results.filter(r => r.existingPrice === null);
console.log(`Unmatched players count: ${unmatched.length}`);
const priceDist = {};
unmatched.forEach(r => {
  priceDist[r.assignedPrice] = (priceDist[r.assignedPrice] || 0) + 1;
});
console.log('Unmatched assigned price distribution:', priceDist);
console.log('\nSample unmatched assignments:');
unmatched.slice(0, 15).forEach(r => {
  console.log(`  ${r.name} (${r.profile}, code: ${r.codeNum}, domestic: ${r.isDomestic}) -> ₹${r.assignedPrice} Cr`);
});
