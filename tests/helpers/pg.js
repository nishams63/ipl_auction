// Disposable PostgreSQL for integration tests. NEVER a production database.
//
// Where the database comes from (first match wins):
//   1. TEST_DATABASE_URL — an admin URL for a DISPOSABLE server. Only localhost is accepted
//      (set ALLOW_REMOTE_TEST_DB=1 for a remote throwaway server); hosted-provider hosts such as
//      *.neon.tech are always refused, as is any URL equal to DATABASE_URL.
//   2. embedded-postgres, if installed (npm i --no-save embedded-postgres): a temporary
//      cluster in the OS temp directory, deleted afterwards.
//   3. otherwise: suites report SKIPPED. A skipped suite is NOT a pass, and the runner says
//      clearly that PostgreSQL integration was not verified.
// Every suite gets its own freshly created database, dropped at the end.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import { freePort, registerAsyncCleanup, startServer, sleep } from './harness.js';

const FORBIDDEN_HOSTS = /(neon\.tech|neon\.build|amazonaws\.com|render\.com|supabase\.(co|com)|azure\.com|googleapis\.com|cockroachlabs)/i;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertSafeTestUrl(url, env = process.env) {
  let u;
  try { u = new URL(url); } catch { throw new Error('TEST_DATABASE_URL is not a valid URL'); }
  if (FORBIDDEN_HOSTS.test(u.hostname)) {
    throw new Error(`Refusing to run tests against ${u.hostname}: hosted/production database hosts are never used by the test suite`);
  }
  if (!LOCAL_HOSTS.has(u.hostname) && env.ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error(`Refusing non-local test database host ${u.hostname} (set ALLOW_REMOTE_TEST_DB=1 for a disposable remote server)`);
  }
  if (env.DATABASE_URL && env.DATABASE_URL === url) {
    throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL');
  }
  return u;
}

let embedded = null;

/** Start a temporary embedded cluster; returns its admin URL (or null if not installed). */
export async function startEmbeddedCluster() {
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-embedded-pg-'));
  const password = crypto.randomBytes(12).toString('hex');
  const instance = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'), user: 'ipltest', password, port, persistent: false,
    onLog: () => {}, onError: () => {}
  });
  await instance.initialise();
  await instance.start();
  embedded = { instance, dir };
  return `postgres://ipltest:${password}@127.0.0.1:${port}/postgres`;
}

export async function stopEmbeddedCluster() {
  if (!embedded) return;
  const { instance, dir } = embedded;
  embedded = null;
  try { await instance.stop(); } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

let adminUrlPromise = null;
/** Admin URL of a disposable server, or null when none is available. */
export function getAdminUrl() {
  if (!adminUrlPromise) {
    adminUrlPromise = (async () => {
      if (process.env.TEST_DATABASE_URL) {
        assertSafeTestUrl(process.env.TEST_DATABASE_URL);
        return process.env.TEST_DATABASE_URL;
      }
      const url = await startEmbeddedCluster();
      if (url) registerAsyncCleanup(stopEmbeddedCluster);
      return url;
    })();
  }
  return adminUrlPromise;
}

export function describeSource() {
  return process.env.TEST_DATABASE_URL ? 'TEST_DATABASE_URL (local disposable server)' : 'embedded-postgres (temporary cluster)';
}

/** Create a fresh, uniquely named database. Dropped automatically by cleanupAll(). */
export async function createTestDatabase(label = 'test') {
  const admin = await getAdminUrl();
  if (!admin) return null;
  const name = `ipl_test_${label.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}_${crypto.randomBytes(4).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  try { await c.query(`CREATE DATABASE ${name}`); } finally { await c.end(); }
  const u = new URL(admin);
  u.pathname = `/${name}`;
  const url = u.toString();
  registerAsyncCleanup(async () => {
    const d = new pg.Client({ connectionString: admin });
    await d.connect();
    try { await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await d.end(); }
  });
  return { url, name };
}

/**
 * Start a server in PostgreSQL mode and wait until it is ACTIVE (holds the writer lease and
 * has restored all rooms). A short lease TTL keeps crash-takeover tests fast.
 */
export async function startPgServer(env, { timeoutMs = 20000, storageFile } = {}) {
  const srv = await startServer({ env: { DB_LEASE_TTL_MS: '2000', ...env }, timeoutMs, ...(storageFile ? { storageFile } : {}) });
  await waitForStatus(srv.url, ['ok', 'degraded'], timeoutMs);
  return srv;
}

export async function waitForStatus(url, statuses, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await (await fetch(`${url}/api/health`)).json();
      if (statuses.includes(last.status)) return last;
    } catch { /* restarting */ }
    await sleep(100);
  }
  throw new Error(`server did not reach ${statuses.join('/')} (last: ${JSON.stringify(last?.status)})`);
}

/**
 * Standard preamble for a PostgreSQL integration suite: returns a database or prints the
 * SKIPPED marker the runner recognises (and the suite should then exit 0 without checks).
 */
export async function requireTestDatabase(label) {
  let db;
  try {
    db = await createTestDatabase(label);
  } catch (err) {
    console.log(`  ❌ FAIL: could not create a disposable test database → ${err.message}`);
    process.exitCode = 1;
    return null;
  }
  if (!db) {
    console.log('  ⏭️  SKIPPED: no disposable PostgreSQL available (set TEST_DATABASE_URL to a local server or `npm i --no-save embedded-postgres`). PostgreSQL integration NOT verified by this run.');
    return null;
  }
  console.log(`  (real PostgreSQL: ${describeSource()}, database ${db.name})`);
  return db;
}
