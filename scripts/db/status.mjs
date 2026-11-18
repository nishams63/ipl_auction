#!/usr/bin/env node
// Read-only overview of DATABASE_URL: schema version, rooms, quarantine, import runs.
// Usage: npm run db:status
import { createPool, describeDatabaseUrl, waitForDatabase } from '../../server/persistence/db.js';
import { migrationStatus } from '../../server/persistence/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}
console.log(`Target database: ${describeDatabaseUrl(url)}`);
const pool = createPool(url, { max: 1, applicationName: 'ipl-auction-status' });
try {
  await waitForDatabase(pool);
  const s = await migrationStatus(pool);
  console.log(`Migrations applied: ${s.applied.map(a => a.name).join(', ') || '(none)'}`);
  if (s.pending.length) console.log(`PENDING: ${s.pending.join(', ')}`);
  if (s.mismatched.length) console.log(`MODIFIED AFTER APPLY: ${s.mismatched.join(', ')}`);
  if (s.applied.length) {
    const rooms = await pool.query('SELECT status, count(*)::int AS n FROM rooms GROUP BY status ORDER BY status');
    console.log(`Rooms: ${rooms.rows.map(r => `${r.status} ${r.n}`).join(', ') || '0'}`);
    const q = await pool.query('SELECT room_code, reason, quarantined_at FROM quarantined_rooms WHERE resolved_at IS NULL ORDER BY id');
    console.log(`Quarantined (unresolved): ${q.rowCount}`);
    for (const r of q.rows) console.log(`  ${r.room_code}: ${r.reason}`);
    const runs = await pool.query('SELECT run_id, status, source_name, started_at, counts FROM migration_runs ORDER BY run_id DESC LIMIT 5');
    for (const r of runs.rows) console.log(`Import run ${r.run_id}: ${r.status} ${r.source_name} ${r.started_at.toISOString()} ${JSON.stringify(r.counts || {})}`);
  }
  console.log(s.upToDate ? 'Schema is up to date.' : 'Schema is NOT up to date.');
  if (!s.upToDate) process.exitCode = 1;
} catch (err) {
  console.error(`Status failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
