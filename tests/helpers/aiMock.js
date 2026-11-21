// A local MOCK of the Anthropic Messages API (POST /v1/messages) for tests. It is not the real
// service: it records requests and answers with controlled responses built from the prompt data.
import http from 'node:http';
import assert from 'node:assert';
import { freePort, connect, emit, createRoom, strongToken, waitFor } from './harness.js';

export const MOCK_KEY = 'sk-ant-mock-key-for-tests-only-0000';

export async function startAiMock() {
  const state = { mode: 'ok', delayMs: 0, requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
      state.requests.push({ url: req.url, headers: req.headers, body: parsed, raw: body });
      const reply = () => {
        if (res.writableEnded || res.destroyed) return;
        if (state.mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock failure' } })); return; }
        const text = parsed?.messages?.[0]?.content || '';
        const data = JSON.parse(text.slice(text.indexOf('{')));
        const franchises = {};
        for (const f of data.franchises) {
          franchises[f.franchiseId] = {
            report: `${f.franchiseName}: ${f.ruleEligibility.eligible ? 'meets the auction rules' : 'does not meet the auction rules'}. Mock report from supplied data.`,
            strengths: ['Mock strength'], weaknesses: ['Mock weakness'], recommendations: ['Mock recommendation'],
            suggestedXI: f.squad.slice(0, 1).map(p => p.playerId), missingInformation: ['No match statistics in the data']
          };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Mock auction summary.', comparison: 'Mock comparison.', franchises }) }], stop_reason: 'end_turn' }));
      };
      if (state.delayMs) setTimeout(reply, state.delayMs); else reply();
    });
  });
  const port = await freePort();
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    env: extra => ({ ANTHROPIC_API_KEY: MOCK_KEY, AI_ANALYSIS_ENABLED: 'true', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_MODEL: 'mock-model', AI_REGENERATE_COOLDOWN_MS: '0', ANALYSIS_ENGINE: 'eval-2', ...extra }),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); })
  };
}

/** Two participants, a few sales, then the host finishes the auction (real sockets). */
export async function finishedAuction(url, { sales = 4 } = {}) {
  const H = strongToken('h'); const A = strongToken('a');
  const c = await createRoom(url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = c.body.roomCode;
  const host = await connect(url); const alice = await connect(url);
  assert.ok((await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H })).success);
  assert.ok((await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A })).success);
  assert.ok((await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' })).success);
  assert.ok((await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' })).success);
  assert.ok((await emit(host, 'start_auction', { roomCode: code })).success);
  for (let i = 0; i < sales; i++) {
    const st = await (await fetch(`${url}/api/rooms/${code}`)).json();
    const [sock, fid] = i % 2 ? [host, 'CSK'] : [alice, 'MI'];
    const b = await emit(sock, 'place_bid', { roomCode: code, franchiseId: fid, expectedVersion: st.currentLot.stateVersion });
    if (b.success) assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success); // hammer
    assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success); // next lot
  }
  const done = waitFor(alice, 'auction_completed');
  assert.ok((await emit(host, 'finish_auction', { roomCode: code })).success);
  await done;
  return { code, H, A, host, alice };
}

export async function waitAiSettled(socket, timeoutMs = 8000) {
  return waitFor(socket, 'analysis_updated', s => s.aiAnalysis && !s.aiAnalysis.generating, timeoutMs);
}
