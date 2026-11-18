// PostgreSQL room store (write-through from the in-memory RoomManager).
//
// Authority model: the RoomManager's in-memory room is the live authority while the process
// runs; PostgreSQL is the durable copy and the ONLY source on restart. The JSON file is never
// read or written in this mode.
//
// Write path (per room, serialized):
//   1. mutation → RoomManager marks the room dirty (debounced flush)
//   2. flush takes a synchronous snapshot of the room (roomToRows) — no torn state
//   3. one transaction: advisory lock on the room code → optimistic version check on rooms →
//      upsert only the rows whose content changed since the last successful write → delete
//      rows that disappeared (mutable tables only; bids/results/audit are never deleted)
//   4. on success the change cache advances; on failure nothing is committed, the room stays
//      dirty and is retried (transient errors with backoff)
//
// Guarantees: no partial room writes (single transaction); no lost updates between writers
// (version check → StorageConflictError, never an overwrite); no duplicate sales/bids/results
// (primary keys + unique constraints in the schema); a COMMIT whose acknowledgement was lost is
// recognised by last_write_id and adopted instead of being reported as a conflict.
import crypto from 'node:crypto';
import { createPool, withTransaction, withRetry, waitForDatabase, isTransientError, describeDatabaseUrl } from './db.js';
import { runMigrations, assertSchemaUpToDate } from './migrate.js';
import { roomToRows, rowsToRoom, TABLES, fingerprint, auditEntryToRow } from './roomMapper.js';
import { tokenHashScheme, tokenHashVerifier } from './tokenHash.js';

export class StorageConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageConflictError';
  }
}

// Mutable child tables (diff + delete) and append-only ones (diff, never delete)
const MUTABLE = ['franchises', 'participants', 'room_players', 'squad_entries'];
const APPEND_ONLY = ['bids', 'lot_results', 'audit_logs'];
const keyOf = (table, row) => TABLES[table].pk.filter(c => c !== 'room_code').map(c => row[c]).join('|');
const lineupKey = l => `${l.row.franchise_id}|${l.row.kind}`;

function jsonParam(v) {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

export async function upsertRows(client, table, rows, stats) {
  if (!rows.length) return;
  const { cols, pk, json } = TABLES[table];
  const update = cols.filter(c => !pk.includes(c));
  const perChunk = Math.max(1, Math.floor(20000 / cols.length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params = [];
    const tuples = chunk.map(row => `(${cols.map(c => {
      params.push(json.includes(c) ? jsonParam(row[c]) : (row[c] === undefined ? null : row[c]));
      return `$${params.length}`;
    }).join(', ')})`);
    const conflict = update.length
      ? `DO UPDATE SET ${update.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`
      : 'DO NOTHING';
    await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (${pk.join(', ')}) ${conflict}`, params);
  }
  if (stats) stats.upserted[table] = (stats.upserted[table] || 0) + rows.length;
}

async function deleteRows(client, table, code, keys, stats) {
  if (!keys.length) return;
  const cols = TABLES[table].pk.filter(c => c !== 'room_code');
  const params = [code];
  const tuples = keys.map(k => {
    const parts = String(k).split('|');
    return `(${cols.map((_, i) => { params.push(parts[i]); return `$${params.length}`; }).join(', ')})`;
  });
  await client.query(`DELETE FROM ${table} WHERE room_code = $1 AND (${cols.join(', ')}) IN (${tuples.join(', ')})`, params);
  if (stats) stats.deleted[table] = (stats.deleted[table] || 0) + keys.length;
}

// Change fingerprints for every row of a room (what the database holds after a write of rows)
function fingerprintsOf(rows) {
  const fps = { room: fingerprint(rows.room), lineups: new Map() };
  for (const t of [...MUTABLE, ...APPEND_ONLY]) {
    fps[t] = new Map(rows[t].map(r => [keyOf(t, r), fingerprint(r)]));
  }
  for (const l of rows.lineups) fps.lineups.set(lineupKey(l), fingerprint(l));
  return fps;
}

/**
 * Verify (and, when record is true, record) the session-token hashing scheme and secret
 * verifier in storage_meta. Throws on mismatch. Used by the server at startup and by the JSON
 * importer, so both always hash tokens the same way.
 */
export async function ensureTokenHashScheme(pool, env = process.env, { record = true } = {}) {
  const scheme = tokenHashScheme(env);
  const verifier = tokenHashVerifier(env);
  await withTransaction(pool, async c => {
    await c.query(`SELECT pg_advisory_xact_lock(7428190332)`);
    const r = await c.query(`SELECT key, value FROM storage_meta WHERE key IN ('token_hash_scheme', 'token_hash_check')`);
    const stored = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    if (stored.token_hash_scheme && stored.token_hash_scheme !== scheme) {
      throw new Error(`Token hash scheme mismatch: database uses "${stored.token_hash_scheme}", this process is configured for "${scheme}". ` +
        'Restore the original TOKEN_HASH_SECRET setting; changing it would lock every participant out of their rooms.');
    }
    if (stored.token_hash_check && stored.token_hash_check !== verifier) {
      throw new Error('Token hash secret mismatch: TOKEN_HASH_SECRET differs from the value the stored session hashes were made with. ' +
        'Restore the original secret from your backup; changing it would lock every participant out of their rooms.');
    }
    if (record && !stored.token_hash_scheme) await c.query(`INSERT INTO storage_meta (key, value) VALUES ('token_hash_scheme', $1)`, [scheme]);
    if (record && !stored.token_hash_check) await c.query(`INSERT INTO storage_meta (key, value) VALUES ('token_hash_check', $1)`, [verifier]);
  });
}

export class PostgresStore {
  /**
   * @param {object} o
   * @param {string} [o.connectionString] DATABASE_URL (or pass an existing pool)
   * @param {import('pg').Pool} [o.pool]
   * @param {boolean} [o.autoMigrate] apply pending migrations in init()
   * @param {Function} [o.faultInjector] TEST ONLY: async (stage, code, client) hook inside a write transaction
   */
  constructor({ connectionString, pool, poolMax = 5, autoMigrate = false, env = process.env, retry = {}, connectAttempts = 6, lease = false, leaseTtlMs = 30000, faultInjector = null } = {}) {
    this.ownsPool = !pool;
    this.pool = pool || createPool(connectionString, { max: poolMax });
    this.autoMigrate = autoMigrate;
    this.connectAttempts = connectAttempts;
    this.env = env;
    this.retry = { attempts: 4, baseDelayMs: 200, maxDelayMs: 3000, ...retry };
    this.faultInjector = faultInjector;
    this.instanceId = crypto.randomBytes(6).toString('hex');
    this.getRoom = () => null;
    this.hooks = {};
    // Single-writer lease (enabled for the server; see tryAcquireLease). When enabled, every
    // write transaction verifies this instance still holds it, so a second instance can never
    // commit room data.
    this.lease = lease;
    this.leaseTtlMs = leaseTtlMs;
    this.leaseHeld = false;
    this.heartbeatTimer = null;
    // Per-room change counters: seq increases on every change, committedSeq is the highest seq
    // contained in a committed transaction. "Is this change durable?" = committedSeq >= its seq.
    this.seq = new Map();
    this.committedSeq = new Map();
    this.dirty = new Set();
    this.inFlight = new Set();       // rooms whose write has started but not yet committed
    this.cache = new Map();          // code -> { version, fps }
    this.pendingAttempt = new Map(); // code -> { writeId, version, fps } (unacknowledged write)
    this.chains = new Map();         // code -> promise (per-room serialization)
    // Audit entries noted at append time and not yet written. Memory keeps only the newest 200
    // entries, so a burst could trim an entry before the next flush; this buffer keeps it.
    this.auditPending = new Map();   // code -> Map(seq -> entry)
    this.conflicts = new Set();
    this.retryTimer = null;
    this.retryDelayMs = 2000;
    this.closed = false;
    this.stats = { writes: 0, upserted: {}, deleted: {}, conflicts: 0, retries: 0, failures: 0 };
    this.status = {
      kind: 'postgres',
      durable: true,
      database: connectionString ? describeDatabaseUrl(connectionString) : '(provided pool)',
      warning: null,
      connected: false,
      schemaUpToDate: false,
      lastWriteAt: null,
      lastError: null,
      loadError: null,
      pendingWrites: 0,
      conflicts: [],
      quarantinedRooms: [],
      quarantineCopy: [],
      preservedCopy: null,
      role: lease ? 'starting' : 'active', // 'starting' | 'standby' | 'active'
      leaseHeld: false,
      leaseLost: false,
      roomsOnHold: []
    };
  }

  /** hooks: { onCommitted(code), onFailed(code, err), onLeaseLost() } */
  attach(getRoom, hooks = {}) {
    this.getRoom = getRoom;
    this.hooks = hooks;
  }

  callHook(name, ...args) {
    try {
      if (this.hooks[name]) this.hooks[name](...args);
    } catch (err) {
      console.error(`[db] ${name} handler failed: ${err.message}`);
    }
  }

  // ── single-writer lease ────────────────────────────────────────────────
  /**
   * Take the writer lease if it is free, expired, or already ours (one atomic statement, using
   * the database clock). Returns { acquired, holder }.
   */
  async tryAcquireLease() {
    const r = await this.pool.query(`
      INSERT INTO storage_meta (key, value, updated_at) VALUES ('writer_lease', $1, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        WHERE storage_meta.value = $1
           OR storage_meta.updated_at < now() - make_interval(secs => $2::double precision / 1000)
      RETURNING value`, [this.instanceId, this.leaseTtlMs]);
    if (r.rowCount === 1) {
      this.leaseHeld = true;
      this.status.leaseHeld = true;
      this.status.leaseLost = false;
      this.status.role = 'active';
      this.startHeartbeat();
      return { acquired: true, holder: this.instanceId };
    }
    const h = await this.pool.query(`SELECT value FROM storage_meta WHERE key = 'writer_lease'`);
    this.status.role = 'standby';
    return { acquired: false, holder: h.rows[0]?.value || null };
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const beat = async () => {
      try {
        const r = await this.pool.query(`UPDATE storage_meta SET updated_at = now() WHERE key = 'writer_lease' AND value = $1`, [this.instanceId]);
        if (r.rowCount === 0 && this.leaseHeld) this.loseLease('lease row no longer belongs to this instance');
      } catch (err) {
        this.status.connected = false; // the write path reports and retries; the lease may expire meanwhile
      }
    };
    this.heartbeatTimer = setInterval(beat, Math.max(500, Math.floor(this.leaseTtlMs / 3)));
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  loseLease(reason) {
    this.leaseHeld = false;
    this.status.leaseHeld = false;
    this.status.leaseLost = true;
    this.status.lastError = 'LEASE_LOST';
    console.error(`[db] WRITER LEASE LOST (${reason}). Another instance has taken over; this instance stops saving.`);
    this.callHook('onLeaseLost');
  }

  async releaseLease() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (!this.leaseHeld) return;
    try {
      await this.pool.query(`DELETE FROM storage_meta WHERE key = 'writer_lease' AND value = $1`, [this.instanceId]);
    } finally {
      this.leaseHeld = false;
      this.status.leaseHeld = false;
    }
  }

  async init({ log = console.log } = {}) {
    await waitForDatabase(this.pool, { attempts: this.connectAttempts });
    this.status.connected = true;
    if (this.autoMigrate) {
      const applied = await runMigrations(this.pool, { log: m => log(`[db] ${m}`) });
      if (applied.length) log(`[db] applied ${applied.length} migration(s)`);
    }
    await assertSchemaUpToDate(this.pool);
    this.status.schemaUpToDate = true;
    await this.checkTokenHashScheme();
  }

  /**
   * Refuse to run with different token hashing than the stored hashes were made with: a
   * different scheme (secret added/removed) OR a different secret value. The value check uses a
   * verifier = hash of a fixed constant under the configured scheme; it reveals nothing usable
   * about the secret (HMAC) and is never logged.
   */
  async checkTokenHashScheme() {
    return ensureTokenHashScheme(this.pool, this.env);
  }

  /**
   * Read every room in one consistent snapshot.
   * @returns {{ rooms: {code, room}[], failures: {code, error}[], quarantinedCodes: string[] }}
   */
  async loadAll() {
    const client = await this.pool.connect();
    const onError = err => console.error(`[db] connection error during load: ${err.message}`);
    client.on('error', onError);
    const q = sql => client.query(sql).then(r => r.rows);
    let data;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      data = {
        rooms: await q('SELECT * FROM rooms ORDER BY room_code'),
        franchises: await q('SELECT * FROM franchises'),
        participants: await q('SELECT * FROM participants'),
        room_players: await q('SELECT * FROM room_players'),
        squad_entries: await q('SELECT * FROM squad_entries'),
        lineups: await q('SELECT * FROM lineups'),
        lineup_players: await q('SELECT * FROM lineup_players'),
        bids: await q('SELECT * FROM bids'),
        lot_results: await q('SELECT * FROM lot_results'),
        audit_logs: await q(`SELECT * FROM (
            SELECT a.*, row_number() OVER (PARTITION BY room_code ORDER BY seq DESC) AS rn FROM audit_logs a
          ) x WHERE rn <= 200`),
        quarantined: await q('SELECT DISTINCT room_code FROM quarantined_rooms WHERE resolved_at IS NULL ORDER BY room_code')
      };
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      client.off('error', onError);
      client.release(true);
      throw err;
    }
    client.off('error', onError);
    client.release();

    const group = rows => {
      const m = new Map();
      for (const r of rows) {
        if (!m.has(r.room_code)) m.set(r.room_code, []);
        m.get(r.room_code).push(r);
      }
      return m;
    };
    const g = {};
    for (const t of ['franchises', 'participants', 'room_players', 'squad_entries', 'lineups', 'lineup_players', 'bids', 'lot_results', 'audit_logs']) {
      g[t] = group(data[t]);
    }

    const rooms = [];
    const failures = [];
    for (const row of data.rooms) {
      const code = row.room_code;
      try {
        const parts = { room: row };
        for (const t of Object.keys(g)) parts[t] = g[t].get(code) || [];
        const room = rowsToRoom(parts);
        // What the database holds now, as fingerprints: the next write only sends real changes
        this.cache.set(code, { version: row.version, fps: fingerprintsOf(roomToRows(room, { env: this.env })) });
        rooms.push({ code, room });
      } catch (err) {
        failures.push({ code, error: err.message });
      }
    }
    return { rooms, failures, quarantinedCodes: data.quarantined.map(r => r.room_code) };
  }

  /** Called by RoomManager for every audit entry it appends (see addAuditLog). */
  noteAudit(code, entry) {
    if (!entry || !Number.isInteger(entry.seq)) return;
    if (!this.auditPending.has(code)) this.auditPending.set(code, new Map());
    this.auditPending.get(code).set(entry.seq, entry);
  }

  markDirty(code) {
    this.dirty.add(code);
    this.seq.set(code, (this.seq.get(code) || 0) + 1);
    this.updatePending();
  }

  // Every change of this room so far is in a committed transaction
  isCommitted(code) {
    return (this.committedSeq.get(code) || 0) >= (this.seq.get(code) || 0);
  }

  /**
   * Write the room now and resolve true only when every change made BEFORE this call is in a
   * committed transaction (false: not durable — write failed, conflict, or lease lost).
   */
  async persistNow(code) {
    const target = this.seq.get(code) || 0;
    if ((this.committedSeq.get(code) || 0) >= target) return true;
    await this.flushRoom(code);
    return (this.committedSeq.get(code) || 0) >= target;
  }

  // A room that was never saved and must be forgotten (e.g. room creation that did not commit)
  forget(code) {
    this.dirty.delete(code);
    this.seq.delete(code);
    this.committedSeq.delete(code);
    this.auditPending.delete(code);
    this.updatePending();
  }

  // pendingWrites = rooms with unsaved changes, INCLUDING writes still in flight
  updatePending() {
    this.status.pendingWrites = new Set([...this.dirty, ...this.inFlight]).size;
  }

  /** Flush every dirty room. Resolves to true when everything is written. */
  async flushAll() {
    const codes = [...this.dirty];
    await Promise.all(codes.map(c => this.flushRoom(c)));
    this.updatePending();
    return this.dirty.size === 0;
  }

  flushRoom(code) {
    const prev = this.chains.get(code) || Promise.resolve();
    const next = prev.then(() => this.flushRoomNow(code));
    this.chains.set(code, next);
    next.finally(() => { if (this.chains.get(code) === next) this.chains.delete(code); }).catch(() => {});
    return next;
  }

  async flushRoomNow(code) {
    if (!this.dirty.has(code)) return;
    if (this.conflicts.has(code)) return; // stays dirty; needs operator attention (see runbook)
    const room = this.getRoom(code);
    if (!room) { this.dirty.delete(code); return; }

    let rows;
    let auditTaken = [];
    const snapSeq = this.seq.get(code) || 0; // every change up to here is in this snapshot
    try {
      rows = roomToRows(room, { env: this.env }); // synchronous snapshot
      // add audit entries that were already trimmed from memory but never written
      const pending = this.auditPending.get(code);
      if (pending && pending.size) {
        auditTaken = [...pending.keys()];
        const inRows = new Set(rows.audit_logs.map(r => r.seq));
        for (const [seq, entry] of pending) if (!inRows.has(seq)) rows.audit_logs.push(auditEntryToRow(code, entry));
      }
    } catch (err) {
      this.stats.failures++;
      this.status.lastError = `MAPPING_ERROR ${code}: ${err.message}`.slice(0, 300);
      console.error(`[db] room ${code} could not be converted for storage (kept in memory, not written): ${err.message}`);
      this.callHook('onFailed', code, err);
      return;
    }
    this.dirty.delete(code); // mutations from here on re-mark the room
    this.inFlight.add(code);
    this.updatePending();

    try {
      const written = await withRetry(
        () => withTransaction(this.pool, c => this.writeRoom(c, code, rows)),
        { ...this.retry, onRetry: (err, attempt) => { this.stats.retries++; console.warn(`[db] retrying write of room ${code} (attempt ${attempt + 1}): ${err.code || err.message}`); } }
      );
      this.cache.set(code, written);
      this.pendingAttempt.delete(code);
      this.committedSeq.set(code, Math.max(this.committedSeq.get(code) || 0, snapSeq));
      this.status.connected = true;
      const pending = this.auditPending.get(code);
      if (pending) {
        for (const seq of auditTaken) pending.delete(seq);
        if (pending.size === 0) this.auditPending.delete(code);
      }
      this.stats.writes++;
      this.status.lastWriteAt = new Date().toISOString();
      if (!this.status.leaseLost) this.status.lastError = null;
      this.retryDelayMs = 2000;
      this.inFlight.delete(code);
      this.callHook('onCommitted', code);
    } catch (err) {
      this.dirty.add(code);
      if (err instanceof StorageConflictError) {
        this.stats.conflicts++;
        this.conflicts.add(code);
        this.status.conflicts = [...this.conflicts];
        this.status.lastError = `CONFLICT ${code}`;
        console.error(`[db] CONFLICT for room ${code}: ${err.message}. The database copy was NOT overwritten; this room is no longer being saved by this instance.`);
      } else {
        this.stats.failures++;
        this.status.lastError = String(err.code || err.name || 'WRITE_FAILED');
        if (isTransientError(err)) this.status.connected = false;
        console.error(`[db] write of room ${code} failed (${err.code || ''} ${err.message}); it stays pending and will be retried.`);
        this.scheduleRetry();
      }
      this.inFlight.delete(code);
      this.callHook('onFailed', code, err);
    } finally {
      this.inFlight.delete(code);
      this.updatePending();
    }
  }

  scheduleRetry() {
    if (this.retryTimer || this.closed) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(30000, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flushAll().catch(() => {});
    }, delay);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  // One room, one transaction. rows = snapshot from roomToRows.
  async writeRoom(c, code, rows) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [code]);
    if (this.lease) {
      // Only the lease holder may commit. FOR SHARE also blocks a takeover until we commit.
      const l = await c.query(`SELECT 1 FROM storage_meta WHERE key = 'writer_lease' AND value = $1 FOR SHARE`, [this.instanceId]);
      if (l.rowCount === 0) {
        if (this.leaseHeld) this.loseLease('lease not held at write time');
        throw new StorageConflictError(`writer lease is not held by this instance (room ${code} not written)`);
      }
    }
    if (this.faultInjector) await this.faultInjector('afterLock', code, c);

    let cached = this.cache.get(code);
    const writeId = `${this.instanceId}:${crypto.randomBytes(4).toString('hex')}`;
    const fps = fingerprintsOf(rows);
    let version;

    if (!cached) {
      const r = await this.insertRoomRow(c, rows.room, writeId);
      if (r.rowCount === 0) {
        // Did an earlier attempt of ours commit without us seeing the acknowledgement?
        cached = await this.adoptUnacknowledgedWrite(c, code);
        if (!cached) throw new StorageConflictError(`room ${code} already exists in the database but is not loaded by this instance`);
      } else {
        version = 1;
      }
    }
    if (version === undefined) {
      let r = await this.updateRoomRow(c, rows.room, cached, fps, writeId);
      if (r.rowCount === 0) {
        const adopted = await this.adoptUnacknowledgedWrite(c, code);
        if (!adopted) throw new StorageConflictError(`room ${code} was changed by another writer (expected version ${cached.version})`);
        cached = adopted;
        r = await this.updateRoomRow(c, rows.room, cached, fps, writeId);
        if (r.rowCount === 0) throw new StorageConflictError(`room ${code} was changed by another writer`);
      }
      version = r.rows[0].version;
    }
    this.pendingAttempt.set(code, { writeId, version, fps });

    const prev = cached ? cached.fps : null;
    const stats = this.stats;
    for (const t of [...MUTABLE, ...APPEND_ONLY]) {
      const before = prev ? prev[t] : new Map();
      const changed = rows[t].filter(r => before.get(keyOf(t, r)) !== fps[t].get(keyOf(t, r)));
      await upsertRows(c, t, changed, stats);
      if (this.faultInjector) await this.faultInjector(`after:${t}`, code, c);
      if (MUTABLE.includes(t)) {
        const gone = [...before.keys()].filter(k => !fps[t].has(k));
        await deleteRows(c, t, code, gone, stats);
      }
    }

    // lineups: replace the changed ones together with their ordered players
    const beforeL = prev ? prev.lineups : new Map();
    const changedL = rows.lineups.filter(l => beforeL.get(lineupKey(l)) !== fps.lineups.get(lineupKey(l)));
    await upsertRows(c, 'lineups', changedL.map(l => l.row), stats);
    for (const l of changedL) {
      await c.query('DELETE FROM lineup_players WHERE room_code = $1 AND franchise_id = $2 AND kind = $3',
        [code, l.row.franchise_id, l.row.kind]);
    }
    await upsertRows(c, 'lineup_players', changedL.flatMap(l => l.players), stats);
    const goneL = [...beforeL.keys()].filter(k => !fps.lineups.has(k));
    await deleteRows(c, 'lineups', code, goneL, stats);
    if (this.faultInjector) await this.faultInjector('beforeCommit', code, c);

    // The cache advances only after COMMIT returns (see flushRoomNow)
    return { version, fps };
  }

  insertRoomRow(c, room, writeId) {
    const cols = TABLES.rooms.cols;
    const params = cols.map(col => (TABLES.rooms.json.includes(col) ? jsonParam(room[col]) : room[col]));
    params.push(writeId);
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    return c.query(`INSERT INTO rooms (${cols.join(', ')}, version, last_write_id, source)
      VALUES (${ph}, 1, $${cols.length + 1}, 'live') ON CONFLICT (room_code) DO NOTHING RETURNING version`, params);
  }

  updateRoomRow(c, room, cached, fps, writeId) {
    const roomChanged = cached.fps.room !== fps.room;
    const sets = [];
    const params = [room.room_code, cached.version, writeId];
    if (roomChanged) {
      for (const col of TABLES.rooms.cols.filter(x => x !== 'room_code')) {
        params.push(TABLES.rooms.json.includes(col) ? jsonParam(room[col]) : room[col]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    sets.push('version = version + 1', 'updated_at = now()', 'last_write_id = $3');
    return c.query(`UPDATE rooms SET ${sets.join(', ')} WHERE room_code = $1 AND version = $2 RETURNING version`, params);
  }

  // The previous attempt for this room committed but its acknowledgement was lost: the database
  // holds exactly the rows we tried to write. Adopt that state instead of reporting a conflict.
  async adoptUnacknowledgedWrite(c, code) {
    const pending = this.pendingAttempt.get(code);
    if (!pending) return null;
    const r = await c.query('SELECT version, last_write_id FROM rooms WHERE room_code = $1', [code]);
    if (r.rowCount === 1 && r.rows[0].last_write_id === pending.writeId && r.rows[0].version === pending.version) {
      console.warn(`[db] room ${code}: previous write had committed (acknowledgement lost); continuing from version ${pending.version}`);
      const adopted = { version: pending.version, fps: pending.fps };
      this.cache.set(code, adopted);
      this.pendingAttempt.delete(code);
      return adopted;
    }
    return null;
  }

  async close() {
    if (this.closed) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try {
      await this.flushAll();
    } finally {
      this.closed = true;
      try { await this.releaseLease(); } catch (err) { console.error(`[db] could not release the writer lease: ${err.message}`); }
      if (this.ownsPool) await this.pool.end();
    }
  }
}

export { isTransientError };
