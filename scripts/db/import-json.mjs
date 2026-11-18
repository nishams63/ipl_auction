#!/usr/bin/env node
// Import a COPY of a JSON save file into DATABASE_URL.
//
//   npm run db:import-json -- --file ./backup/persisted_rooms.copy.json --dry-run
//   npm run db:import-json -- --file ./backup/persisted_rooms.copy.json --confirm
//
// Options
//   --file <path>     JSON save file (required). Make a copy of the live file first.
//   --dry-run         Do everything inside transactions that are rolled back (no changes).
//   --confirm         Required for a real import (guards against accidental runs).
//   --report <path>   Where to write the JSON report (default ./migration-reports/import-<time>.json)
//   --allow-live-file Permit --file to point at server/data/persisted_rooms.json itself
//                     (it is still only read, but a copy is the recommended practice).
//   --allow-while-server-running  Import even though a server holds the writer lease (its
//                     clients will not see the imported rooms until it restarts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, describeDatabaseUrl, waitForDatabase } from '../../server/persistence/db.js';
import { importJsonFile } from '../../server/persistence/importJson.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const file = value('--file');
const dryRun = flag('--dry-run');
if (!file) {
  console.error('Usage: npm run db:import-json -- --file <copy-of-save-file.json> [--dry-run | --confirm] [--report <path>]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(2);
}
const live = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'data', 'persisted_rooms.json');
if (fs.existsSync(live) && fs.realpathSync(file) === fs.realpathSync(live) && !flag('--allow-live-file')) {
  console.error('Refusing to read the live save file directly. Copy it first (cp server/data/persisted_rooms.json backup.json) and import the copy, or pass --allow-live-file.');
  process.exit(2);
}
if (!dryRun && !flag('--confirm')) {
  console.error('A real import needs --confirm (or use --dry-run first).');
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const reportPath = value('--report') || path.join(process.cwd(), 'migration-reports',
  `import-${new Date().toISOString().replace(/[:.]/g, '-')}${dryRun ? '-dry-run' : ''}.json`);
// TEST ONLY: simulate a hard crash (SIGKILL) after N committed rooms
const crashAfter = process.env.IMPORT_JSON_TEST_CRASH_AFTER ? Number(process.env.IMPORT_JSON_TEST_CRASH_AFTER) : null;

console.log(`Target database: ${describeDatabaseUrl(url)}`);
console.log(`Source: ${path.resolve(file)}${dryRun ? '  (DRY RUN: no changes will be made)' : ''}`);
const pool = createPool(url, { max: 2, applicationName: 'ipl-auction-import' });
let exitCode = 0;
try {
  await waitForDatabase(pool);
  const report = await importJsonFile({
    pool, file, dryRun, reportPath, log: m => console.log(`  ${m}`),
    crashAfterRooms: crashAfter,
    allowWhileServerRunning: flag('--allow-while-server-running'),
    onCrash: () => process.kill(process.pid, 'SIGKILL')
  });
  const c = report.counts;
  console.log(`\n${report.status.toUpperCase()}${dryRun ? ' (dry run)' : ''}: ${c.total} room entr${c.total === 1 ? 'y' : 'ies'} — imported ${c.imported}, skipped ${c.skipped}, quarantined ${c.quarantined}, failed ${c.failed}`);
  for (const n of report.notes) console.log(`  note: ${n}`);
  console.log(`Source file unchanged: ${report.source.unchanged ? 'yes' : 'NO'} (sha256 ${report.source.sha256Before.slice(0, 16)}…)`);
  console.log(`Report: ${reportPath}`);
  if (report.status !== 'completed' || !report.source.unchanged) exitCode = 1;
} catch (err) {
  console.error(`Import failed: ${err.message}`);
  if (err.report) console.error(`Partial report: ${reportPath}`);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
