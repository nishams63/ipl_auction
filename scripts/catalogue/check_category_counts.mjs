import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML_PATH = path.join(ROOT, 'ipl_auction_round_wise_catalogue.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');

const profileChunks = html.split('<section class="auction-level profile-section ');
for (let pIdx = 1; pIdx < profileChunks.length; pIdx++) {
  const pChunk = profileChunks[pIdx];
  const profileId = pChunk.match(/^([^"]+)" id="([^"]+)">/)[2];
  const desc = pChunk.match(/<p class="profile-desc">([\s\S]*?)<\/p>/)[1];
  console.log(`\nProfile: ${profileId}`);
  console.log(`Declared in desc: ${desc}`);

  const catCounts = { BAT: 0, BOWL: 0, SP: 0, AR: 0, WK: 0 };
  const rChunks = pChunk.split('<section class="auction-round">');
  for (let rIdx = 1; rIdx < rChunks.length; rIdx++) {
    const rChunk = rChunks[rIdx];
    const sChunks = rChunk.split('<section class="auction-set">');
    for (let sIdx = 1; sIdx < sChunks.length; sIdx++) {
      const sChunk = sChunks[sIdx];
      const h4 = sChunk.match(/<h4 class="set-heading">([0-9]+\.\s+[A-Z\s\-]+)/)[1];
      let cat = 'BAT';
      if (h4.includes('FAST')) cat = 'BOWL';
      else if (h4.includes('SPIN')) cat = 'SP';
      else if (h4.includes('ALL')) cat = 'AR';
      else if (h4.includes('WICKET')) cat = 'WK';

      const aTags = [...sChunk.matchAll(/<a class="player"/g)].length;
      catCounts[cat] += aTags;
    }
  }
  console.log('Actual counted:', catCounts);
  const total = Object.values(catCounts).reduce((a, b) => a + b, 0);
  console.log(`Total: ${total}`);
}
