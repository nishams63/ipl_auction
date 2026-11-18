#!/usr/bin/env node
// Apply pending schema migrations to DATABASE_URL.   Usage: npm run db:migrate
import { createPool, describeDatabaseUrl, waitForDatabase } from '../../server/persistence/db.js';
import { runMigrations, migrationStatus } from '../../server/persistence/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}
console.log(`Target database: ${describeDatabaseUrl(url)}`);
const pool = createPool(url, { max: 1, applicationName: 'ipl-auction-migrate' });
try {
  await waitForDatabase(pool);
  const applied = await runMigrations(pool, { log: m => console.log(`  ${m}`) });
  const s = await migrationStatus(pool);
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Schema already up to date.');
  console.log(`Schema version: ${s.applied.at(-1)?.version ?? 0} (latest ${s.latest})`);
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
