// Runs every test suite (even after a failure) and prints honest per-suite counts.
// Usage: npm test
//
// PostgreSQL integration suites (pg*.test.js, except the pgMapper unit suite) need a DISPOSABLE
// database: TEST_DATABASE_URL (local server) or embedded-postgres (npm i --no-save
// embedded-postgres), started once here and shared. Without either they report SKIPPED — never
// counted as passed — and the summary says PostgreSQL integration was NOT verified.
// REQUIRE_PG=1 turns a skipped PostgreSQL suite into a failure (use in CI).
// Run a subset: npm test -- pgSchema pgMigration   (names match suite files; "live" = the
// two-client live simulation, which otherwise runs only in a full run)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, cleanupAll, tempStorageFile } from './helpers/harness.js';
import { assertSafeTestUrl, startEmbeddedCluster, stopEmbeddedCluster } from './helpers/pg.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'harness.test.js',
  'auction.test.js',
  'newCatalogue.test.js',
  'modifications.test.js',
  'config.test.js',
  'security.test.js',
  'payloadPrivacy.test.js',
  'auctionIntegrity.test.js',
  'persistence.test.js',
  'multiplayerRegression.test.js',
  'compatibility.test.js',
  'playingXiAuthorization.test.js',
  'squadOwnership.test.js',
  'legacyCleanup.test.js',
  'roomIsolation.test.js',
  'restoreRelink.test.js',
  'gameplay.test.js',
  'analysis.test.js',        // AI parts use MOCKED Anthropic responses
  'analysisApi.test.js',     // real servers + local MOCK Anthropic API
  'cricketMastermind.test.js', // Cricket Mastermind IPL Auction Verdict suite
  'arenaBridge.test.js',     // Stage 4 Unity bridge: mapping, SIMULATED browser/Unity, real-server sync
  'pgMapper.test.js',        // unit (no database)
  'pgSchema.test.js',        // real PostgreSQL from here on
  'pgPersistence.test.js',
  'pgRecovery.test.js',
  'pgMigration.test.js',
  'pgSecurity.test.js',
  'pgDurability.test.js',
  'pgInstance.test.js',
  'pgGameplay.test.js',
  'pgAnalysis.test.js'
];

const filters = process.argv.slice(2);
const selected = filters.length ? SUITES.filter(f => filters.some(x => f.startsWith(x))) : SUITES;
const runLive = filters.length === 0 || filters.includes('live');
if (filters.length && selected.length === 0 && !runLive) {
  console.error(`No suite matches: ${filters.join(', ')}`);
  process.exit(2);
}

// One disposable PostgreSQL for the whole run
let pgSource = null;
let pgEnv = {};
const needsPg = selected.some(f => /^pg/.test(f) && f !== 'pgMapper.test.js');
if (!needsPg) {
  // no PostgreSQL suite selected: don't start a cluster
} else if (process.env.TEST_DATABASE_URL) {
  assertSafeTestUrl(process.env.TEST_DATABASE_URL);
  pgSource = 'TEST_DATABASE_URL (local disposable server)';
} else {
  const url = await startEmbeddedCluster();
  if (url) {
    pgEnv = { TEST_DATABASE_URL: url };
    pgSource = 'embedded-postgres (temporary cluster)';
  }
}
if (needsPg) console.log(pgSource ? `PostgreSQL for integration suites: ${pgSource}` : 'PostgreSQL for integration suites: NONE AVAILABLE — those suites will be SKIPPED');

function run(file, env = {}, { singleScenario = false } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, file)], {
    env: { ...process.env, ROOM_STORAGE_FILE: tempStorageFile('runall'), ...pgEnv, ...env },
    encoding: 'utf-8',
    timeout: 240000
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const passed = (out.match(/✅/g) || []).length;
  let failed = (out.match(/❌/g) || []).length;
  let code = r.status;
  // A suite that reported SKIPPED and nothing else is neither a pass nor a failure
  if (code === 0 && passed === 0 && failed === 0 && /⏭️/.test(out)) {
    if (process.env.REQUIRE_PG === '1') return { file, code: 1, passed: 0, failed: 1, skipped: true, ms: Date.now() - started, out };
    return { file, code: 0, passed: 0, failed: 0, skipped: true, ms: Date.now() - started, out };
  }
  // Guard against false positives: a suite must report at least one check, and a
  // non-zero exit must show up as at least one failure in the totals.
  // (singleScenario suites print no ✅ markers; they are judged on exit code alone.)
  if (singleScenario) return { file, code, signal: r.signal, passed: code === 0 ? 1 : 0, failed: code === 0 ? 0 : 1, ms: Date.now() - started, out };
  if (code === 0 && passed === 0) { code = 1; failed = 1; }
  if (code !== 0 && failed === 0) failed = 1;
  return { file, code, signal: r.signal, passed, failed, ms: Date.now() - started, out };
}

const results = [];
for (const f of selected) {
  process.stdout.write(`▶ ${f} … `);
  const r = run(f);
  results.push(r);
  console.log(r.skipped ? `SKIPPED (no disposable PostgreSQL)${r.code ? ' — counted as FAILURE (REQUIRE_PG=1)' : ''}` : r.code === 0 ? `ok (${r.passed} passed, ${(r.ms / 1000).toFixed(1)}s)` : `FAILED (exit ${r.code ?? r.signal})`);
  if (r.code !== 0) console.log(r.out.split('\n').filter(l => /❌|→|Error|failed/i.test(l)).slice(0, 25).join('\n'));
}

// Original live two-client simulation needs a running server
if (runLive) {
  process.stdout.write('▶ multiplayerSimulation.test.js (live server) … ');
  const srv = await startServer();
  const sim = run('multiplayerSimulation.test.js', { SERVER_URL: srv.url }, { singleScenario: true });
  await srv.stop();
  const simOk = sim.code === 0;
  results.push(sim);
  console.log(simOk ? `ok (1 end-to-end scenario, ${(sim.ms / 1000).toFixed(1)}s)` : 'FAILED');
  if (!simOk) console.log(sim.out.slice(-2000));
}
await cleanupAll();
await stopEmbeddedCluster();

const totalPassed = results.reduce((s, r) => s + r.passed, 0);
const totalFailed = results.reduce((s, r) => s + r.failed, 0);
const suitesFailed = results.filter(r => r.code !== 0).length;
console.log('\n──────── Summary ────────');
for (const r of results) console.log(`${r.skipped ? '⏭' : r.code === 0 ? '✔' : '✘'} ${r.file.padEnd(34)} ${r.skipped ? 'SKIPPED (not run)' : `passed ${String(r.passed).padStart(3)}  failed ${r.failed}`}`);
const skipped = results.filter(r => r.skipped).length;
console.log(`\nSuites: ${results.length - suitesFailed - skipped}/${results.length} passed${skipped ? `, ${skipped} SKIPPED` : ''} · Checks: ${totalPassed} passed, ${totalFailed} failed`);
const pgRan = results.some(r => /^pg(?!Mapper)/.test(r.file) && !r.skipped);
console.log(skipped
  ? `PostgreSQL integration: NOT VERIFIED (${skipped} suite(s) skipped — no disposable PostgreSQL available)`
  : pgRan ? `PostgreSQL integration: verified against a real database (${pgSource})` : 'PostgreSQL integration: not part of this run');
process.exit(suitesFailed ? 1 : 0);
