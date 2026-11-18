// Storage selection. Exactly ONE authority per process:
//   PERSISTENCE unset / "json"  → temporary JSON file (current default, non-durable on Render)
//   PERSISTENCE = "postgres"    → PostgreSQL via DATABASE_URL; the JSON file is never touched
// There is no automatic fallback from PostgreSQL to JSON: if PostgreSQL is selected but cannot
// be used, startup fails loudly, because silently switching authority would hide data.
import { PostgresStore } from './postgresStore.js';
import { tokenHashSecretProblem } from './tokenHash.js';

export class StorageConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

export function resolveStorageMode(env = process.env) {
  const raw = (env.PERSISTENCE ?? '').trim().toLowerCase();
  const mode = raw === '' ? 'json' : raw;
  if (!['json', 'postgres'].includes(mode)) {
    throw new StorageConfigError(`PERSISTENCE must be "json" or "postgres" (got "${env.PERSISTENCE}")`);
  }
  if (mode === 'postgres' && !env.DATABASE_URL) {
    throw new StorageConfigError('PERSISTENCE=postgres requires DATABASE_URL');
  }
  if (mode === 'postgres') {
    const problem = tokenHashSecretProblem(env);
    if (problem) throw new StorageConfigError(problem);
  }
  const warnings = [];
  if (mode === 'json' && env.DATABASE_URL) {
    warnings.push('DATABASE_URL is set but PERSISTENCE is not "postgres": using the JSON file. PostgreSQL is NOT being used.');
  }
  return { mode, warnings };
}

const bool = v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/** Build and initialise the configured store. Returns { mode, store|null, warnings }. */
export async function createStorageFromEnv(env = process.env, { log = console.log } = {}) {
  const { mode, warnings } = resolveStorageMode(env);
  if (mode === 'json') return { mode, store: null, warnings };

  const poolMax = Number.parseInt(env.PG_POOL_MAX ?? '5', 10);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 50) {
    throw new StorageConfigError('PG_POOL_MAX must be an integer between 1 and 50');
  }
  const connectAttempts = Number.parseInt(env.DB_CONNECT_ATTEMPTS ?? '6', 10);
  if (!Number.isInteger(connectAttempts) || connectAttempts < 1 || connectAttempts > 20) {
    throw new StorageConfigError('DB_CONNECT_ATTEMPTS must be an integer between 1 and 20');
  }
  const leaseTtlMs = Number.parseInt(env.DB_LEASE_TTL_MS ?? '30000', 10);
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 2000 || leaseTtlMs > 300000) {
    throw new StorageConfigError('DB_LEASE_TTL_MS must be an integer between 2000 and 300000');
  }
  const store = new PostgresStore({
    connectionString: env.DATABASE_URL,
    poolMax,
    connectAttempts,
    lease: true, // single writer: the server must hold the lease to save anything
    leaseTtlMs,
    autoMigrate: bool(env.DB_AUTO_MIGRATE),
    env
  });
  try {
    await store.init({ log });
  } catch (err) {
    try { await store.pool.end(); } catch { /* ignore */ }
    throw err;
  }
  return { mode, store, warnings };
}
