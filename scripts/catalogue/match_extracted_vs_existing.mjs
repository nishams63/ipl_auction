import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML_PATH = path.join(ROOT, 'ipl_auction_round_wise_catalogue.html');
const EXISTING_PATH = path.join(ROOT, 'server', 'data', 'players.json');

const html = fs.readFileSync(HTML_PATH, 'utf-8');
const existing = JSON.parse(fs.readFileSync(EXISTING_PATH, 'utf-8'));

function normalize(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build existing map
const existingByNorm = new Map();
const existingByName = new Map();
existing.forEach(p => {
  existingByName.set(p.name, p);
  existingByNorm.set(normalize(p.name), p);
});

// Extract 409 players from HTML
const CATEGORY_MAP = {
  '1. BATTERS': { code: 'BAT', title: 'Specialist Batters', shortTitle: 'BATTERS' },
  '2. FAST BOWLERS': { code: 'BOWL', title: 'Specialist Fast Bowlers', shortTitle: 'FAST BOWLERS' },
  '3. SPINNERS': { code: 'SP', title: 'Specialist Spinners', shortTitle: 'SPINNERS' },
  '4. ALL-ROUNDERS': { code: 'AR', title: 'All-rounders', shortTitle: 'ALL-ROUNDERS' },
  '5. WICKETKEEPERS': { code: 'WK', title: 'Wicketkeepers', shortTitle: 'WICKETKEEPERS' }
};

const profileChunks = html.split('<section class="auction-level profile-section ');
const extracted = [];

for (let pIdx = 1; pIdx < profileChunks.length; pIdx++) {
  const pChunk = profileChunks[pIdx];
  const profileMatch = pChunk.match(/^([^"]+)" id="([^"]+)">/);
  const profileClass = profileMatch ? profileMatch[1].trim() : `profile-${pIdx}`;
  const profileId = profileMatch ? profileMatch[2].trim() : profileClass;
  const h2Match = pChunk.match(/<h2>(.*?)<span class="level-count">(\d+) players<\/span><\/h2>/);
  const profileTitle = h2Match ? h2Match[1].trim() : profileId;

  const roundChunks = pChunk.split('<section class="auction-round">');
  for (let rIdx = 1; rIdx < roundChunks.length; rIdx++) {
    const rChunk = roundChunks[rIdx];
    const rNumMatch = rChunk.match(/<h3>ROUND (\d+)<\/h3>/);
    const roundNum = rNumMatch ? parseInt(rNumMatch[1], 10) : rIdx;

    const setChunks = rChunk.split('<section class="auction-set">');
    for (let sIdx = 1; sIdx < setChunks.length; sIdx++) {
      const sChunk = setChunks[sIdx];
      const h4Match = sChunk.match(/<h4 class="set-heading">([0-9]+\.\s+[A-Z\s\-]+)<span class="set-count">(\d+)\s+players<\/span><\/h4>/);
      if (!h4Match) continue;
      const heading = h4Match[1].trim();
      const catInfo = CATEGORY_MAP[heading] || { code: heading.split(' ')[1] || 'UNK', title: heading, shortTitle: heading };

      const playerRegex = /<a class="player"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>[\s\S]*?<span class="meta"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>(?:<small class="alias-note">Also listed as:\s*([^<]*)<\/small>)?<\/span><\/a>/g;

      let lotInSet = 1;
      const inThisSet = [];
      for (const plMatch of sChunk.matchAll(playerRegex)) {
        const searchHref = plMatch[1];
        const titleAttr = plMatch[2]; // e.g. "Original entries: India · BAT-01"
        const imgAlt = plMatch[3];
        const imgSrc = plMatch[4];
        const name = plMatch[5].trim();
        const metaSmall = plMatch[6].trim();
        const alias = plMatch[7] ? plMatch[7].trim() : null;

        const metaParts = metaSmall.split('·').map(s => s.trim());
        const country = metaParts[0] || 'Unknown';
        const roleShort = metaParts[1] || catInfo.code;

        inThisSet.push({
          name,
          country,
          roleShort,
          alias,
          searchHref,
          titleAttr,
          imgAlt,
          imgSrc,
          metaSmall,
          profile: profileClass,
          profileTitle,
          round: roundNum,
          category: catInfo.code,
          categoryTitle: catInfo.title,
          shortTitle: catInfo.shortTitle,
          lotInSet: lotInSet++
        });
      }

      inThisSet.forEach(p => {
        p.setTotal = inThisSet.length;
        p.isIncomplete = inThisSet.length < 6;
        extracted.push(p);
      });
    }
  }
}

console.log(`Total extracted: ${extracted.length}`);

// Match vs existing
let exactMatch = 0;
let normMatch = 0;
let aliasMatch = 0;
const unmatched = [];
const matched = [];

extracted.forEach(p => {
  let match = existingByName.get(p.name);
  if (match) {
    exactMatch++;
    matched.push({ p, match, matchType: 'exact' });
    return;
  }
  match = existingByNorm.get(normalize(p.name));
  if (match) {
    normMatch++;
    matched.push({ p, match, matchType: 'normalized' });
    return;
  }
  if (p.alias) {
    match = existingByName.get(p.alias) || existingByNorm.get(normalize(p.alias));
    if (match) {
      aliasMatch++;
      matched.push({ p, match, matchType: 'alias' });
      return;
    }
  }
  unmatched.push(p);
});

console.log(`Matched vs existing 290 players:`);
console.log(`  Exact name match: ${exactMatch}`);
console.log(`  Normalized match: ${normMatch}`);
console.log(`  Alias match: ${aliasMatch}`);
console.log(`  Total matched: ${matched.length}`);
console.log(`  Unmatched new players: ${unmatched.length}`);

// Inspect existing players not in extracted
const extractedNames = new Set(extracted.map(p => normalize(p.name)));
extracted.filter(p => p.alias).forEach(p => extractedNames.add(normalize(p.alias)));
const missingFromNew = existing.filter(p => !extractedNames.has(normalize(p.name)));
console.log(`\nExisting 290 players missing from new 409 catalogue: ${missingFromNew.length}`);
if (missingFromNew.length > 0) {
  console.log('List of existing players not in new catalogue:');
  missingFromNew.forEach(p => console.log(`  ${p.id}: ${p.name} (${p.country}, ${p.category}, ₹${p.basePrice} Cr)`));
}

// Inspect unmatched new players
console.log(`\nUnmatched new players count: ${unmatched.length}`);
const unmatchedByProfile = {};
unmatched.forEach(p => {
  unmatchedByProfile[p.profile] = (unmatchedByProfile[p.profile] || 0) + 1;
});
console.log('Unmatched by profile:', unmatchedByProfile);

// Check sample unmatched players
console.log('\nSample unmatched players from High profile:');
unmatched.filter(p => p.profile === 'high').slice(0, 10).forEach(p => {
  console.log(`  ${p.name} (${p.country}, ${p.category}) - title: "${p.titleAttr}", meta: "${p.metaSmall}"`);
});

console.log('\nSample unmatched players from Medium profile:');
unmatched.filter(p => p.profile === 'medium').slice(0, 10).forEach(p => {
  console.log(`  ${p.name} (${p.country}, ${p.category}) - title: "${p.titleAttr}", meta: "${p.metaSmall}"`);
});

console.log('\nSample unmatched players from Low profile:');
unmatched.filter(p => p.profile === 'low').slice(0, 10).forEach(p => {
  console.log(`  ${p.name} (${p.country}, ${p.category}) - title: "${p.titleAttr}", meta: "${p.metaSmall}"`);
});
