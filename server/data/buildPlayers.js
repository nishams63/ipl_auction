// Official Player Dataset Builder
// Builds the authoritative 409-player round-wise catalogue from ipl_auction_round_wise_catalogue.html
// Preserves historical ratings, stats, and prices for existing players.
// Applies transparent tier-compatible base pricing for new imports without inventing stats or ratings.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..', '..');

const HTML_PATH = path.join(ROOT, 'ipl_auction_round_wise_catalogue.html');
const BACKUP_PATH = path.join(__dirname, 'players.json.bak');
const OUT_PATH = path.join(__dirname, 'players.json');

if (!fs.existsSync(HTML_PATH)) {
  console.error(`FATAL: Source catalogue not found at ${HTML_PATH}`);
  process.exit(1);
}

const html = fs.readFileSync(HTML_PATH, 'utf-8');

// Load historical player records for pricing/stats preservation
let existing = [];
if (fs.existsSync(BACKUP_PATH)) {
  existing = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf-8'));
} else if (fs.existsSync(OUT_PATH)) {
  existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
}

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

const existingByName = new Map();
const existingByNorm = new Map();
existing.forEach(p => {
  existingByName.set(p.name, p);
  existingByNorm.set(normalize(p.name), p);
});

const countryFlags = {
  "India": { flag: "🇮🇳", code: "IND" },
  "Australia": { flag: "🇦🇺", code: "AUS" },
  "England": { flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", code: "ENG" },
  "South Africa": { flag: "🇿🇦", code: "SA" },
  "West Indies": { flag: "🌴", code: "WI" },
  "New Zealand": { flag: "🇳🇿", code: "NZ" },
  "Afghanistan": { flag: "🇦🇫", code: "AFG" },
  "Sri Lanka": { flag: "🇱🇰", code: "SL" },
  "Zimbabwe": { flag: "🇿🇼", code: "ZIM" },
  "Bangladesh": { flag: "🇧🇩", code: "BAN" },
  "Namibia": { flag: "🇳🇦", code: "NAM" },
  "Ireland": { flag: "🇮🇪", code: "IRE" }
};

const CATEGORY_MAP = {
  '1. BATTERS': { code: 'BAT', title: 'Specialist Batters', shortTitle: 'Batters' },
  '2. FAST BOWLERS': { code: 'BOWL', title: 'Specialist Fast Bowlers', shortTitle: 'Fast Bowlers' },
  '3. SPINNERS': { code: 'SP', title: 'Specialist Spinners', shortTitle: 'Spinners' },
  '4. ALL-ROUNDERS': { code: 'AR', title: 'All-rounders', shortTitle: 'All-Rounders' },
  '5. WICKETKEEPERS': { code: 'WK', title: 'Wicketkeepers', shortTitle: 'Wicketkeepers' }
};

// Deterministic pricing rule for players not in pre-existing catalogue
function deriveNewPlayerBasePrice(profile, codeNum, isDomesticProspect) {
  if (isDomesticProspect) return 0.3;
  if (profile === 'high') {
    if (codeNum <= 2) return 2.0;
    if (codeNum <= 5) return 1.5;
    return 1.0;
  }
  if (profile === 'medium') {
    if (codeNum <= 2) return 1.5;
    if (codeNum <= 4) return 1.0;
    if (codeNum <= 8) return 0.75;
    return 0.5;
  }
  // Low Profile / Emerging
  if (codeNum <= 2) return 0.5;
  if (codeNum <= 5) return 0.4;
  return 0.3;
}

const profileChunks = html.split('<section class="auction-level profile-section ');
const catalog = [];
let overallLotCounter = 1;
const seenPlayerNames = new Set();
const seenPlayerIds = new Set();

let matchedExistingCount = 0;
let newPlayersCount = 0;

for (let pIdx = 1; pIdx < profileChunks.length; pIdx++) {
  const pChunk = profileChunks[pIdx];
  const profileIdMatch = pChunk.match(/^([^"]+)" id="([^"]+)">/);
  const profileClass = profileIdMatch ? profileIdMatch[1].trim() : `profile-${pIdx}`; // high, medium, low
  const profileId = profileIdMatch ? profileIdMatch[2].trim() : profileClass;
  const h2Match = pChunk.match(/<h2>(.*?)<span class="level-count">(\d+) players<\/span><\/h2>/);
  const profileTitle = h2Match ? h2Match[1].trim() : profileId;
  const profileShort = profileClass.toUpperCase();

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
      const catInfo = CATEGORY_MAP[heading] || { code: 'BAT', title: 'Specialist Batters', shortTitle: 'Batters' };
      const setKey = `${profileShort}-R${String(roundNum).padStart(2, '0')}-${catInfo.code}`;
      const setName = `${profileTitle.replace(' AUCTION', '')} · Round ${roundNum} · ${catInfo.shortTitle}`;

      const playerRegex = /<a class="player"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>[\s\S]*?<span class="meta"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>(?:<small class="alias-note">Also listed as:\s*([^<]*)<\/small>)?<\/span><\/a>/g;

      const setPlayersRaw = [];
      for (const plMatch of sChunk.matchAll(playerRegex)) {
        setPlayersRaw.push({
          searchHref: plMatch[1],
          titleAttr: plMatch[2],
          imgAlt: plMatch[3],
          imgSrc: plMatch[4],
          name: plMatch[5].trim(),
          metaSmall: plMatch[6].trim(),
          alias: plMatch[7] ? plMatch[7].trim() : null
        });
      }

      if (setPlayersRaw.length === 0) {
        continue;
      }

      const setTotal = setPlayersRaw.length;
      const isIncomplete = setTotal < 6;

      setPlayersRaw.forEach((raw, idx) => {
        const lotInSet = idx + 1;
        const normName = normalize(raw.name);

        if (seenPlayerNames.has(normName)) {
          throw new Error(`CRITICAL DUPLICATE DETECTED: Player "${raw.name}" encountered multiple times in catalogue!`);
        }
        seenPlayerNames.add(normName);

        // Match against pre-existing player database
        let match = existingByName.get(raw.name) || existingByNorm.get(normName);
        if (!match && raw.alias) {
          match = existingByName.get(raw.alias) || existingByNorm.get(normalize(raw.alias));
        }

        const metaParts = raw.metaSmall.split('·').map(s => s.trim());
        const country = metaParts[0] || (match ? match.country : 'Unknown');
        const isOverseas = country !== 'India';
        const roleFromMeta = metaParts.slice(1).join(' · ');

        // Parse code and domestic prospect note from title
        const codeMatch = raw.titleAttr.match(/(BAT|FAST|SPIN|AR|WK)-(\d+)/);
        const codeNum = codeMatch ? parseInt(codeMatch[2], 10) : 99;
        const isDomesticProspect = /Domestic prospect/i.test(raw.titleAttr);

        let basePrice;
        let rating;
        let stats;
        let role;

        if (match) {
          matchedExistingCount++;
          basePrice = match.basePrice;
          rating = match.rating;
          stats = match.stats || {};
          role = match.role || roleFromMeta || catInfo.title;
        } else {
          newPlayersCount++;
          basePrice = deriveNewPlayerBasePrice(profileClass, codeNum, isDomesticProspect);
          rating = null; // Do not invent ratings
          stats = {}; // Do not invent statistics
          role = roleFromMeta || catInfo.title;
        }

        const playerId = `PL_${String(overallLotCounter).padStart(3, '0')}`;
        if (seenPlayerIds.has(playerId)) {
          throw new Error(`CRITICAL ID COLLISION: Player ID "${playerId}" already assigned!`);
        }
        seenPlayerIds.add(playerId);

        const initials = raw.name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
        const cData = countryFlags[country] || { flag: "🏏", code: country.substring(0, 3).toUpperCase() };

        const playerRecord = {
          id: playerId,
          originalId: match ? match.id : null,
          name: raw.name,
          alias: raw.alias || null,
          profile: profileClass,
          profileTitle,
          round: roundNum,
          category: catInfo.code,
          categoryTitle: catInfo.title,
          categorySet: setKey,
          setName,
          setNumber: roundNum,
          lotInSet,
          setTotal,
          overallLot: overallLotCounter,
          isIncomplete,
          country,
          countryFlag: cData.flag,
          countryCode: cData.code,
          isOverseas,
          initials,
          role,
          basePrice,
          rating,
          stats,
          imageUrl: raw.imgSrc,
          imageAlt: raw.imgAlt,
          searchHref: raw.searchHref,
          sourceMetadata: {
            title: raw.titleAttr,
            originalCode: codeMatch ? codeMatch[0] : null,
            isDomesticProspect
          },
          status: "available",
          soldTo: null,
          soldPrice: null
        };

        catalog.push(playerRecord);
        overallLotCounter++;
      });
    }
  }
}

if (catalog.length !== 409) {
  throw new Error(`CRITICAL COUNT MISMATCH: Expected 409 players, built ${catalog.length}`);
}

fs.writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2));

console.log('=== BUILD COMPLETE ===');
console.log(`Successfully wrote ${catalog.length} players to ${OUT_PATH}`);
console.log(`Matched existing players: ${matchedExistingCount}`);
console.log(`New players imported: ${newPlayersCount}`);
console.log(`Profile counts: High: ${catalog.filter(p => p.profile === 'high').length}, Medium: ${catalog.filter(p => p.profile === 'medium').length}, Low: ${catalog.filter(p => p.profile === 'low').length}`);
