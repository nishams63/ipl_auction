#!/usr/bin/env node
// READ-ONLY catalogue comparison. Never modifies server/data/players.json.
//
// Extracts candidate players from catalogue HTML files (the "Set NN" format), then compares
// them with the existing catalogue and with each other. Produces machine evidence only:
// final duplicate/alias decisions are recorded by a human in the review-decisions file.
//
// Usage:
//   node scripts/catalogue/compare-candidates.mjs <out.json> <set.html> [<set.html> ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXISTING = path.join(ROOT, 'server', 'data', 'players.json');
const [, , outFile, ...inputs] = process.argv;
if (!outFile || inputs.length === 0) {
  console.error('Usage: node scripts/catalogue/compare-candidates.mjs <out.json> <set.html> [...]');
  process.exit(2);
}

// Source category codes → app categories (see server/data/buildPlayers.js)
const CATEGORY_MAP = { BAT: 'BAT', FAST: 'BOWL', SPIN: 'SP', AR: 'AR', WK: 'WK' };
// Surnames/first names too common to count as identity evidence on their own
const COMMON = new Set(['singh', 'sharma', 'kumar', 'khan', 'yadav', 'patel', 'mishra', 'dubey', 'smith', 'wood',
  'allen', 'jansen', 'joseph', 'pretorius', 'naib', 'mendis', 'roy', 'das', 'thakur', 'rathi', 'david', 'mohammad']);

const decode = s => s.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
export function normalize(name) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’`]/g, '').replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
const tokens = n => normalize(n).split(' ');

function similarity(a, b) { // Ratcliff/Obershelp-style ratio via LCS of characters (good enough for ranking)
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  return (2 * dp[m][n]) / (m + n);
}

function extract(file) {
  const html = fs.readFileSync(file, 'utf-8');
  const source = path.basename(file);
  const records = [];
  const roundRe = /<article class="round" id="round-(\d+)">([\s\S]*?)<\/article>/g;
  for (const rm of html.matchAll(roundRe)) {
    const sectionRe = /<section><h3>([A-Z]+)-(\d+) · ([A-Z\- ]+)<\/h3>([\s\S]*?)<\/section>/g;
    for (const sm of rm[2].matchAll(sectionRe)) {
      for (const pm of sm[4].matchAll(/<strong>(.*?)<\/strong><small>(.*?)<\/small>/g)) {
        const parts = decode(pm[2]).split('·').map(s => s.trim());
        records.push({
          source,
          round: Number(rm[1]),
          sourceCategory: sm[1],
          category: CATEGORY_MAP[sm[1]] || null,
          name: decode(pm[1]).trim(),
          country: parts[0] || null,
          sourceCode: parts[1] || null,
          sourceNote: parts.slice(2).join(' · ') || null,
          domesticProspect: /Domestic prospect/i.test(pm[2]),
          initialsOnly: /^[A-Z]{1,3}$/.test(decode(pm[1]).trim().split(' ')[0])
        });
      }
    }
  }
  return records;
}

function evidence(cand, other) {
  const ct = tokens(cand), pt = tokens(other);
  const reasons = [];
  if (cand === other) reasons.push('exact-name');
  else if (normalize(cand) === normalize(other)) reasons.push('normalized-name');
  if (ct.join('') === pt.join('') && cand !== other) reasons.push('spacing/punctuation');
  if ([...ct].sort().join('') === [...pt].sort().join('') && ct.join('') !== pt.join('')) reasons.push('token-reorder');
  const pairs = t => t.slice(0, -1).map((x, i) => x + t[i + 1]);
  if (pairs(ct).some(x => pt.includes(x)) || pairs(pt).some(x => ct.includes(x))) reasons.push('merged-tokens');
  const shared = ct.filter(t => pt.includes(t) && t.length >= 4 && !COMMON.has(t));
  if (shared.length) reasons.push(`shared-distinctive-token:${shared.join(',')}`);
  const first = cand.trim().split(' ')[0];
  if (/^[A-Z]{1,3}$/.test(first) && ct.at(-1) === pt.at(-1) && pt[0].startsWith(first[0].toLowerCase())) reasons.push(`initial-matches:${first}`);
  const r = similarity(normalize(cand), normalize(other));
  if (r >= 0.85) reasons.push(`high-similarity:${r.toFixed(2)}`);
  if (ct.at(-1) === pt.at(-1) && similarity(ct[0], pt[0]) >= 0.6 && ct[0] !== pt[0]) reasons.push('same-surname-similar-first-name');
  return { reasons, similarity: Number(r.toFixed(2)) };
}

const existing = JSON.parse(fs.readFileSync(EXISTING, 'utf-8'));
const candidates = inputs.flatMap(extract);

const report = {
  generatedAt: new Date().toISOString(),
  existingCount: existing.length,
  candidateCount: candidates.length,
  bySource: Object.fromEntries(inputs.map(f => [path.basename(f), candidates.filter(c => c.source === path.basename(f)).length])),
  candidates: candidates.map((c, i) => {
    const vsExisting = existing.map(p => ({ p, e: evidence(c.name, p.name) }))
      .filter(x => x.e.reasons.length)
      .map(x => ({ id: x.p.id, name: x.p.name, category: x.p.category, country: x.p.country, role: x.p.role, ...x.e }));
    const vsCandidates = candidates.map((o, j) => ({ o, j, e: evidence(c.name, o.name) }))
      .filter(x => x.j !== i && x.e.reasons.length)
      .map(x => ({ index: x.j, name: x.o.name, source: x.o.source, category: x.o.category, country: x.o.country, ...x.e }));
    return { index: i, ...c, matchesExisting: vsExisting, matchesCandidates: vsCandidates };
  })
};
report.summary = {
  exactDuplicatesOfExisting: report.candidates.filter(c => c.matchesExisting.some(m => m.reasons.includes('exact-name'))).length,
  normalizedDuplicatesOfExisting: report.candidates.filter(c => c.matchesExisting.some(m => m.reasons.includes('normalized-name') || m.reasons.includes('spacing/punctuation'))).length,
  candidatesWithAnyEvidenceVsExisting: report.candidates.filter(c => c.matchesExisting.length).length,
  candidatesWithAnyEvidenceVsOtherCandidates: report.candidates.filter(c => c.matchesCandidates.length).length,
  domesticProspects: report.candidates.filter(c => c.domesticProspect).length,
  initialsOnlyNames: report.candidates.filter(c => c.initialsOnly).length
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ existingCount: report.existingCount, candidateCount: report.candidateCount, bySource: report.bySource, ...report.summary }, null, 2));
