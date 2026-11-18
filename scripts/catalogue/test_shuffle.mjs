import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { shuffleWithinSets } from '../../server/roomManager.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testCatalogPath = path.join(ROOT, 'server', 'data', 'players_new_test.json');
const originalCatalog = JSON.parse(fs.readFileSync(testCatalogPath, 'utf-8'));

console.log(`Testing shuffleWithinSets on ${originalCatalog.length} players...`);

// Deep copy for shuffle
const catalogToShuffle = JSON.parse(JSON.stringify(originalCatalog));
const shuffled = shuffleWithinSets(catalogToShuffle);

assert.strictEqual(shuffled.length, 409, 'Catalog length must be 409 after shuffle');

// Check that every set key appears in the exact same order of sets
const originalSetOrder = [];
originalCatalog.forEach(p => {
  const k = p.categorySet || p.setName;
  if (!originalSetOrder.includes(k)) originalSetOrder.push(k);
});

const shuffledSetOrder = [];
shuffled.forEach(p => {
  const k = p.categorySet || p.setName;
  if (!shuffledSetOrder.includes(k)) shuffledSetOrder.push(k);
});

assert.deepStrictEqual(shuffledSetOrder, originalSetOrder, 'Set order must remain completely identical after shuffle');
console.log(`Verified: All ${originalSetOrder.length} non-empty sets appear in the exact same sequence!`);

// Check that players in each set are a permutation of the original players in that set
for (const setKey of originalSetOrder) {
  const origSetPlayers = originalCatalog.filter(p => (p.categorySet || p.setName) === setKey).map(p => p.id).sort();
  const shufSetPlayers = shuffled.filter(p => (p.categorySet || p.setName) === setKey).map(p => p.id).sort();
  assert.deepStrictEqual(shufSetPlayers, origSetPlayers, `Set ${setKey} players must match original set players exactly`);
}
console.log('Verified: Every single set contains only its own players!');

// Check overallLot and lotInSet renumbering
shuffled.forEach((p, idx) => {
  assert.strictEqual(p.overallLot, idx + 1, `overallLot must be ${idx + 1}`);
  assert.ok(p.lotInSet >= 1 && p.lotInSet <= p.setTotal, `lotInSet ${p.lotInSet} must be between 1 and ${p.setTotal}`);
});
console.log('Verified: overallLot (1..409) and lotInSet renumbering are 100% correct!');
console.log('ALL SHUFFLE CHECKS PASSED!');
