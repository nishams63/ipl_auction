import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML_PATH = path.join(ROOT, 'ipl_auction_round_wise_catalogue.html');

const html = fs.readFileSync(HTML_PATH, 'utf-8');

const CATEGORY_MAP = {
  '1. BATTERS': { code: 'BAT', title: 'Specialist Batters', shortTitle: 'BATTERS' },
  '2. FAST BOWLERS': { code: 'BOWL', title: 'Specialist Fast Bowlers', shortTitle: 'FAST BOWLERS' },
  '3. SPINNERS': { code: 'SP', title: 'Specialist Spinners', shortTitle: 'SPINNERS' },
  '4. ALL-ROUNDERS': { code: 'AR', title: 'All-rounders', shortTitle: 'ALL-ROUNDERS' },
  '5. WICKETKEEPERS': { code: 'WK', title: 'Wicketkeepers', shortTitle: 'WICKETKEEPERS' }
};

// Split by profile sections
const profileChunks = html.split('<section class="auction-level profile-section ');
console.log(`Found ${profileChunks.length - 1} profile sections.`);

const profiles = [];
let totalPlayers = 0;
const allPlayers = [];
const seenNames = new Map();

for (let pIdx = 1; pIdx < profileChunks.length; pIdx++) {
  const pChunk = profileChunks[pIdx];
  const profileIdMatch = pChunk.match(/^([^"]+)" id="([^"]+)">/);
  const profileClass = profileIdMatch ? profileIdMatch[1].trim() : `profile-${pIdx}`;
  const profileId = profileIdMatch ? profileIdMatch[2].trim() : profileClass;

  const h2Match = pChunk.match(/<h2>(.*?)<span class="level-count">(\d+) players<\/span><\/h2>/);
  const profileTitle = h2Match ? h2Match[1].trim() : profileId;
  const declaredTotal = h2Match ? parseInt(h2Match[2], 10) : 0;

  // Split by auction-round
  const roundChunks = pChunk.split('<section class="auction-round">');
  console.log(`Profile ${profileTitle} (${profileClass}) has ${roundChunks.length - 1} rounds.`);

  const rounds = [];
  let profilePlayerCount = 0;

  for (let rIdx = 1; rIdx < roundChunks.length; rIdx++) {
    const rChunk = roundChunks[rIdx];
    const rNumMatch = rChunk.match(/<h3>ROUND (\d+)<\/h3>/);
    const roundNum = rNumMatch ? parseInt(rNumMatch[1], 10) : rIdx;

    // Split by auction-set
    const setChunks = rChunk.split('<section class="auction-set">');
    const sets = [];

    for (let sIdx = 1; sIdx < setChunks.length; sIdx++) {
      const sChunk = setChunks[sIdx];
      const h4Match = sChunk.match(/<h4 class="set-heading">([0-9]+\.\s+[A-Z\s\-]+)<span class="set-count">(\d+)\s+players<\/span><\/h4>/);
      if (!h4Match) {
        console.log(`  Warning: set header not found in round ${roundNum} set chunk ${sIdx}`);
        continue;
      }
      const heading = h4Match[1].trim();
      const declaredCount = parseInt(h4Match[2], 10);
      const catInfo = CATEGORY_MAP[heading] || { code: heading.split(' ')[1] || 'UNK', title: heading, shortTitle: heading };

      const aMatches = [...sChunk.matchAll(/<a class="player"/g)].length;
      if (aMatches !== declaredCount) {
        console.log(`Set count mismatch: ${profileClass} Round ${roundNum} ${heading}: declared ${declaredCount}, found ${aMatches} <a class="player"> tags`);
      }

      const playerRegex = /<a class="player"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>[\s\S]*?<span class="meta"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>(?:<small class="alias-note">Also listed as:\s*([^<]*)<\/small>)?<\/span><\/a>/g;

      const players = [];
      for (const plMatch of sChunk.matchAll(playerRegex)) {
        const searchHref = plMatch[1];
        const titleAttr = plMatch[2];
        const imgAlt = plMatch[3];
        const imgSrc = plMatch[4];
        const name = plMatch[5].trim();
        const metaSmall = plMatch[6].trim();
        const alias = plMatch[7] ? plMatch[7].trim() : null;

        const metaParts = metaSmall.split('·').map(s => s.trim());
        const country = metaParts[0] || 'Unknown';
        const roleShort = metaParts[1] || catInfo.code;

        players.push({
          name,
          country,
          roleShort,
          alias,
          searchHref,
          titleAttr,
          imgAlt,
          imgSrc,
          metaSmall
        });
      }

      if (players.length !== aMatches) {
        console.log(`Regex mismatch in ${profileClass} Round ${roundNum} ${heading}: found ${aMatches} <a> tags, but playerRegex matched ${players.length}`);
        // Let's inspect the <a> tags that didn't match
        const allA = [...sChunk.matchAll(/<a class="player"[\s\S]*?<\/a>/g)].map(m => m[0]);
        for (const aTag of allA) {
          if (!aTag.match(playerRegex)) {
            console.log(`  Failed tag full:\n`, aTag);
          }
        }
      }

      const isIncomplete = sChunk.includes('set-incomplete');
      const isEmpty = sChunk.includes('set-empty');

      sets.push({
        heading,
        category: catInfo.code,
        categoryTitle: catInfo.title,
        shortTitle: catInfo.shortTitle,
        declaredCount,
        actualCount: players.length,
        isIncomplete,
        isEmpty,
        players
      });

      profilePlayerCount += players.length;
      totalPlayers += players.length;

      players.forEach((p, idx) => {
        const record = {
          ...p,
          profile: profileClass,
          profileTitle,
          round: roundNum,
          setHeading: heading,
          category: catInfo.code,
          categoryTitle: catInfo.title,
          indexInSet: idx + 1,
          setTotal: players.length
        };
        allPlayers.push(record);

        if (!seenNames.has(p.name)) {
          seenNames.set(p.name, []);
        }
        seenNames.get(p.name).push(record);
      });
    }

    rounds.push({
      roundNum,
      sets
    });
  }

  profiles.push({
    profileClass,
    profileId,
    profileTitle,
    declaredTotal,
    actualTotal: profilePlayerCount,
    roundCount: rounds.length,
    rounds
  });
}

console.log('\n--- VERIFICATION SUMMARY ---');
profiles.forEach(p => {
  console.log(`Profile: ${p.profileTitle} (${p.profileClass})`);
  console.log(`  Declared: ${p.declaredTotal}, Actual: ${p.actualTotal}, Matches: ${p.declaredTotal === p.actualTotal}`);
  console.log(`  Rounds: ${p.roundCount}`);
  let emptySets = 0, incompleteSets = 0, fullSets = 0;
  p.rounds.forEach(r => {
    r.sets.forEach(s => {
      if (s.isEmpty) emptySets++;
      else if (s.isIncomplete) incompleteSets++;
      else fullSets++;
    });
  });
  console.log(`  Sets: ${fullSets} full (6), ${incompleteSets} incomplete, ${emptySets} empty. Total sets: ${fullSets + incompleteSets + emptySets}`);
});

console.log(`\nTotal players extracted: ${totalPlayers}`);
console.log(`Total unique names: ${seenNames.size}`);

const duplicates = [];
for (const [name, occurrences] of seenNames.entries()) {
  if (occurrences.length > 1) {
    duplicates.push({ name, occurrences });
  }
}
console.log(`Duplicate count: ${duplicates.length}`);
