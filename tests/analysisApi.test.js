// Stage 3 — post-auction analysis through real server processes (JSON storage).
// AI calls go to a LOCAL MOCK of the Anthropic API (tests/helpers/aiMock.js), never to the real
// service: this verifies our HTTP request, headers, timeout and error handling, not the model.
import assert from 'node:assert';
import { makeRunner, startServer, connect, emit, createRoom, strongToken, tempStorageFile, findPrivateData, registerAsyncCleanup, assertRejected } from './helpers/harness.js';
import { startAiMock, finishedAuction, waitAiSettled, MOCK_KEY } from './helpers/aiMock.js';

const t = makeRunner('Stage 3 Analysis API Suite — real servers, MOCKED Anthropic API');
const mock = await startAiMock();
registerAsyncCleanup(() => mock.close());
const strip = a => JSON.parse(JSON.stringify({ ...a, generatedAt: null }));

const storageFile = tempStorageFile('analysis-api');
let srv = await startServer({ storageFile, env: mock.env() });
let fin;

await t.it('B1: analysis is refused before the auction ends; afterwards all ten franchises are served without private data', async () => {
  const c = await createRoom(srv.url, { hostToken: strongToken('pre') });
  const early = await fetch(`${srv.url}/api/rooms/${c.body.roomCode}/analysis`);
  assert.strictEqual(early.status, 409);
  fin = await finishedAuction(srv.url);
  const res = await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(Object.keys(body.analysis.franchises).length, 10);
  assert.strictEqual(body.analysis.rankings.length, 10);
  assert.strictEqual(body.aiAnalysis.available, true);
  assert.strictEqual(body.aiAnalysis.status, 'none');
  const hits = findPrivateData(body, { secrets: [fin.H, fin.A, MOCK_KEY, 'hash:'], forbiddenKeys: ['ownerToken', 'token', 'hostToken', 'socketId'] });
  assert.deepStrictEqual(hits, []);
  assert.strictEqual((await fetch(`${srv.url}/api/rooms/NOPE99/analysis`)).status, 404);
});

await t.it('B2: a participant requests AI reports — one mocked API call with the server-side key; cached afterwards; scores unchanged', async () => {
  const before = strip((await (await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`)).json()).analysis);
  const settled = waitAiSettled(fin.alice);
  // fabricated squads / scores in the payload are ignored: the server only uses its own state
  const res = await emit(fin.alice, 'request_ai_analysis', { roomCode: fin.code, squads: { MI: [] }, analysis: { rankings: [] }, franchiseId: 'CSK' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'generating');
  const state = await settled;
  assert.strictEqual(state.aiAnalysis.status, 'ready');
  assert.strictEqual(state.aiAnalysis.model, 'mock-model');
  assert.ok(state.aiAnalysis.result.franchises.MI.report);
  assert.strictEqual(mock.state.requests.length, 1);
  const req = mock.state.requests[0];
  assert.strictEqual(req.url, '/v1/messages');
  assert.strictEqual(req.headers['x-api-key'], MOCK_KEY);
  assert.strictEqual(req.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(req.body.model, 'mock-model');
  for (const s of [fin.H, fin.A, 'Alice']) assert.ok(!req.raw.includes(s), 'prompt contains participant data');
  const again = await emit(fin.host, 'request_ai_analysis', { roomCode: fin.code });
  assert.strictEqual(again.status, 'ready');
  assert.strictEqual(again.cached, true);
  assert.strictEqual(mock.state.requests.length, 1, 'cached report requested again');
  const after = await (await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`)).json();
  assert.deepStrictEqual(strip(after.analysis), before, 'AI changed the deterministic analysis');
  assert.ok(!JSON.stringify(after).includes(MOCK_KEY));
});

await t.it('B3: room isolation and protection — other rooms\' sessions, unjoined sockets and non-hosts cannot trigger or regenerate', async () => {
  const other = await finishedAuction(srv.url, { sales: 0 });
  assertRejected(await emit(other.alice, 'request_ai_analysis', { roomCode: fin.code }), 'session of another room');
  const stray = await connect(srv.url);
  assertRejected(await emit(stray, 'request_ai_analysis', { roomCode: fin.code }), 'socket without a session');
  const regen = await emit(fin.alice, 'request_ai_analysis', { roomCode: fin.code, force: true });
  assert.strictEqual(regen.success, false);
  assert.match(regen.error, /Only the host/);
  assert.strictEqual(mock.state.requests.length, 1);
});

await t.it('B4: snapshot and AI reports survive a server restart unchanged, with no new AI call', async () => {
  const before = await (await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`)).json();
  await srv.stop();
  srv = await startServer({ storageFile, env: mock.env() });
  const after = await (await fetch(`${srv.url}/api/rooms/${fin.code}/analysis`)).json();
  assert.strictEqual(after.analysis.generatedAt, before.analysis.generatedAt, 'snapshot recomputed after restart');
  assert.deepStrictEqual(after.analysis, before.analysis);
  assert.deepStrictEqual(after.aiAnalysis.result, before.aiAnalysis.result);
  assert.strictEqual(mock.state.requests.length, 1);
});

await t.it('B5: AI failures (HTTP 500, timeout) are reported safely; the deterministic analysis is still served; the key is never logged', async () => {
  await srv.stop();
  srv = await startServer({ storageFile: tempStorageFile('ai-fail'), env: mock.env({ AI_TIMEOUT_MS: '1000' }) });
  const f2 = await finishedAuction(srv.url, { sales: 2 });
  mock.state.mode = '500';
  let settled = waitAiSettled(f2.alice);
  await emit(f2.alice, 'request_ai_analysis', { roomCode: f2.code });
  let st = await settled;
  assert.strictEqual(st.aiAnalysis.status, 'failed');
  assert.strictEqual(st.aiAnalysis.lastError.code, 'HTTP_500');
  mock.state.mode = 'ok';
  mock.state.delayMs = 2500;
  settled = waitAiSettled(f2.alice);
  const retry = await emit(f2.alice, 'request_ai_analysis', { roomCode: f2.code });
  assert.strictEqual(retry.status, 'generating', JSON.stringify(retry));
  st = await settled;
  assert.strictEqual(st.aiAnalysis.lastError.code, 'TIMEOUT');
  mock.state.delayMs = 0;
  const res = await fetch(`${srv.url}/api/rooms/${f2.code}/analysis`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.analysis.franchises.MI.explanation.report, 'no rule-based fallback');
  assert.ok(!srv.getLog().includes(MOCK_KEY), 'API key appears in the server log');
});

await srv.stop();
process.exit(await t.finish());
