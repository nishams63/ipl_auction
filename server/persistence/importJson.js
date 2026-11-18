// One-way import of a JSON save file (persisted_rooms.json format) into PostgreSQL.
//
// Safety properties
//  * The source is only READ: it is copied to a temporary snapshot, every room is read from
//    that snapshot, and the source's sha256 is re-checked at the end (reported).
//  * Each room is imported in its own transaction: a room is either fully imported or not at all.
//  * Idempotent: a room already imported with the same content (sha256) is skipped; a room
//    already quarantined with the same content is skipped.
//  * Resumable: an interrupted run leaves only whole rooms behind; re-running continues where it
//    stopped (earlier runs still marked "running" are recorded as "interrupted").
//  * Nothing is silently dropped. Every room ends up imported, skipped (already present with
//    identical content), or QUARANTINED: stored verbatim (exact original text) in
//    quarantined_rooms with the reason. Duplicate keys in the file (which JSON.parse would
//    silently collapse) are detected from the raw text and every occurrence is quarantined.
//  * Existing database rooms are never overwritten: a different room with the same code is a
//    conflict and the incoming copy is quarantined.
//  * The same restore logic as the server is applied (shape check, re-linking, legacy Playing XI
//    cleanup), so imported rooms behave exactly as the JSON loader would load them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareRestoredRoom } from '../roomManager.js';
import { roomToRows } from './roomMapper.js';
import { upsertRows, ensureTokenHashScheme } from './postgresStore.js';
import { tokenHashSecretProblem } from './tokenHash.js';
import { assertSchemaUpToDate } from './migrate.js';
import { isTransientError } from './db.js';

export const IMPORT_TOOL_VERSION = 'import-json/1';
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Split the top-level object of a JSON document into its raw entries, IN FILE ORDER and
 * INCLUDING duplicate keys (JSON.parse keeps only the last duplicate, silently).
 * The document must already be valid JSON. Returns [{ key, raw }].
 */
export function scanTopLevelEntries(text) {
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && ' \t\n\r'.includes(text[i])) i++; };
  const readString = () => {
    const start = i;
    i++;
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      i++;
      if (ch === '"') return text.slice(start, i);
    }
    throw new Error('unterminated string');
  };
  const readValue = () => {
    ws();
    const start = i;
    const ch = text[i];
    if (ch === '"') { readString(); return text.slice(start, i); }
    if (ch === '{' || ch === '[') {
      let depth = 0;
      while (i < n) {
        const c = text[i];
        if (c === '"') { readString(); continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
          depth--;
          if (depth === 0) { i++; return text.slice(start, i); }
        }
        i++;
      }
      throw new Error('unterminated value');
    }
    while (i < n && !',}] \t\n\r'.includes(text[i])) i++;
    return text.slice(start, i);
  };

  ws();
  if (text[i] !== '{') throw new Error('top level is not an object of rooms');
  i++;
  const entries = [];
  ws();
  if (text[i] === '}') return entries;
  for (;;) {
    ws();
    if (text[i] !== '"') throw new Error(`expected a room key at offset ${i}`);
    const key = JSON.parse(readString());
    ws();
    if (text[i] !== ':') throw new Error(`expected ':' at offset ${i}`);
    i++;
    entries.push({ key, raw: readValue() });
    ws();
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '}') break;
    throw new Error(`unexpected character at offset ${i}`);
  }
  return entries;
}

async function inTransaction(pool, commit, fn) {
  const c = await pool.connect();
  let broken = false;
  const onError = () => { broken = true; }; // see withTransaction: never crash on a dropped connection
  c.on('error', onError);
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL statement_timeout = 60000');
    const result = await fn(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { broken = true; }
    throw err;
  } finally {
    c.off('error', onError);
    c.release(broken ? true : undefined);
  }
}

async function insertImportedRoom(c, rows, checksum) {
  const r = rows.room;
  const cols = ['room_code', 'status', 'host_name', 'host_token_hash', 'config', 'current_player_index', 'current_lot',
    'current_lot_player_id', 'evaluation_results', 'audit_seq', 'extra', 'created_at'];
  const json = new Set(['config', 'current_lot', 'evaluation_results', 'extra']);
  const params = cols.map(col => (json.has(col) ? (r[col] === null ? null : JSON.stringify(r[col])) : r[col]));
  params.push(checksum);
  await c.query(`INSERT INTO rooms (${cols.join(', ')}, version, source, source_checksum, last_write_id)
    VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, 1, 'json-import', $${cols.length + 1}, 'json-import')`, params);
  for (const t of ['franchises', 'participants', 'room_players', 'squad_entries']) await upsertRows(c, t, rows[t]);
  await upsertRows(c, 'lineups', rows.lineups.map(l => l.row));
  await upsertRows(c, 'lineup_players', rows.lineups.flatMap(l => l.players));
  for (const t of ['bids', 'lot_results', 'audit_logs']) await upsertRows(c, t, rows[t]);
}

/**
 * Import a JSON save file.
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {string} o.file          path of the JSON file (use a COPY of the live file)
 * @param {boolean} [o.dryRun]     everything is rolled back; the database is not changed
 * @param {string} [o.reportPath]  where to write the JSON report (optional)
 * @param {number} [o.crashAfterRooms] TEST ONLY: simulate a crash after N committed rooms
 * @param {Function} [o.onCrash]   TEST ONLY: called instead of throwing when crashing
 */
export async function importJsonFile({ pool, file, dryRun = false, reportPath = null, log = () => {}, crashAfterRooms = null, onCrash = null, allowWhileServerRunning = false }) {
  const startedAt = new Date().toISOString();
  const sourceName = path.basename(file);
  const before = fs.readFileSync(file);
  const sha256Before = sha256(before);

  // Work from a private snapshot so the source is never held open or touched again
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-import-'));
  const snapshot = path.join(snapDir, 'source.json');
  fs.copyFileSync(file, snapshot, fs.constants.COPYFILE_EXCL);
  const buf = fs.readFileSync(snapshot);
  if (sha256(buf) !== sha256Before) throw new Error('snapshot does not match the source file');

  const report = {
    tool: IMPORT_TOOL_VERSION,
    startedAt,
    finishedAt: null,
    dryRun,
    status: 'running',
    source: { name: sourceName, bytes: before.length, sha256Before, sha256After: null, unchanged: null },
    runId: null,
    counts: { total: 0, imported: 0, skipped: 0, quarantined: 0, failed: 0 },
    notes: [],
    rooms: []
  };
  const finish = (status, error) => {
    report.status = status;
    if (error) report.error = error;
    report.finishedAt = new Date().toISOString();
    const after = fs.readFileSync(file);
    report.source.sha256After = sha256(after);
    report.source.unchanged = report.source.sha256After === sha256Before;
    if (!report.source.unchanged) report.notes.push('WARNING: the source file changed while the import was running. Re-run against a stable copy.');
    try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { /* best effort */ }
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    }
    return report;
  };

  let text = buf.toString('utf-8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    report.notes.push('Source file starts with a UTF-8 byte-order mark; it was ignored for parsing.');
  }
  let entries;
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error('top level is not an object of rooms');
    entries = scanTopLevelEntries(text);
  } catch (err) {
    log(`source file is not readable JSON: ${err.message}`);
    return finish('failed', `UNREADABLE_SOURCE: ${err.message}`);
  }

  await assertSchemaUpToDate(pool);

  // Tokens are hashed with TOKEN_HASH_SECRET exactly as the server would. A different secret
  // than the database was set up with (or than the server will use) would lock everyone out,
  // so the same scheme/verifier check runs here (a dry run only verifies).
  const secretProblem = tokenHashSecretProblem(process.env);
  if (secretProblem) return finish('failed', `TOKEN_HASH_SECRET_INVALID: ${secretProblem}`);
  try {
    await ensureTokenHashScheme(pool, process.env, { record: !dryRun });
  } catch (err) {
    return finish('failed', `TOKEN_HASH_MISMATCH: ${err.message}`);
  }

  // A live server (fresh writer lease) would not see imported rooms until it restarts, and could
  // create a room with a code being imported. Import before switching the server over.
  if (!dryRun && !allowWhileServerRunning) {
    const lease = await pool.query(`SELECT 1 FROM storage_meta WHERE key = 'writer_lease' AND updated_at > now() - interval '5 minutes'`);
    if (lease.rowCount > 0) {
      log('a server instance currently holds the writer lease (it is running against this database)');
      return finish('failed', 'SERVER_RUNNING: stop the server (or import before enabling PERSISTENCE=postgres), or pass --allow-while-server-running');
    }
  }

  const occurrences = new Map();
  for (const e of entries) occurrences.set(e.key, (occurrences.get(e.key) || 0) + 1);
  const byUpper = new Map();
  for (const key of occurrences.keys()) {
    const u = String(key).toUpperCase();
    if (!byUpper.has(u)) byUpper.set(u, []);
    byUpper.get(u).push(key);
  }
  for (const [u, keys] of byUpper) {
    if (keys.length > 1) report.notes.push(`Room codes differing only by letter case: ${keys.join(', ')} (the server looks rooms up as ${u}).`);
  }
  for (const [key, count] of occurrences) {
    if (count > 1) report.notes.push(`Room key ${key} appears ${count} times in the file; JSON.parse would keep only the last copy. Every copy is quarantined.`);
  }

  if (!dryRun) {
    await pool.query(`UPDATE migration_runs SET status = 'interrupted', finished_at = now() WHERE status = 'running'`);
    const r = await pool.query(`INSERT INTO migration_runs (status, source_name, source_sha256, source_bytes, tool_version)
      VALUES ('running', $1, $2, $3, $4) RETURNING run_id`, [sourceName, sha256Before, before.length, IMPORT_TOOL_VERSION]);
    report.runId = Number(r.rows[0].run_id);
  }

  const seen = new Map();
  let committedRooms = 0;
  try {
    for (const { key, raw } of entries) {
      const occurrence = (seen.get(key) || 0) + 1;
      seen.set(key, occurrence);
      const checksum = sha256(JSON.stringify(JSON.parse(raw)));
      const entry = { code: key, occurrence, outcome: null, reason: null, checksum, warnings: [], legacyCleanup: false, repairs: [] };

      const result = await inTransaction(pool, !dryRun, async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [String(key)]);
        const logRow = async (outcome, reason) => {
          entry.outcome = outcome;
          entry.reason = reason;
          if (report.runId !== null) {
            await c.query(`INSERT INTO migration_room_log (run_id, room_code, occurrence, outcome, reason, checksum)
              VALUES ($1, $2, $3, $4, $5, $6)`, [report.runId, key, occurrence, outcome, reason, checksum]);
          }
          return outcome;
        };
        const quarantine = async reason => {
          await c.query(`INSERT INTO quarantined_rooms (room_code, occurrence, checksum, reason, source, original_text)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (room_code, checksum) DO NOTHING`,
          [key, occurrence, checksum, reason, `json-import:${sourceName}`, raw]);
          return logRow('quarantined', reason);
        };

        const q = await c.query('SELECT reason FROM quarantined_rooms WHERE room_code = $1 AND checksum = $2', [key, checksum]);
        if (q.rowCount > 0) return logRow('skipped', `ALREADY_QUARANTINED (${q.rows[0].reason})`);

        if (occurrences.get(key) > 1) {
          return quarantine(`DUPLICATE_ROOM_KEY: key appears ${occurrences.get(key)} times in the file (this is copy ${occurrence})`);
        }
        if (!/^[A-Z0-9]{4,12}$/.test(key)) {
          return quarantine(`INVALID_ROOM_CODE: ${JSON.stringify(key)} is not a valid room code`);
        }
        const existing = await c.query('SELECT source_checksum, version FROM rooms WHERE room_code = $1', [key]);
        if (existing.rowCount > 0) {
          if (existing.rows[0].source_checksum === checksum) return logRow('skipped', 'ALREADY_IMPORTED');
          return quarantine('CONFLICT_ROOM_EXISTS: a different room with this code is already in the database (left untouched)');
        }

        const room = JSON.parse(raw);
        if (isPlainObject(room) && room.roomCode !== undefined && room.roomCode !== key) {
          return quarantine(`ROOM_CODE_MISMATCH: stored under ${key} but its roomCode is ${JSON.stringify(room.roomCode)}`);
        }
        let prep;
        try {
          prep = prepareRestoredRoom(key, room);
        } catch (err) {
          return quarantine(`INVALID_ROOM_SHAPE: ${err.message}`);
        }
        if (room.roomCode === undefined) {
          room.roomCode = key;
          entry.warnings.push('roomCode field was missing; set from the room key');
        }
        entry.legacyCleanup = prep.cleaned;
        entry.repairs = prep.repairs;
        entry.rulesNormalized = prep.rulesNormalized || [];

        let rows;
        try {
          rows = roomToRows(room);
        } catch (err) {
          return quarantine(`CANNOT_STORE_FAITHFULLY: ${err.message}`);
        }
        try {
          await c.query('SAVEPOINT import_room');
          await insertImportedRoom(c, rows, checksum);
          await c.query('SET CONSTRAINTS ALL IMMEDIATE'); // check deferred constraints now, inside the savepoint
          await c.query('RELEASE SAVEPOINT import_room');
        } catch (err) {
          if (isTransientError(err)) throw err; // connection problem: abort the run (resumable)
          await c.query('ROLLBACK TO SAVEPOINT import_room');
          return quarantine(`DATABASE_CONSTRAINT: ${err.message}${err.constraint ? ` (${err.constraint})` : ''}`);
        }
        if (room.status === 'active') entry.warnings.push('room was ACTIVE: the server will restore it PAUSED with the lot countdown reset (normal restart rule)');
        return logRow('imported', prep.cleaned || prep.repairs.length ? 'IMPORTED_WITH_RESTORE_FIXES' : 'IMPORTED');
      });

      report.counts.total++;
      report.counts[result]++;
      report.rooms.push(entry);
      log(`${key}${occurrences.get(key) > 1 ? `#${occurrence}` : ''}: ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ''}`);
      committedRooms++;
      if (crashAfterRooms !== null && committedRooms >= crashAfterRooms) {
        if (onCrash) return onCrash(report);
        throw new Error('SIMULATED_CRASH');
      }
    }
  } catch (err) {
    report.counts.failed++;
    if (report.runId !== null) {
      try {
        await pool.query(`UPDATE migration_runs SET status = 'failed', finished_at = now(), counts = $2, report = $3 WHERE run_id = $1`,
          [report.runId, JSON.stringify(report.counts), JSON.stringify(report)]);
      } catch { /* database unreachable: the run stays "running" and is marked interrupted next time */ }
    }
    log(`import stopped: ${err.message}. Already-imported rooms are complete; re-run to continue.`);
    finish('failed', err.message);
    throw Object.assign(err, { report });
  }

  const final = finish('completed');
  if (report.runId !== null) {
    await pool.query(`UPDATE migration_runs SET status = 'completed', finished_at = now(), counts = $2, report = $3 WHERE run_id = $1`,
      [report.runId, JSON.stringify(report.counts), JSON.stringify(final)]);
  }
  return final;
}
