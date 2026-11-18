import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const existing = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'players.json'), 'utf-8'));

console.log(`Existing players count: ${existing.length}`);

// Check distribution of basePrice and rating in existing players.json
const priceDist = {};
const ratingDist = {};
existing.forEach(p => {
  priceDist[p.basePrice] = (priceDist[p.basePrice] || 0) + 1;
  const ratingBucket = Math.floor(p.rating / 5) * 5;
  ratingDist[ratingBucket] = (ratingDist[ratingBucket] || 0) + 1;
});

console.log('Existing base prices:', priceDist);
console.log('Existing ratings (buckets):', ratingDist);

// Check sample players with base prices
console.log('\nSamples of basePrice:');
[2.0, 1.5, 1.0, 0.75, 0.5, 0.4, 0.3, 0.2].forEach(price => {
  const sample = existing.find(p => p.basePrice === price);
  if (sample) {
    console.log(`  ₹${price} Cr: ${sample.name} (${sample.country}, ${sample.category}, rating: ${sample.rating}, role: "${sample.role}")`);
  }
});
