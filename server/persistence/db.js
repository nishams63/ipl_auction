// PostgreSQL connection layer (Neon-compatible).
//
//  * One shared pg.Pool. Queries are always parameterized ($1, $2 …) and never use named
//    prepared statements, so they work through PgBouncer/Neon's pooler in transaction mode.
//  * Every write runs inside a short transaction (withTransaction). Locks are transaction-scoped
//    (pg_advisory_xact_lock), never session-scoped, for the same pooler reason.
//  * Transient failures (dropped connection, serialization failure, deadlock, Neon waking up)
//    are retried with exponential backoff. Anything else is raised immediately.
import pg from 'pg';

const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57P01', // admin_shutdown (e.g. pg_terminate_backend, Neon compute restart)
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up)
  '08000', '08003', '08006', '08001', '08004', // connection exceptions
  '53300'  // too_many_connections
]);
const TRANSIENT_NODE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

export function isTransientError(err) {
  if (!err) return false;
  if (TRANSIENT_SQLSTATES.has(err.code) || TRANSIENT_NODE_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return /Connection terminated|connection timeout|Client has encountered a connection error|terminating connection/i.test(msg);
}

// Database target for logs/reports with credentials removed: "host:port/dbname"
export function describeDatabaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export function createPool(connectionString, { max = 5, applicationName = 'ipl-auction', ...rest } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL persistence');
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    application_name: applicationName,
    ...rest
  });
  // Neon/poolers close idle connections. An idle client error must not crash the process;
  // the pool discards that client and the next query gets a fresh one.
  pool.on('error', err => {
    console.error(`[db] idle connection error (discarded): ${err.code || ''} ${err.message}`);
  });
  return pool;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Run fn(client) in a transaction. COMMIT on success, ROLLBACK on any error.
 * statementTimeoutMs bounds every statement (SET LOCAL: transaction-scoped, pooler-safe).
 */
export async function withTransaction(pool, fn, { statementTimeoutMs = 15000 } = {}) {
  const client = await pool.connect();
  let broken = false;
  // A connection dropped mid-query (e.g. Neon restarting a compute) makes the client emit
  // 'error' in addition to rejecting the query. Without a listener that event would crash the
  // process; the query rejection is what we handle (and retry).
  const onError = () => { broken = true; };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(statementTimeoutMs))}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // connection is gone; don't return it to the pool
    }
    if (isTransientError(err)) broken = true;
    throw err;
  } finally {
    client.off('error', onError);
    client.release(broken ? true : undefined);
  }
}

/** Retry fn() on transient errors: attempts total, exponential backoff with jitter. */
export async function withRetry(fn, { attempts = 4, baseDelayMs = 200, maxDelayMs = 3000, onRetry } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i === attempts) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (i - 1)) * (0.75 + Math.random() * 0.5);
      if (onRetry) onRetry(err, i, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Wait until the database answers (Neon computes can take a few seconds to wake). */
export async function waitForDatabase(pool, { attempts = 6, baseDelayMs = 500 } = {}) {
  return withRetry(async () => {
    await pool.query('SELECT 1');
  }, { attempts, baseDelayMs, maxDelayMs: 5000 });
}
