// Backward compatibility with pre-Stage-0.5 data and browser sessions.
// tests/fixtures/pre-stage-0.5-room.json was produced by the ORIGINAL code (commit f2dc3b8)
// with tokens in the old browser format: active auction, lot 2 open with a CSK bid,
// lot 1 sold to MI, old config 11/15/15s, no publicId/ownerId fields.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startServer, connect, emit, waitFor, makeRunner, strongToken, tempStorageFile, findPrivateData, assertRejected
} from './helpers/harness.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(dir, 'fixtures', 'pre-stage-0.5-room.json');
const LEGACY_HOST = 'usr_1731740000000_h0st01';
const LEGACY_ALICE = 'usr_1731740000123_a1ice2';
const { isValidToken } = await import('../server/security.js');
const { createSessionStore, generateToken, LEGACY_TOKEN_RE } = await import('../client/src/utils/session.js');

const t = makeRunner('Backward Compatibility Suite (legacy rooms, legacy tokens, sessions)');

// ── Browser session module ────────────────────────────────────
const memoryStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), dump: () => Object.fromEntries(m) };
};

await t.it('every token format the OLD client could generate passes the new server check', () => {
  // Old: 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8) (0–6 chars)
  for (let i = 0; i < 5000; i++) {
    const tok = 'usr_' + (1600000000000 + i * 7919) + '_' + Math.random().toString(36).substring(2, 8);
    assert.ok(isValidToken(tok), `legacy token rejected: ${tok}`);
  }
  for (const edge of ['usr_1731740000000_', 'usr_1731740000000_a', LEGACY_HOST, LEGACY_ALICE]) {
    assert.ok(isValidToken(edge), `edge legacy token rejected: ${edge}`);
  }
});

await t.it('legacy token is KEPT while the user has a room to rejoin (reconnection keeps working)', () => {
  const st = memoryStorage({ ipl_user_token: LEGACY_ALICE, ipl_user_name: 'LegacyAlice', ipl_room_code: 'ABC123' });
  const s = createSessionStore(st).getUserSession();
  assert.strictEqual(s.token, LEGACY_ALICE);
  assert.strictEqual(s.lastRoom, 'ABC123');
  assert.strictEqual(s.name, 'LegacyAlice');
});

await t.it('legacy token with no room is upgraded to a strong token; strong tokens are kept', () => {
  const st = memoryStorage({ ipl_user_token: LEGACY_ALICE });
  const s = createSessionStore(st).getUserSession();
  assert.notStrictEqual(s.token, LEGACY_ALICE);
  assert.match(s.token, /^usr_[0-9a-f]{32}$/);
  assert.ok(!LEGACY_TOKEN_RE.test(s.token));
  assert.strictEqual(st.dump().ipl_user_token, s.token, 'upgrade not persisted');
  assert.strictEqual(createSessionStore(st).getUserSession().token, s.token, 'strong token not stable');
  const fresh = createSessionStore(memoryStorage()).getUserSession();
  assert.ok(isValidToken(fresh.token), 'generated token rejected by server');
  assert.notStrictEqual(generateToken(), generateToken());
});

// ── Genuine legacy room through the new server ───────────────
const storageFile = tempStorageFile('compat');
fs.copyFileSync(FIXTURE, storageFile);
const legacy = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
const code = Object.keys(legacy)[0];
const legacyLot = legacy[code].currentLot;
const srv = await startServer({ storageFile });
const captured = [];
const record = (s, who) => s.onAny((ev, p) => captured.push({ src: `event→${who}`, ev, p }));

try {
  const pub0 = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
  captured.push({ src: 'REST', ev: 'GET room', p: pub0 });

  await t.it('legacy room loads: paused, same lot and bid, own old config kept, countdown reset to its timer', () => {
    assert.strictEqual(pub0.status, 'paused');
    assert.strictEqual(pub0.currentLot.lotNumber, legacyLot.lotNumber);
    assert.strictEqual(pub0.currentLot.highestBidderFranchiseId, 'CSK');
    assert.strictEqual(pub0.currentLot.highestBid, legacyLot.highestBid);
    assert.deepStrictEqual([pub0.config.minSquadSize, pub0.config.maxSquadSize, pub0.config.timerDuration], [11, 15, 15],
      'approved new defaults must not be applied retroactively to an existing room');
    assert.strictEqual(pub0.currentLot.countdown, 15, 'countdown should reset to the room timer (15s)');
    assert.strictEqual(pub0.franchises.MI.squad.length, 1, 'earlier sale lost');
    assert.ok(pub0.franchises.MI.ownerId?.startsWith('p_') && pub0.franchises.CSK.ownerId?.startsWith('p_'), 'ownership not migrated');
  });

  const host = await connect(srv.url); record(host, 'host');
  const alice = await connect(srv.url); record(alice, 'alice');
  const hj = await emit(host, 'join_room', { roomCode: code, participantName: 'LegacyHost', participantToken: LEGACY_HOST });
  const aj = await emit(alice, 'join_room', { roomCode: code, participantName: 'LegacyAlice', participantToken: LEGACY_ALICE });
  captured.push({ src: 'ack→host', ev: 'join_room', p: hj }, { src: 'ack→alice', ev: 'join_room', p: aj });

  await t.it('legacy-token users reconnect to their existing room and franchise (active auction, joins closed)', () => {
    assert.ok(hj.success, hj.error);
    assert.ok(aj.success, aj.error);
    assert.strictEqual(hj.participant.isHost, true);
    assert.strictEqual(hj.participant.franchiseId, 'CSK');
    assert.strictEqual(aj.participant.isHost, false);
    assert.strictEqual(aj.participant.franchiseId, 'MI');
    assert.strictEqual(aj.room.franchises.MI.ownerId, aj.participant.publicId, 'client could not find its own franchise');
  });

  await t.it('an unknown token cannot join the legacy (active) room', async () => {
    const s = await connect(srv.url);
    assertRejected(await emit(s, 'join_room', { roomCode: code, participantName: 'LegacyAlice', participantToken: strongToken('x') }), 'late join');
  });

  await t.it('legacy non-host cannot run host actions; legacy host can resume', async () => {
    for (const ev of ['resume_auction', 'pause_auction', 'advance_lot', 'skip_set', 'finish_auction']) {
      assertRejected(await emit(alice, ev, { roomCode: code }), `alice ${ev}`);
    }
    assertRejected(await emit(alice, 'resume_auction', { roomCode: code, hostToken: LEGACY_HOST }), 'alice quoting host token');
    const tick = waitFor(alice, 'timer_tick', () => true, 3000);
    const r = await emit(host, 'resume_auction', { roomCode: code });
    assert.ok(r.success, r.error);
    assert.strictEqual((await tick).countdown, 14);
  });

  await t.it('legacy users bid only for their own franchise; cannot edit the other XI', async () => {
    const room = await (await fetch(`${srv.url}/api/rooms/${code}`)).json();
    const lot = room.currentLot;
    assertRejected(await emit(host, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion }), 'host bidding for MI');
    const ok = await emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
    assert.ok(ok.success, ok.error);
    assertRejected(await emit(alice, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [] }), 'alice editing CSK XI');
  });

  await t.it('copying another player\'s display name is not a session takeover', async () => {
    // A different browser (new token) using "LegacyHost" as its name cannot join an active room,
    // and even in a lobby it would be a separate participant without the host's rights.
    const s = await connect(srv.url);
    assertRejected(await emit(s, 'join_room', { roomCode: code, participantName: 'LegacyHost', participantToken: strongToken('copy') }), 'name copy');
    const still = await emit(host, 'pause_auction', { roomCode: code });
    assert.ok(still.success, 'real host lost control');
  });

  await t.it('no payload in the legacy flow contains a legacy token, socket id or private field', () => {
    const secrets = [LEGACY_HOST, LEGACY_ALICE, 'old-sock-1', 'old-sock-2', host.id, alice.id];
    const forbiddenKeys = ['ownerToken', 'ownerSocketId', 'hostToken', 'participantToken', 'token', 'socketId', 'participants'];
    const problems = captured.flatMap(c => findPrivateData(c.p, { secrets, forbiddenKeys }).map(h => `${c.src} ${c.ev}: ${h}`));
    assert.ok(captured.length >= 5, 'too few payloads captured');
    assert.deepStrictEqual(problems, [], problems.slice(0, 8).join('\n'));
  });
} finally {
  await srv.stop();
}

const failed = await t.finish();
process.exit(failed ? 1 : 0);
