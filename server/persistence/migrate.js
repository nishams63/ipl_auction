// Versioned schema migrations.
//
// Files: server/persistence/migrations/NNN_name.sql, applied in numeric order, each in its own
// transaction, recorded in schema_migrations with a sha256 checksum. A transaction-scoped
// advisory lock makes concurrent runs (two instances starting at once) safe. An applied
// migration whose file was later edited is reported as a checksum mismatch and blocks startup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_LOCK_KEY = 7428190331; // arbitrary constant for pg_advisory_xact_lock

export class MigrationError extends Error {}

export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map(file => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
      return {
        version: Number(file.slice(0, 3)),
        name: file.replace(/\.sql$/, ''),
        file,
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex')
      };
    });
}

const BOOTSTRAP = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

async function appliedMigrations(client) {
  const exists = await client.query(`SELECT to_regclass('public.schema_migrations') AS t`);
  if (!exists.rows[0].t) return [];
  const r = await client.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
  return r.rows;
}

/** Report applied / pending / modified migrations without changing anything. */
export async function migrationStatus(pool, { dir } = {}) {
  const files = listMigrationFiles(dir);
  const client = await pool.connect();
  const onError = () => {}; // dropped connection: the pending query rejects; don't crash the process
  client.on('error', onError);
  try {
    const applied = await appliedMigrations(client);
    const byVersion = new Map(applied.map(a => [a.version, a]));
    const mismatched = files.filter(f => byVersion.has(f.version) && byVersion.get(f.version).checksum !== f.checksum)
      .map(f => f.name);
    const unknown = applied.filter(a => !files.some(f => f.version === a.version)).map(a => a.name);
    const pending = files.filter(f => !byVersion.has(f.version)).map(f => f.name);
    return {
      applied: applied.map(a => ({ version: a.version, name: a.name, appliedAt: a.applied_at })),
      pending,
      mismatched,
      unknown,
      latest: files.length ? files[files.length - 1].version : 0,
      upToDate: pending.length === 0 && mismatched.length === 0 && unknown.length === 0
    };
  } finally {
    client.off('error', onError);
    client.release();
  }
}

/** Apply every pending migration. Returns the names applied (empty when up to date). */
export async function runMigrations(pool, { dir, log = () => {} } = {}) {
  const files = listMigrationFiles(dir);
  const appliedNow = [];
  for (const m of files) {
    const done = await withTransaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(BOOTSTRAP);
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [m.version]);
      if (existing.rowCount > 0) {
        if (existing.rows[0].checksum !== m.checksum) {
          throw new MigrationError(`Migration ${m.name} was modified after it was applied (checksum mismatch). Restore the original file; add a new migration instead.`);
        }
        return false;
      }
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [m.version, m.name, m.checksum]);
      return true;
    }, { statementTimeoutMs: 120000 });
    if (done) {
      appliedNow.push(m.name);
      log(`applied ${m.name}`);
    }
  }
  return appliedNow;
}

/** Throw unless the schema is exactly at the latest migration. */
export async function assertSchemaUpToDate(pool, opts) {
  const s = await migrationStatus(pool, opts);
  if (s.mismatched.length) throw new MigrationError(`Modified migration(s): ${s.mismatched.join(', ')}`);
  if (s.unknown.length) throw new MigrationError(`Database has migration(s) this code does not know: ${s.unknown.join(', ')} (is this an older build?)`);
  if (s.pending.length) throw new MigrationError(`Pending migration(s): ${s.pending.join(', ')}. Run "npm run db:migrate" (or set DB_AUTO_MIGRATE=true).`);
  return s;
}
