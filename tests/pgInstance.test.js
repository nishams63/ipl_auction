// INTEGRATION (real PostgreSQL, real server processes): single-writer enforcement.
// A second instance can never act as an independent authority: it waits in STANDBY until the
// writer lease is released (graceful stop) or expires (crash); a writer that lost its lease
// cannot commit anything and says so in /api/health.
import assert from 'node:assert';
import fs from 'node:fs';
import { makeRunner, connect, emit, createRoom, strongToken, tempStorageFile, registerAsyncCleanup, startServer } from './helpers/harness.js';
import { requireTestDatabase, startPgServer, waitForStatus } from './helpers/pg.js';

const t = makeRunner('PostgreSQL Single-Instance Suite — INTEGRATION (real PostgreSQL, real server processes)');
const db = await requireTestDatabase('instance');
if (!db) process.exit(await t.finish());

const { createPool } = await import('../server/persistence/db.js');
const { runMigrations } = await import('../server/persistence/migrate.js');
const { importJsonFile } = await import('../server/persistence/importJson.js');
const admin = createPool(db.url, { max: 2 });
registerAsyncCleanup(() => admin.end());
await runMigrations(admin);

const ENV = { PERSISTENCE: 'postgres', DATABASE_URL: db.url, DB_LEASE_TTL_MS: '2000' };
const health = async url => (await fetch(`${url}/api/health`)).json();
const kill9 = srv => new Promise(r => { srv.child.once('exit', r); srv.child.kill('SIGKILL'); });
// A second server: started without waiting for ACTIVE (it is expected to wait in standby)
const startStandby = () => startServer({ env: ENV, timeoutMs: 15000 }).then(async s => { await waitForStatus(s.url, ['standby', 'ok']); return s; });

async function auctionWithBid(url) {
  const H = strongToken('h'); const A = strongToken('a');
  const c = await createRoom(url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = c.body.roomCode;
  const host = await connect(url); const alice = await connect(url);
  await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' });
  await emit(host, 'start_auction', { roomCode: code });
  const st = await (await fetch(`${url}/api/rooms/${code}`)).json();
  const b = await emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: st.currentLot.nextValidBid, expectedVersion: st.currentLot.stateVersion });
  assert.ok(b.success, b.error);
  return { code, H, A, host, alice };
}

await t.it('L1+L2: a second instance waits in STANDBY (healthy for the platform, no room traffic); a graceful stop hands over promptly with the latest data', async () => {
  const first = await startPgServer(ENV);
  const a = await auctionWithBid(first.url);
  const second = await startStandby();
  const h = await health(second.url);
  assert.strictEqual(h.status, 'standby');
  assert.strictEqual(h.storage.role, 'standby');
  assert.strictEqual(h.storage.leaseHeld, false);
  assert.strictEqual((await fetch(`${second.url}/api/rooms/${a.code}`)).status, 503);
  assert.strictEqual((await createRoom(second.url, { hostToken: strongToken('x') })).status, 503);
  const s = await connect(second.url);
  const j = await emit(s, 'join_room', { roomCode: a.code, participantName: 'Alice', participantToken: a.A });
  assert.strictEqual(j.success, false);
  assert.strictEqual(j.code, 'STARTING');
  assert.match(second.getLog(), /STANDBY: another instance/);
  assert.strictEqual((await health(first.url)).status, 'ok', 'active instance disturbed');
  // L2: graceful stop of the first → the standby takes over promptly with the latest data
  const t0 = Date.now();
  await first.stop();
  await waitForStatus(second.url, ['ok'], 10000);
  assert.ok(Date.now() - t0 < 6000, `takeover after graceful stop took ${Date.now() - t0} ms`);
  const st = await (await fetch(`${second.url}/api/rooms/${a.code}`)).json();
  assert.strictEqual(st.currentLot.highestBidderFranchiseId, 'MI', 'takeover lost the last acknowledged bid');
  assert.strictEqual(st.status, 'paused');
  assert.match(second.getLog(), /ACTIVE: PostgreSQL .* is the durable storage authority/);
  await second.stop();
});

await t.it('L3: after a crash (no lease release) the standby takes over once the lease expires', async () => {
  const first = await startPgServer(ENV);
  const a = await auctionWithBid(first.url);
  const second = await startStandby();
  await kill9(first);
  const t0 = Date.now();
  await waitForStatus(second.url, ['ok'], 15000);
  const waited = Date.now() - t0;
  assert.ok(waited < 8000, `takeover after crash took ${waited} ms (lease TTL 2000 ms)`);
  const st = await (await fetch(`${second.url}/api/rooms/${a.code}`)).json();
  assert.strictEqual(st.currentLot.highestBidderFranchiseId, 'MI');
  await second.stop();
});

await t.it('L4: a writer whose lease was taken cannot commit — the action is refused, the room is held, health is degraded', async () => {
  const srv = await startPgServer(ENV);
  const a = await auctionWithBid(srv.url);
  const before = (await admin.query('SELECT count(*)::int AS n FROM bids WHERE room_code = $1', [a.code])).rows[0].n;
  // another instance takes the lease (as after a network partition outlasting the TTL)
  await admin.query(`UPDATE storage_meta SET value = 'intruder', updated_at = now() WHERE key = 'writer_lease'`);
  const st = await (await fetch(`${srv.url}/api/rooms/${a.code}`)).json();
  const b = await emit(a.host, 'place_bid', { roomCode: a.code, franchiseId: 'CSK', bidAmount: st.currentLot.nextValidBid, expectedVersion: st.currentLot.stateVersion });
  assert.strictEqual(b.success, false, 'bid acknowledged without the lease');
  assert.strictEqual(b.code, 'STORAGE_UNAVAILABLE');
  const after = (await admin.query('SELECT count(*)::int AS n FROM bids WHERE room_code = $1', [a.code])).rows[0].n;
  assert.strictEqual(after, before, 'a write committed without the lease');
  const h = await health(srv.url);
  assert.strictEqual(h.status, 'degraded');
  assert.strictEqual(h.storage.leaseLost, true);
  assert.ok(h.storage.roomsOnHold.includes(a.code));
  // further actions are refused while held
  const again = await emit(a.host, 'pause_auction', { roomCode: a.code });
  assert.strictEqual(again.success, false);
  assert.match(srv.getLog(), /WRITER LEASE LOST/);
  await admin.query(`DELETE FROM storage_meta WHERE key = 'writer_lease'`);
  await srv.stop();
});

await t.it('L5: the importer refuses to run while a server holds the writer lease', async () => {
  const srv = await startPgServer(ENV);
  const file = tempStorageFile('l5');
  fs.writeFileSync(file, JSON.stringify({}));
  const r = await importJsonFile({ pool: admin, file });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.error, /^SERVER_RUNNING/);
  const dry = await importJsonFile({ pool: admin, file, dryRun: true });
  assert.strictEqual(dry.status, 'completed', 'a dry run should still be allowed');
  await srv.stop();
  const ok = await importJsonFile({ pool: admin, file });
  assert.strictEqual(ok.status, 'completed', 'import still refused after the server stopped');
});

process.exit(await t.finish());
