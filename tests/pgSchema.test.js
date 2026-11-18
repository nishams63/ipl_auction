// INTEGRATION (real PostgreSQL): migrations and database-level integrity constraints.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRunner, trackManager, mockIo, tempStorageFile, registerAsyncCleanup } from './helpers/harness.js';
import { requireTestDatabase } from './helpers/pg.js';
import { richRoom } from './helpers/auctionRooms.js';

const t = makeRunner('PostgreSQL Schema & Migration Suite — INTEGRATION (real PostgreSQL)');
const db = await requireTestDatabase('schema');
if (!db) process.exit(await t.finish());

const { createPool } = await import('../server/persistence/db.js');
const { runMigrations, migrationStatus, assertSchemaUpToDate, listMigrationFiles } = await import('../server/persistence/migrate.js');
const { roomToRows } = await import('../server/persistence/roomMapper.js');
const { upsertRows } = await import('../server/persistence/postgresStore.js');
const { RoomManager } = await import('../server/roomManager.js');

const pool = createPool(db.url, { max: 4 });
registerAsyncCleanup(() => pool.end());

await t.it('S1: a fresh database is migrated; a second run is a no-op; status reports up to date', async () => {
  await assert.rejects(assertSchemaUpToDate(pool), /Pending migration/);
  const first = await runMigrations(pool);
  assert.deepStrictEqual(first, listMigrationFiles().map(m => m.name));
  assert.deepStrictEqual(await runMigrations(pool), []);
  const s = await migrationStatus(pool);
  assert.ok(s.upToDate && s.pending.length === 0);
  const r = await pool.query('SELECT version, name, checksum FROM schema_migrations');
  assert.strictEqual(r.rowCount, first.length);
});

await t.it('S2: concurrent migration runs are serialized (advisory lock) — each migration applied exactly once', async () => {
  const db2 = await requireTestDatabase('schemaconc');
  const p2 = createPool(db2.url, { max: 6 });
  try {
    const results = await Promise.all([runMigrations(p2), runMigrations(p2), runMigrations(p2)]);
    assert.strictEqual(results.flat().length, listMigrationFiles().length, `applied ${results.flat().length} times`);
    const r = await p2.query('SELECT count(*)::int AS n FROM schema_migrations');
    assert.strictEqual(r.rows[0].n, listMigrationFiles().length);
  } finally { await p2.end(); }
});

await t.it('S3: an applied migration that was edited afterwards is detected and blocks startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-mig-'));
  try {
    for (const m of listMigrationFiles()) fs.writeFileSync(path.join(dir, m.file), m.sql + '\n-- edited later\n');
    const s = await migrationStatus(pool, { dir });
    assert.ok(s.mismatched.length === listMigrationFiles().length && !s.upToDate);
    await assert.rejects(assertSchemaUpToDate(pool, { dir }), /Modified migration/);
    await assert.rejects(runMigrations(pool, { dir }), /modified after it was applied/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A valid room written straight into the schema, for constraint probes
const rm = trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('schema') }));
const { room } = richRoom(rm);
const rows = roomToRows(room);
async function insertRoom(c, r) {
  const cols = ['room_code', 'status', 'host_name', 'host_token_hash', 'config', 'current_player_index', 'current_lot', 'current_lot_player_id', 'evaluation_results', 'audit_seq', 'extra', 'created_at'];
  const json = ['config', 'current_lot', 'evaluation_results', 'extra'];
  await c.query(`INSERT INTO rooms (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    cols.map(k => (json.includes(k) ? (r.room[k] === null ? null : JSON.stringify(r.room[k])) : r.room[k])));
  for (const tbl of ['franchises', 'participants', 'room_players', 'squad_entries', 'bids', 'lot_results', 'audit_logs']) await upsertRows(c, tbl, r[tbl]);
  await upsertRows(c, 'lineups', r.lineups.map(l => l.row));
  await upsertRows(c, 'lineup_players', r.lineups.flatMap(l => l.players));
}
// Run fn inside a transaction that is always rolled back; returns the error (or null)
async function probe(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await insertRoom(c, rows);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await fn(c);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    return null;
  } catch (err) {
    return err;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const code = rows.code;
const sold = rows.squad_entries[0];
const otherFid = sold.franchise_id === 'CSK' ? 'MI' : 'CSK';

await t.it('S4: a complete live room is accepted by every constraint', async () => {
  const err = await probe(async () => {});
  assert.strictEqual(err, null, err && err.message);
});

await t.it('S5: double sale is impossible — a player cannot be in two squads (primary key)', async () => {
  const err = await probe(c => c.query(`INSERT INTO squad_entries (room_code, player_id, franchise_id, acquired_order, bought_price)
    VALUES ($1, $2, $3, 999, 1)`, [code, sold.player_id, otherFid]));
  assert.ok(err && err.code === '23505', `expected unique violation, got ${err && err.message}`);
});

await t.it('S6: duplicate results and duplicate bids are rejected', async () => {
  const res = rows.lot_results[0];
  let err = await probe(c => c.query(`INSERT INTO lot_results (room_code, player_id, seq, status) VALUES ($1, $2, 9999, 'UNSOLD')`, [code, res.player_id]));
  assert.ok(err && err.code === '23505', `duplicate result accepted: ${err && err.message}`);
  const b = rows.bids[0];
  err = await probe(c => c.query(`INSERT INTO bids (room_code, seq, bid_id, lot_number, player_id, franchise_id, amount, state_version)
    VALUES ($1, 9999, 'BID_other', $2, $3, $4, 99, $5)`, [code, b.lot_number, b.player_id, b.franchise_id, b.state_version]));
  assert.ok(err && err.code === '23505', `second bid for the same lot state accepted: ${err && err.message}`);
  err = await probe(c => c.query(`INSERT INTO bids (room_code, seq, bid_id, lot_number, player_id, franchise_id, amount, state_version)
    VALUES ($1, 9999, $2, 1, $3, $4, 99, 999)`, [code, b.bid_id, b.player_id, b.franchise_id]));
  assert.ok(err && err.code === '23505', `duplicate bid id accepted: ${err && err.message}`);
});

await t.it('S7: Playing XI, captain and impact player must be players the franchise bought (foreign keys)', async () => {
  const notBought = rows.room_players.find(p => !rows.squad_entries.some(s => s.player_id === p.player_id)).player_id;
  let err = await probe(c => c.query(`INSERT INTO lineup_players (room_code, franchise_id, kind, slot, player_id) VALUES ($1, 'CSK', 'saved', 11, $2)`, [code, notBought]));
  assert.ok(err && err.code === '23503', `unbought player accepted in XI: ${err && err.message}`);
  const othersPlayer = rows.squad_entries.find(s => s.franchise_id === 'MI').player_id;
  err = await probe(c => c.query(`INSERT INTO lineup_players (room_code, franchise_id, kind, slot, player_id) VALUES ($1, 'CSK', 'saved', 11, $2)`, [code, othersPlayer]));
  assert.ok(err && err.code === '23503', `another franchise's player accepted: ${err && err.message}`);
  err = await probe(c => c.query(`UPDATE lineups SET captain_id = $2 WHERE room_code = $1 AND franchise_id = 'CSK' AND kind = 'saved'`, [code, othersPlayer]));
  assert.ok(err && err.code === '23503', `foreign captain accepted: ${err && err.message}`);
  err = await probe(c => c.query(`UPDATE lineups SET impact_player_id = $2 WHERE room_code = $1 AND franchise_id = 'CSK' AND kind = 'franchise'`, [code, notBought]));
  assert.ok(err && err.code === '23503', `unbought impact player accepted: ${err && err.message}`);
});

await t.it('S8: value checks — negative purse, unknown statuses, sold without buyer, invalid token hash are rejected', async () => {
  const checks = [
    c => c.query(`UPDATE franchises SET remaining_purse = -0.25 WHERE room_code = $1 AND franchise_id = 'CSK'`, [code]),
    c => c.query(`UPDATE rooms SET status = 'running' WHERE room_code = $1`, [code]),
    c => c.query(`UPDATE room_players SET status = 'gone' WHERE room_code = $1 AND position = 0`, [code]),
    c => c.query(`UPDATE room_players SET sold_to = NULL WHERE room_code = $1 AND status = 'sold'`, [code]),
    c => c.query(`UPDATE participants SET token_hash = 'usr_raw_token_aaaaaaaaaaa' WHERE room_code = $1`, [code]),
    c => c.query(`UPDATE lot_results SET winning_franchise_id = NULL WHERE room_code = $1 AND status = 'SOLD'`, [code]),
    c => c.query(`INSERT INTO rooms (room_code, status, config, current_player_index) VALUES ('bad code', 'lobby', '{}', -1)`)
  ];
  for (const [i, fn] of checks.entries()) {
    const err = await probe(fn);
    assert.ok(err && err.code === '23514', `check ${i} not enforced: ${err ? err.message : 'accepted'}`);
  }
});

await t.it('S9: deleting a room removes all of its rows (no orphans), constraints checked at commit', async () => {
  const c = await pool.connect();
  let err = null;
  try {
    await c.query('BEGIN');
    await insertRoom(c, rows);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('SET CONSTRAINTS ALL DEFERRED'); // the normal mode, as an operator's DELETE would run
    await c.query('DELETE FROM rooms WHERE room_code = $1', [code]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE'); // = what COMMIT checks
    for (const tbl of ['franchises', 'participants', 'room_players', 'squad_entries', 'lineups', 'lineup_players', 'bids', 'lot_results', 'audit_logs']) {
      const r = await c.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE room_code = $1`, [code]);
      assert.strictEqual(r.rows[0].n, 0, `${tbl} rows left behind`);
    }
  } catch (e) {
    err = e;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  assert.strictEqual(err, null, err && err.message);
});

process.exit(await t.finish());
