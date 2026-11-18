import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML_PATH = path.join(ROOT, 'ipl_auction_round_wise_catalogue.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');

const playerRegex = /<a class="player"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>[\s\S]*?<span class="meta"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>(?:<small class="alias-note">Also listed as:\s*([^<]*)<\/small>)?<\/span><\/a>/g;

const countries = {};
let overseasCount = 0;
let indiaCount = 0;

for (const plMatch of html.matchAll(playerRegex)) {
  const metaSmall = plMatch[6].trim();
  const country = metaSmall.split('·')[0].trim();
  countries[country] = (countries[country] || 0) + 1;
  if (country === 'India') indiaCount++;
  else overseasCount++;
}

console.log('Countries distribution across all 409 players:');
console.log(countries);
console.log(`India: ${indiaCount}, Overseas: ${overseasCount}, Total: ${indiaCount + overseasCount}`);
