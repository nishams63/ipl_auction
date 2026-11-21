// Stage 3 — post-auction analysis: deterministic evaluation engine and the AI service.
// The AI is exercised with CONTROLLED MOCK responses (an injected fetch). No real Anthropic API
// call is made by this suite.
import assert from 'node:assert';
import fs from 'node:fs';
import { makeRunner, trackManager, mockIo, tempStorageFile, strongToken, sleep } from './helpers/harness.js';
import { liveRoom, sellCurrent, passCurrent } from './helpers/auctionRooms.js';

process.env.ANALYSIS_ENGINE = 'eval-2';
const { RoomManager } = await import('../server/roomManager.js');
const { validateBid } = await import('../server/auctionEngine.js');
const { evaluateAuction: _evaluateAuction, evaluateFranchise, classifyPlayer, WEIGHTS } = await import('../server/analysis/evaluation.js');
const evaluateAuction = (r, opts) => _evaluateAuction(r, { engine: 'eval-2', ...opts });
const { validateAiOutput, buildAiInput, buildPrompt, aiConfig } = await import('../server/analysis/aiAnalysis.js');

const t = makeRunner('Stage 3 Analysis Suite — engine UNIT tests + AI service with MOCKED Anthropic responses');
const RULES = { minSquadSize: 15, maxSquadSize: 25, maxOverseas: 8, minWKs: 1, basePurse: 120, analysisEngine: 'eval-2' };
let seq = 0;
const P = (category, role, isOverseas = false, price = 1) => ({ id: `T_${String(++seq).padStart(3, '0')}`, name: `Test ${seq}`, category, role, isOverseas, basePrice: price, boughtPrice: price });
const strip = a => JSON.parse(JSON.stringify({ ...a, generatedAt: null }));

// A finished two-team auction driven through the real RoomManager
// (buys only when the server's own rules allow the bid, e.g. the overseas cap)
function finishedRoom(rm, lots = 44) {
  const r = liveRoom(rm);
  for (let i = 0; i < lots && r.room.status === 'active'; i++) {
    const order = i % 2 ? [['CSK', r.H], ['MI', r.A]] : [['MI', r.A], ['CSK', r.H]];
    const buyer = i % 4 === 3 ? null : order.find(([fid]) => validateBid({ room: r.room, franchiseId: fid, expectedVersion: r.room.currentLot.stateVersion }).valid);
    if (buyer) sellCurrent(rm, r.room, buyer[1], buyer[0]);
    else passCurrent(rm, r.room);
  }
  rm.finishAuction(r.room);
  return r;
}
const make = file => trackManager(new RoomManager(mockIo(), { storageFile: file || tempStorageFile('an') }));

await t.it('A1: identical input → identical scores and ranking (also with squads in a different order)', () => {
  const rm = make();
  const { room } = finishedRoom(rm);
  const a = evaluateAuction(room);
  const clone = structuredClone({ ...room, participants: [] });
  for (const f of Object.values(clone.franchises)) f.squad.reverse();
  const b = evaluateAuction(clone);
  assert.deepStrictEqual(strip(a), strip(b));
  assert.strictEqual(a.inputChecksum, b.inputChecksum);
});

await t.it('A2: a hand-computed squad gets exactly the documented scores', () => {
  const squad = [
    P('BAT', 'Top-order Batter', true), P('BAT', 'Opening Batter'), P('BAT', 'Middle-order Batter'), P('BAT', 'Finisher'),
    P('WK', 'Wicketkeeper Batter'), P('WK', 'Wicketkeeper Opener'),
    P('AR', 'Pace All-Rounder', true), P('AR', 'Left-arm Spin All-Rounder'), P('AR', 'Batting All-Rounder'),
    P('BOWL', 'Right-arm Fast Bowler', true), P('BOWL', 'Left-arm Fast Bowler'), P('BOWL', 'Right-arm Fast Medium'),
    P('SP', 'Right-arm Leg Spinner'), P('SP', 'Slow Left-arm Orthodox')
  ];
  const e = evaluateFranchise({ id: 'MI', name: 'Mumbai Indians', squad, initialPurse: 120, remainingPurse: 106 }, RULES, { participating: true });
  // composition: shares 4/14, 2/14, 3/14, 3/14, 2/14 vs 0.24/0.12/0.24/0.24/0.16 → TVD 0.068571 → 93.14
  assert.deepStrictEqual(e.dimensions, {
    battingDepth: 100, bowlingDepth: 88.89, paceOptions: 80, spinOptions: 100, allRounders: 100,
    keeperCoverage: 100, overseasBalance: 75, squadDepth: 56, squadComposition: 93.14, xiCompatibility: 100
  });
  // 15 + 13.3335 + 8 + 10 + 10 + 10 + 3.75 + 5.6 + 9.314 + 5 = 89.9975 → 90
  assert.strictEqual(e.overall, 90);
  assert.deepStrictEqual(Object.values(WEIGHTS).reduce((s, w) => s + w, 0), 100);
  assert.strictEqual(e.eligibility.eligible, false);
  assert.deepStrictEqual(e.eligibility.failures, ['Squad has 14 players; the minimum is 15']);
  assert.strictEqual(e.counts.arUnknownBowling, 1, '"Batting All-Rounder" names no bowling type');
  assert.strictEqual(e.purse.spent, 14);
});

await t.it('A3: missing or unknown attributes are handled honestly (unclassified, not guessed)', () => {
  const squad = [P('BAT', 'Opener'), { id: 'X1', name: 'No category' }, P('XX', 'Mystery'), { ...P('BOWL', 'Fast'), isOverseas: undefined }, P('AR', null)];
  const e = evaluateFranchise({ id: 'RR', name: 'RR', squad }, RULES, { participating: true });
  assert.strictEqual(e.counts.unclassified, 2);
  assert.strictEqual(e.dataCompleteness, 60);
  assert.strictEqual(e.counts.overseasUnknown, 2, 'players without an overseas flag are counted as unknown, not as Indian');
  assert.strictEqual(e.counts.arUnknownBowling, 1);
  assert.strictEqual(classifyPlayer({ category: 'AR', role: 'Off-spin All-Rounder' }).bowlingType, 'spin');
  assert.strictEqual(classifyPlayer({ category: 'AR', role: 'Medium Pace All-Rounder' }).bowlingType, 'pace');
});

await t.it('A4: empty squads and franchises that did not take part', () => {
  const rm = make();
  const { room } = finishedRoom(rm, 0);
  const a = room.analysis;
  assert.strictEqual(Object.keys(a.franchises).length, 10, 'not all ten franchises evaluated');
  assert.strictEqual(a.rankings.length, 10);
  const rr = a.franchises.RR;
  assert.strictEqual(rr.participating, false);
  assert.strictEqual(rr.overall, 0);
  assert.strictEqual(rr.eligibility.status, 'NOT_PARTICIPATING');
  const mi = a.franchises.MI;
  assert.strictEqual(mi.participating, true);
  assert.strictEqual(mi.counts.total, 0);
  assert.strictEqual(mi.overall, 0);
  assert.strictEqual(mi.eligibility.status, 'INELIGIBLE');
  assert.ok(a.rankings.slice(0, 2).every(r => ['MI', 'CSK'].includes(r.franchiseId)), 'participants must rank above non-participants');
  assert.strictEqual(a.awards.strongestBatting.winner, null, 'no award without evidence');
});

await t.it('A5: overseas balance — none scores 0, four or more scores 100, above the cap scores 0 and breaks eligibility', () => {
  const base = () => [P('WK', 'Keeper'), ...Array.from({ length: 14 }, () => P('BAT', 'Batter'))];
  const score = (n, rules = RULES) => {
    const squad = base();
    for (let i = 0; i < n; i++) squad[i + 1].isOverseas = true;
    return evaluateFranchise({ id: 'DC', name: 'DC', squad }, rules, { participating: true });
  };
  assert.strictEqual(score(0).dimensions.overseasBalance, 0);
  assert.strictEqual(score(2).dimensions.overseasBalance, 50);
  assert.strictEqual(score(4).dimensions.overseasBalance, 100);
  assert.strictEqual(score(8).dimensions.overseasBalance, 100);
  const over = score(9);
  assert.strictEqual(over.dimensions.overseasBalance, 0);
  assert.ok(over.eligibility.failures.some(f => /overseas/.test(f)));
});

await t.it('A6: wicketkeeper coverage — 0 / 1 / 2 keepers score 0 / 60 / 100; no keeper fails eligibility and the XI check', () => {
  const squadWith = k => [...Array.from({ length: k }, () => P('WK', 'Keeper')), ...Array.from({ length: 15 - k }, () => P('BAT', 'Batter'))];
  const ev = k => evaluateFranchise({ id: 'GT', name: 'GT', squad: squadWith(k) }, RULES, { participating: true });
  assert.deepStrictEqual([0, 1, 2].map(k => ev(k).dimensions.keeperCoverage), [0, 60, 100]);
  const none = ev(0);
  assert.ok(none.eligibility.failures.some(f => /wicketkeeper/.test(f)));
  assert.strictEqual(none.xiChecks.find(c => c.id === 'keeper').ok, false);
});

await t.it('A7: eligibility uses the room\'s own rules — an interrupted legacy auction (squad 11–15) is judged by 11–15', () => {
  const squad = [P('WK', 'Keeper'), ...Array.from({ length: 12 }, () => P('BAT', 'Batter'))];
  const legacy = evaluateFranchise({ id: 'KKR', name: 'KKR', squad }, { ...RULES, minSquadSize: 11, maxSquadSize: 15 }, { participating: true });
  const fixed = evaluateFranchise({ id: 'KKR', name: 'KKR', squad }, RULES, { participating: true });
  assert.strictEqual(legacy.eligibility.eligible, true);
  assert.strictEqual(fixed.eligibility.eligible, false);
});

await t.it('A8: ties share a rank, are listed alphabetically, and tied categories get no winner', () => {
  const rm = make();
  const { room } = finishedRoom(rm, 0);
  // identical structures for MI and CSK
  const mk = () => [P('WK', 'Keeper'), P('BAT', 'Batter'), P('BOWL', 'Fast Bowler'), P('SP', 'Leg Spinner')];
  room.franchises.MI.squad = mk();
  room.franchises.CSK.squad = mk();
  const a = evaluateAuction(room);
  const [r1, r2] = a.rankings;
  assert.strictEqual(r1.overall, r2.overall);
  assert.strictEqual(r1.rank, r2.rank);
  assert.ok(r1.tied && r2.tied);
  assert.deepStrictEqual([r1.franchiseId, r2.franchiseId], ['CSK', 'MI']);
  assert.strictEqual(a.awards.strongestBatting.winner, null);
  assert.deepStrictEqual(a.awards.strongestBatting.tied, ['CSK', 'MI']);
});

await t.it('A9: rule-eligible squads rank above ineligible ones even with a lower score; ranks cover all ten', () => {
  const rm = make();
  const { room } = finishedRoom(rm, 0);
  const full = Array.from({ length: 15 }, (_, i) => (i === 0 ? P('WK', 'Keeper') : P('BAT', 'Batter')));
  const strongButShort = [P('WK', 'K'), P('WK', 'K'), P('BAT', 'B'), P('BAT', 'B'), P('BAT', 'B'), P('AR', 'Pace All-Rounder', true), P('AR', 'Spin All-Rounder', true),
    P('AR', 'Off-spin All-Rounder'), P('BOWL', 'Fast', true), P('BOWL', 'Fast', true), P('BOWL', 'Fast'), P('SP', 'Leg Spinner'), P('SP', 'Leg Spinner')];
  room.franchises.MI.squad = full;
  room.franchises.CSK.squad = strongButShort;
  const a = evaluateAuction(room);
  assert.ok(a.franchises.CSK.overall > a.franchises.MI.overall, 'test setup: CSK should score higher');
  assert.deepStrictEqual(a.rankings.slice(0, 2).map(r => r.franchiseId), ['MI', 'CSK']);
  assert.strictEqual(new Set(a.rankings.map(r => r.franchiseId)).size, 10);
  assert.ok(a.rankings.every((r, i) => i === 0 || r.rank >= a.rankings[i - 1].rank));
});

await t.it('A10b: over-concentration is penalised — a full squad of 10 keepers scores below a balanced full squad', () => {
  const balanced = [...Array(6)].map(() => P('BAT', 'Batter')).concat([...Array(3)].map(() => P('WK', 'Keeper')), [P('AR', 'Pace All-Rounder', true), P('AR', 'Pace All-Rounder'), P('AR', 'Off-spin All-Rounder', true), P('AR', 'Spin All-Rounder'), P('AR', 'Pace All-Rounder'), P('AR', 'Medium Pace All-Rounder')],
    [...Array(6)].map((_, i) => P('BOWL', 'Fast Bowler', i < 2)), [...Array(4)].map(() => P('SP', 'Leg Spinner')));
  const stacked = [...Array(10)].map(() => P('WK', 'Keeper')).concat([...Array(3)].map(() => P('AR', 'Pace All-Rounder', true)), [...Array(6)].map((_, i) => P('BOWL', 'Fast Bowler', i < 3)), [...Array(4)].map(() => P('SP', 'Leg Spinner')), [P('BAT', 'Batter'), P('BAT', 'Batter')]);
  assert.strictEqual(balanced.length, 25); assert.strictEqual(stacked.length, 25);
  const b = evaluateFranchise({ id: 'DC', name: 'DC', squad: balanced }, RULES, { participating: true });
  const s2 = evaluateFranchise({ id: 'GT', name: 'GT', squad: stacked }, RULES, { participating: true });
  assert.strictEqual(b.dimensions.squadComposition, 100);
  assert.ok(s2.dimensions.squadComposition < 80, `stacked squad composition ${s2.dimensions.squadComposition}`);
  assert.ok(s2.overall < b.overall, 'over-concentrated squad not penalised');
});

await t.it('A10: spending more does not raise the score (same squad, higher prices → same scores)', () => {
  const squad = Array.from({ length: 15 }, (_, i) => (i === 0 ? P('WK', 'Keeper') : P(i % 2 ? 'BAT' : 'BOWL', 'Role')));
  const cheap = evaluateFranchise({ id: 'SRH', name: 'SRH', squad }, RULES, { participating: true });
  const dear = evaluateFranchise({ id: 'SRH', name: 'SRH', squad: squad.map(p => ({ ...p, boughtPrice: p.boughtPrice * 8 })) }, RULES, { participating: true });
  assert.strictEqual(dear.overall, cheap.overall);
  assert.deepStrictEqual(dear.dimensions, cheap.dimensions);
  assert.notStrictEqual(dear.purse.spent, cheap.purse.spent);
});

await t.it('A11: the snapshot is saved at finish, never recomputed, survives a JSON restart; legacy completed rooms get one without touching old results', () => {
  const file = tempStorageFile('snap');
  const rm = make(file);
  const { room, code } = finishedRoom(rm);
  const snap = strip(room.analysis);
  const generatedAt = room.analysis.generatedAt;
  room.franchises.MI.squad.pop(); // a later in-memory change must not alter the saved snapshot
  assert.deepStrictEqual(strip(rm.getPublicRoomState(room).analysis), snap);
  room.franchises.MI.squad = structuredClone(room.franchises.MI.squad);
  rm.flushStorage(); rm.shutdown();
  const rm2 = make(file);
  assert.strictEqual(rm2.getRoom(code).analysis.generatedAt, generatedAt, 'snapshot recomputed on restart');
  assert.deepStrictEqual(strip(rm2.getRoom(code).analysis), snap);
  rm2.flushStorage(); rm2.shutdown();
  // a room completed before Stage 3: no analysis yet
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  delete data[code].analysis;
  const legacyResults = structuredClone(data[code].evaluationResults);
  fs.writeFileSync(file, JSON.stringify(data));
  const rm3 = make(file);
  const r3 = rm3.getRoom(code);
  assert.strictEqual(r3.analysis.engineVersion, 'eval-2');
  assert.deepStrictEqual(r3.evaluationResults, legacyResults, 'legacy results were modified');
  assert.strictEqual(r3.auditLog.filter(e => e.type === 'ANALYSIS_SNAPSHOT_CREATED').length, 1);
  rm3.flushStorage(); rm3.shutdown();
  const rm4 = make(file);
  assert.strictEqual(rm4.getRoom(code).analysis.generatedAt, r3.analysis.generatedAt, 'created more than once');
});

// ── AI service (mocked HTTP) ──────────────────────────────────────────────
const KEY = 'sk-ant-test-key-never-real-0123456789';
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length, { url, init });
  };
  fn.calls = calls;
  return fn;
}
const jsonResponse = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
function aiReply(room, extra = {}) {
  const franchises = {};
  for (const [fid, e] of Object.entries(room.analysis.franchises)) {
    if (!e.participating) continue;
    const squad = room.franchises[fid].squad;
    franchises[fid] = { report: `${e.franchiseName} report from supplied data.`, strengths: ['Depth'], weaknesses: ['Spin'], recommendations: ['Plan overs'], suggestedXI: squad.slice(0, 1).map(p => p.id), missingInformation: ['No match statistics provided'] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ summary: 'Summary.', comparison: 'Comparison.', franchises, ...extra }) }], stop_reason: 'end_turn' };
}
function aiManager(fetchImpl, envExtra = {}) {
  const env = { ANTHROPIC_API_KEY: KEY, AI_ANALYSIS_ENABLED: 'true', ANTHROPIC_MODEL: 'test-model', AI_REGENERATE_COOLDOWN_MS: '0', AI_TIMEOUT_MS: '1000', ...envExtra };
  return trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('ai'), aiEnv: env, aiDeps: { fetchImpl } }));
}

await t.it('A12: AI output validation — unknown franchises dropped, invalid XIs removed, "eligible" claims for ineligible squads rejected, junk refused', () => {
  const rm = make();
  const { room } = finishedRoom(rm, 20); // 20 lots: neither squad can reach 15 players
  const input = buildAiInput(room, room.analysis);
  assert.ok(!input.franchises.find(f => f.franchiseId === 'MI').ruleEligibility.eligible, 'test setup: MI should be ineligible');
  const outsider = room.franchises.CSK.squad[0].id;
  const text = '```json\n' + JSON.stringify({
    summary: 'S', comparison: 'C',
    franchises: {
      MI: { report: 'MI is fully eligible and strong.', strengths: [], weaknesses: [], recommendations: [] },
      CSK: { report: 'CSK report', suggestedXI: [outsider, 'PL_NOT_THERE'] },
      HACKERS: { report: 'x' }
    }
  }) + '\n```';
  const { value, problems } = validateAiOutput(text, input);
  assert.ok(!value.franchises.MI, 'eligibility claim for an ineligible squad accepted');
  assert.ok(!value.franchises.HACKERS);
  assert.strictEqual(value.franchises.CSK.suggestedXI, null, 'invalid XI kept');
  assert.ok(problems.some(p => /HACKERS/.test(p)) && problems.some(p => /suggested XI/.test(p)) && problems.some(p => /eligible/.test(p)));
  assert.strictEqual(validateAiOutput('I cannot help with that.', input).value, null);
  const honest = validateAiOutput(JSON.stringify({ summary: 'S', franchises: { MI: { report: 'MI is not eligible: the squad has too few players.' } } }), input);
  assert.ok(honest.value.franchises.MI, 'a correct "not eligible" statement was rejected');
});

await t.it('A13: AI reports are generated once, stored separately, deduplicated, and never change scores or ranks', async () => {
  let room;
  const fetchImpl = mockFetch(() => jsonResponse(200, {
    ...aiReply(room, { rankings: [{ franchiseId: 'RR', rank: 1 }] }),
  }));
  const rm = aiManager(fetchImpl);
  const r = finishedRoom(rm);
  room = r.room;
  const before = strip(room.analysis);
  const res = await Promise.all([1, 2, 3].map(() => rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.A })));
  assert.deepStrictEqual(res.map(x => x.status), ['generating', 'generating', 'generating']);
  await rm.aiInFlight.get(r.code);
  await sleep(10);
  assert.strictEqual(fetchImpl.calls.length, 1, 'concurrent requests made several AI calls');
  assert.strictEqual(room.aiAnalysis.status, 'ready');
  assert.strictEqual(room.aiAnalysis.evaluationChecksum, room.analysis.inputChecksum);
  assert.deepStrictEqual(strip(room.analysis), before, 'AI changed the deterministic snapshot');
  assert.ok(!('rankings' in room.aiAnalysis.result), 'AI rankings were stored');
  const again = rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.H });
  assert.strictEqual(again.status, 'ready');
  assert.strictEqual(again.cached, true);
  assert.strictEqual(fetchImpl.calls.length, 1, 'cached report re-requested from the AI');
  // the request carried the key header, the configured model, and no participant names/tokens
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.headers['x-api-key'], KEY);
  assert.strictEqual(call.body.model, 'test-model');
  const sent = JSON.stringify(call.body);
  for (const secret of [r.H, r.A, 'Alice']) assert.ok(!sent.includes(secret), `prompt contains ${secret.slice(0, 8)}`);
  // public state never contains the key
  assert.ok(!JSON.stringify(rm.getPublicRoomState(room)).includes(KEY));
});

await t.it('A14: regeneration is host-only, rate-limited and capped; a non-participant or a live auction is refused', async () => {
  let room;
  const fetchImpl = mockFetch(() => jsonResponse(200, aiReply(room)));
  const rm = aiManager(fetchImpl, { AI_REGENERATE_COOLDOWN_MS: '60000', AI_MAX_ATTEMPTS_PER_ROOM: '2' });
  const r = finishedRoom(rm);
  room = r.room;
  rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.A });
  await rm.aiInFlight.get(r.code); await sleep(5);
  assert.match(rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.A, force: true }).error, /Only the host/);
  const limited = rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.H, force: true });
  assert.strictEqual(limited.code, 'RATE_LIMITED');
  room.aiAnalysis.lastAttemptAt = new Date(Date.now() - 61000).toISOString();
  assert.strictEqual(rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.H, force: true }).status, 'generating');
  await rm.aiInFlight.get(r.code); await sleep(5);
  room.aiAnalysis.lastAttemptAt = new Date(Date.now() - 61000).toISOString();
  assert.strictEqual(rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.H, force: true }).code, 'LIMIT_REACHED');
  assert.strictEqual(fetchImpl.calls.length, 2);
  assert.match(rm.requestAiAnalysis({ roomCode: r.code, participantToken: strongToken('nobody') }).error, /not a participant/);
  const live = liveRoom(rm);
  assert.match(rm.requestAiAnalysis({ roomCode: live.code, participantToken: live.H }).error, /after the auction has finished/);
  assert.strictEqual(fetchImpl.calls.length, 2, 'AI called for a live auction');
});

await t.it('A15: AI timeout, HTTP errors and invalid output fail safely — deterministic results stay, a previous good report is kept, the key never leaks', async () => {
  // timeout: fetch that only ends when aborted
  const hang = mockFetch((n, { init }) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); })));
  const rm = aiManager(hang);
  const r = finishedRoom(rm);
  const snap = strip(r.room.analysis);
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.A });
    await rm.aiInFlight.get(r.code); await sleep(5);
  } finally { console.error = origErr; }
  assert.strictEqual(r.room.aiAnalysis.status, 'failed');
  assert.strictEqual(r.room.aiAnalysis.lastError.code, 'TIMEOUT');
  assert.deepStrictEqual(strip(r.room.analysis), snap);
  assert.ok(!logs.join('\n').includes(KEY) && !JSON.stringify(r.room.aiAnalysis).includes(KEY), 'API key leaked');
  assert.ok(r.room.analysis.franchises.MI.explanation.report.length > 20, 'no rule-based fallback text');

  // good report, then a failing regeneration keeps it
  let mode = 'ok';
  let room2;
  const flaky = mockFetch(() => (mode === 'ok' ? jsonResponse(200, aiReply(room2)) : mode === '500' ? jsonResponse(500, { error: { type: 'api_error' } }) : jsonResponse(200, { content: [{ type: 'text', text: 'not json' }] })));
  const rm2 = aiManager(flaky);
  const r2 = finishedRoom(rm2);
  room2 = r2.room;
  rm2.requestAiAnalysis({ roomCode: r2.code, participantToken: r2.A });
  await rm2.aiInFlight.get(r2.code); await sleep(5);
  const good = structuredClone(room2.aiAnalysis.result);
  for (const m of ['500', 'junk']) {
    mode = m;
    rm2.requestAiAnalysis({ roomCode: r2.code, participantToken: r2.H, force: true });
    await rm2.aiInFlight.get(r2.code); await sleep(5);
    assert.strictEqual(room2.aiAnalysis.status, 'ready');
    assert.deepStrictEqual(room2.aiAnalysis.result, good, 'previous good report lost');
    assert.strictEqual(room2.aiAnalysis.lastError.code, m === '500' ? 'HTTP_500' : 'INVALID_RESPONSE');
  }
});

await t.it('A16: without an API key, AI is reported unavailable and never called; the deterministic analysis is complete', () => {
  const fetchImpl = mockFetch(() => { throw new Error('must not be called'); });
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('noai'), aiEnv: {}, aiDeps: { fetchImpl } }));
  const r = finishedRoom(rm);
  const res = rm.requestAiAnalysis({ roomCode: r.code, participantToken: r.A });
  assert.strictEqual(res.status, 'unavailable');
  assert.strictEqual(fetchImpl.calls.length, 0);
  const pub = rm.getPublicRoomState(r.room);
  assert.strictEqual(pub.aiAnalysis.available, false);
  for (const e of Object.values(pub.analysis.franchises)) assert.ok(e.explanation.report, `${e.franchiseId} has no rule-based report`);
  assert.strictEqual(aiConfig({}).enabled, false);
  assert.strictEqual(aiConfig({ ANTHROPIC_API_KEY: 'x', AI_ANALYSIS_ENABLED: 'false' }).enabled, false);
  assert.strictEqual(aiConfig({ ANTHROPIC_API_KEY: 'x' }).enabled, false, 'a key alone must not enable paid AI calls (opt-in)');
  assert.strictEqual(aiConfig({ ANTHROPIC_API_KEY: 'x', AI_ANALYSIS_ENABLED: 'true' }).enabled, true);
});

await t.it('A17: the prompt is built only from verified data — no participant names, tokens or socket ids', () => {
  const rm = make();
  const r = finishedRoom(rm);
  const { system, user } = buildPrompt(buildAiInput(r.room, r.room.analysis));
  const all = system + user;
  for (const secret of [r.H, r.A, 'Alice', 'Host"', 'sock-']) assert.ok(!all.includes(secret), `prompt contains ${secret}`);
  assert.match(system, /Never invent statistics/);
  assert.match(system, /never call it eligible/i);
});

process.exit(await t.finish());
