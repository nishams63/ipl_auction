// Shared helpers for self-contained integration tests.
// - Spawns real server processes on free ports with isolated temp storage, so tests never
//   touch server/data/persisted_rooms.json.
// - Tracks every child process, socket, RoomManager and temp directory it creates and
//   cleans them all up in finish(), and again on process exit as a safety net.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', '..', 'server', 'index.js');

const tracked = { children: new Set(), sockets: new Set(), managers: new Set(), tempDirs: new Set(), asyncCleanups: [] };

// Async teardown (e.g. closing a PostgreSQL pool, dropping a test database), run by cleanupAll
// after servers and managers have stopped, in reverse registration order.
export function registerAsyncCleanup(fn) { tracked.asyncCleanups.push(fn); }

// ── temp files ────────────────────────────────────────────────
export function tempStorageFile(label = 'test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ipl-${label}-`));
  tracked.tempDirs.add(dir);
  return path.join(dir, 'rooms.json');
}

function removeTempDirs() {
  for (const dir of tracked.tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tracked.tempDirs.clear();
}

// ── servers ───────────────────────────────────────────────────
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start a real server process. Rejects (after killing the child) if /api/health does not
 * answer 200 within timeoutMs or the process exits early; the error includes captured logs.
 */
export async function startServer({ storageFile = tempStorageFile('srv'), port, env = {}, timeoutMs = 10000 } = {}) {
  port = port || await freePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), ROOM_STORAGE_FILE: storageFile, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  tracked.children.add(child);
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; tracked.children.delete(child); });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  while (Date.now() < deadline && !exited) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) { healthy = true; break; }
    } catch { /* not listening yet */ }
    await sleep(100);
  }

  const stop = () => new Promise(resolve => {
    if (exited || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
  });

  if (!healthy) {
    // Decide the reason BEFORE stopping, or our own SIGTERM would look like an early exit
    const why = exited ? `process exited early (code ${exited.code}, signal ${exited.signal})` : `no healthy response within ${timeoutMs} ms`;
    await stop();
    throw new Error(`startServer failed on port ${port}: ${why}\n--- server log ---\n${log || '(empty)'}\n------------------`);
  }
  return { url, port, storageFile, getLog: () => log, stop, child };
}

// ── sockets ───────────────────────────────────────────────────
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function connect(url, { reconnection = false, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['websocket'], reconnection, forceNew: true, reconnectionDelay: 100, reconnectionDelayMax: 300 });
    tracked.sockets.add(s);
    const t = setTimeout(() => reject(new Error(`socket connect timeout to ${url}`)), timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('connect_error', err => { if (!reconnection) { clearTimeout(t); reject(err); } });
  });
}

// Every server handler acks. A missing ack is a server fault, NOT a rejection, so it throws:
// otherwise "must be rejected" assertions would pass on silence (false positive).
export function emit(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for "${event}" within ${timeoutMs} ms (server did not respond)`)), timeoutMs);
    socket.emit(event, payload, res => { clearTimeout(t); resolve(res); });
  });
}

// A real refusal: the server answered with success:false AND a non-empty reason
export function assertRejected(res, label = 'action') {
  if (!res || res.success !== false || typeof res.error !== 'string' || res.error.length === 0) {
    throw new Error(`${label} was not explicitly rejected: ${JSON.stringify(res)?.slice(0, 300)}`);
  }
}

export function waitFor(socket, event, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, h); reject(new Error(`timeout waiting for ${event}`)); }, timeoutMs);
    function h(data) {
      if (predicate(data)) { clearTimeout(t); socket.off(event, h); resolve(data); }
    }
    socket.on(event, h);
  });
}

export async function createRoom(url, { hostName = 'Host', hostToken, config = {} }) {
  const r = await fetch(`${url}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostName, hostToken, config })
  });
  return { status: r.status, body: await r.json() };
}

// ── RoomManager (unit tests) ─────────────────────────────────
export function trackManager(rm) { tracked.managers.add(rm); return rm; }

export const mockIo = () => ({ to: () => ({ emit: () => {} }), emit: () => {}, sockets: { sockets: new Map() } });

// ── cleanup ───────────────────────────────────────────────────
export async function cleanupAll() {
  for (const s of tracked.sockets) { try { s.io.opts.reconnection = false; s.close(); } catch { /* ignore */ } }
  tracked.sockets.clear();
  for (const rm of tracked.managers) { try { await rm.shutdown(); } catch { /* ignore */ } }
  tracked.managers.clear();
  await Promise.all([...tracked.children].map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
  })));
  tracked.children.clear();
  while (tracked.asyncCleanups.length) {
    const fn = tracked.asyncCleanups.pop();
    try { await fn(); } catch (err) { console.error(`cleanup failed: ${err.message}`); }
  }
  removeTempDirs();
}

// Safety net if a test crashes before finish(): no orphaned servers or temp files
process.on('exit', () => {
  for (const child of tracked.children) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  removeTempDirs();
});

// ── minimal runner with honest pass/fail counting ────────────
export function makeRunner(title) {
  const results = [];
  console.log(`\n🧪 ${title}\n`);
  return {
    async it(name, fn) {
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ✅ PASS: ${name}`);
      } catch (err) {
        results.push({ name, ok: false, err });
        console.log(`  ❌ FAIL: ${name}\n     → ${String(err.message).split('\n').join('\n       ')}`);
      }
    },
    // Cleans up everything, prints a summary and returns the failure count
    async finish() {
      await cleanupAll();
      const failed = results.filter(r => !r.ok).length;
      if (results.length === 0) console.log('\n⏭️  No checks were run.\n');
      else console.log(`\n${failed === 0 ? '🎉' : '⚠️'} ${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}\n`);
      return failed;
    }
  };
}

export const strongToken = label => `usr_${label}_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

// Deep-scan helper for privacy tests: returns every path where a forbidden key or value appears
export function findPrivateData(payload, { secrets = [], forbiddenKeys = [] } = {}, at = '$') {
  const hits = [];
  if (payload === null || payload === undefined) return hits;
  if (typeof payload === 'string') {
    for (const sec of secrets) if (sec && payload.includes(sec)) hits.push(`${at} contains secret value`);
    return hits;
  }
  if (typeof payload !== 'object') return hits;
  for (const [k, v] of Object.entries(payload)) {
    if (forbiddenKeys.includes(k)) hits.push(`${at}.${k} (forbidden key)`);
    hits.push(...findPrivateData(v, { secrets, forbiddenKeys }, `${at}.${k}`));
  }
  return hits;
}
