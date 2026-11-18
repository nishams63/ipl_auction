// INTEGRATION (real PostgreSQL, real server processes, MOCKED Anthropic API): post-auction
// analysis persistence in PostgreSQL mode.
import assert from 'node:assert';
import { makeRunner, registerAsyncCleanup, emit } from './helpers/harness.js';
import { requireTestDatabase, startPgServer } from './helpers/pg.js';
import { startAiMock, finishedAuction, waitAiSettled } from './helpers/aiMock.js';

const t = makeRunner('PostgreSQL Analysis Suite — INTEGRATION (real PostgreSQL, MOCKED Anthropic API)');
const db = await requireTestDatabase('analysis');
if (!db) process.exit(await t.finish());

const { createPool } = await import('../server/persistence/db.js');
const { runMigrations } = await import('../server/persistence/migrate.js');
const admin = createPool(db.url, { max: 2 });
registerAsyncCleanup(() => admin.end());
await runMigrations(admin);
const mock = await startAiMock();
registerAsyncCleanup(() => mock.close());
const ENV = mock.env({ PERSISTENCE: 'postgres', DATABASE_URL: db.url });
const kill9 = srv => new Promise(r => { srv.child.once('exit', r); srv.child.kill('SIGKILL'); });

await t.it('PA1: the snapshot and the AI reports are stored separately, committed, and survive a crash + restart unchanged (no recalculation, no new AI call)', async () => {
  let srv = await startPgServer(ENV);
  const fin = await finishedAuction(srv.url, { sales: 4 });
  const settled = waitAiSettled(fin.alice);
  await emit(fin.alice, 'request_ai_analysis', { roomCode: fin.code });
  const st = await settled;
  assert.strictEqual(st.aiAnalysis.status, 'ready');
  const before = await (await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`)).json();
  // committed before the broadcast: read straight from the database, then crash
  const row = (await admin.query(`SELECT status, extra FROM rooms WHERE room_code = $1`, [fin.code])).rows[0];
  assert.strictEqual(row.status, 'completed');
  assert.strictEqual(row.extra.analysis.engineVersion, 'eval-2');
  assert.strictEqual(row.extra.aiAnalysis.status, 'ready');
  assert.ok(!('result' in row.extra.analysis) && !('rankings' in row.extra.aiAnalysis), 'deterministic and AI data are mixed');
  await kill9(srv);
  srv = await startPgServer(ENV);
  const after = await (await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`)).json();
  assert.deepStrictEqual(after.analysis, before.analysis);
  assert.strictEqual(after.analysis.generatedAt, before.analysis.generatedAt, 'snapshot recomputed');
  assert.deepStrictEqual(after.aiAnalysis.result, before.aiAnalysis.result);
  assert.strictEqual(mock.state.requests.length, 1, 'AI called again after restart');
  await srv.stop();
});

await t.it('PA2: a completed room loaded from PostgreSQL without a snapshot gets exactly one, persisted; existing results are not touched', async () => {
  let srv = await startPgServer(ENV);
  const fin = await finishedAuction(srv.url, { sales: 2 });
  await srv.stop();
  const legacy = (await admin.query(`SELECT evaluation_results FROM rooms WHERE room_code = $1`, [fin.code])).rows[0].evaluation_results;
  await admin.query(`UPDATE rooms SET extra = extra - 'analysis' WHERE room_code = $1`, [fin.code]);
  srv = await startPgServer(ENV);
  const a1 = await (await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`)).json();
  assert.strictEqual(a1.analysis.engineVersion, 'eval-2');
  const stored = (await admin.query(`SELECT extra, evaluation_results FROM rooms WHERE room_code = $1`, [fin.code])).rows[0];
  assert.strictEqual(stored.extra.analysis.generatedAt, a1.analysis.generatedAt, 'new snapshot not persisted');
  assert.deepStrictEqual(stored.evaluation_results, legacy, 'legacy evaluation results modified');
  await srv.stop();
  srv = await startPgServer(ENV);
  const a2 = await (await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`)).json();
  assert.strictEqual(a2.analysis.generatedAt, a1.analysis.generatedAt, 'snapshot created more than once');
  await srv.stop();
});

process.exit(await t.finish());
