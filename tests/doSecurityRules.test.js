// Durable Object security, session and auction-rule verification in the REAL local workerd
// runtime (Miniflare, SQLite-backed Durable Objects, native WebSockets).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Miniflare } from 'miniflare';
import { makeRunner } from './helpers/harness.js';
import { bundleWorker } from './e2e/harness.js';
import { AuctionRoomDO } from '../cloudflare/src/AuctionRoomDO.js';

const t = makeRunner('Durable Object security, sessions & auction rules (local workerd)');
const ORIGIN = 'https://ipl-auction-omega-nine.vercel.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tok = (label) => `usr_${label}_${'x'.repeat(Math.max(0, 20 - label.length))}`;

async function makeMf({ persist = null, bindings = {} } = {}) {
  return new Miniflare({
    modules: true,
    script: bundleWorker(),
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { ENVIRONMENT: 'development', ...bindings },
    durableObjects: { AUCTION_ROOMS: { className: 'AuctionRoomDO', useSQLite: true } },
    ...(persist ? { durableObjectsPersist: persist } : {})
  });
}

class Client {
  constructor(mf, code, origin = ORIGIN) { this.mf = mf; this.code = code; this.origin = origin; this.msgs = []; this.seq = 0; }
  async open() {
    const res = await this.mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${this.code}/ws`, { headers: { Upgrade: 'websocket', Origin: this.origin } });
    if (!res.webSocket) { this.status = res.status; return this; }
    this.ws = res.webSocket;
    this.ws.accept();
    this.ws.addEventListener('message', e => this.msgs.push(JSON.parse(e.data)));
    this.closed = false;
    this.ws.addEventListener('close', () => { this.closed = true; });
    this.ws.addEventListener('error', () => { this.closed = true; });
    return this;
  }
  // Paced to ~20 msgs/s per socket so the tests stay under the server's 30 msgs/s rate limit
  async req(type, payload = {}, id = null) {
    const wait = (this.lastSend || 0) + 50 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastSend = Date.now();
    const mid = id || `m${++this.seq}_${Math.random().toString(36).slice(2, 8)}`;
    this.ws.send(JSON.stringify({ id: mid, type, payload }));
    return this.waitFor(m => m.id === mid && (m.type === 'ACK' || m.type === 'ERROR'));
  }
  async waitFor(pred, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = this.msgs.find(pred);
      if (m) return m;
      await sleep(10);
    }
    throw new Error('timeout waiting for message');
  }
  last(type) { return [...this.msgs].reverse().find(m => m.type === type); }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

async function createRoom(mf, name, token) {
  const r = await mf.dispatchFetch('https://edge.workers.dev/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ hostName: name, hostToken: token })
  });
  const d = await r.json();
  return d.roomCode;
}
const state = async (mf, code) => (await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${code}`, { headers: { Origin: ORIGIN } })).json();

const mf = await makeMf();
await mf.ready;

// Shared room with host + 3 players
const HOST = tok('host'), P1 = tok('p1'), P2 = tok('p2'), P3 = tok('p3');
const code = await createRoom(mf, 'Host', HOST);
const host = await new Client(mf, code).open();
const c1 = await new Client(mf, code).open();
const c2 = await new Client(mf, code).open();
const c3 = await new Client(mf, code).open();

await t.it('join, claim distinct franchises; duplicate claim is refused', async () => {
  assert.equal((await host.req('JOIN_ROOM', { participantName: 'Host', participantToken: HOST })).success, true);
  assert.equal((await c1.req('JOIN_ROOM', { participantName: 'P1', participantToken: P1 })).success, true);
  assert.equal((await c2.req('JOIN_ROOM', { participantName: 'P2', participantToken: P2 })).success, true);
  assert.equal((await c3.req('JOIN_ROOM', { participantName: 'P3', participantToken: P3 })).success, true);
  assert.equal((await host.req('SELECT_FRANCHISE', { franchiseId: 'CSK' })).success, true);
  assert.equal((await c1.req('SELECT_FRANCHISE', { franchiseId: 'MI' })).success, true);
  assert.equal((await c2.req('SELECT_FRANCHISE', { franchiseId: 'RCB' })).success, true);
  const dup = await c3.req('SELECT_FRANCHISE', { franchiseId: 'MI' });
  assert.equal(dup.success, false);
  assert.equal((await c3.req('SELECT_FRANCHISE', { franchiseId: 'KKR' })).success, true);
});

await t.it('public state never contains tokens or token hashes', async () => {
  const s = JSON.stringify(await state(mf, code));
  for (const secret of [HOST, P1, P2, P3]) assert.ok(!s.includes(secret), 'raw token leaked');
  assert.ok(!/ownerTokenHash|hostTokenHash|tokenHash|rawToken|ownerToken"/.test(s), 'hash fields leaked');
});

await t.it('host privilege escalation is refused (start/pause/skip/finish/config by non-host, spoofed hostToken)', async () => {
  for (const type of ['START_AUCTION', 'UPDATE_CONFIG', 'FINISH_AUCTION']) {
    const r = await c1.req(type, type === 'UPDATE_CONFIG' ? { config: { autoAdvanceDelay: 5 } } : {});
    assert.equal(r.success, false, `${type} must be host-only`);
  }
  const spoof = await c1.req('START_AUCTION', { hostToken: HOST });
  assert.equal(spoof.success, false);
  assert.match(spoof.error, /Unauthorized/);
});

await t.it('actions without joining, or on another room, are refused (cross-room authorization)', async () => {
  const other = await createRoom(mf, 'Other', tok('otherhost'));
  const intruder = await new Client(mf, other).open();
  const r = await intruder.req('SELECT_FRANCHISE', { franchiseId: 'CSK', participantToken: P1 });
  assert.equal(r.success, false);
  intruder.close();
});

let deadlineAtStart;
await t.it('host starts; all clients receive the same first lot', async () => {
  const r = await host.req('START_AUCTION');
  assert.equal(r.success, true, r.error);
  const lots = await Promise.all([host, c1, c2, c3].map(c => c.waitFor(m => m.type === 'LOT_PRESENTED')));
  const ids = new Set(lots.map(l => l.payload.currentLot.player.id));
  assert.equal(ids.size, 1);
  deadlineAtStart = lots[0].payload.deadlineEpochMs;
  assert.ok(deadlineAtStart - Date.now() > 13000 && deadlineAtStart - Date.now() <= 15100, '15 s timer');
});

await t.it('franchise impersonation: bidding for a franchise you do not own is refused', async () => {
  const r = await c1.req('PLACE_BID', { franchiseId: 'CSK' });
  assert.equal(r.success, false);
  assert.match(r.error, /do not own/i);
});

await t.it('invalid bid does NOT reset the timer; a valid bid resets it to 15 s', async () => {
  const s0 = await state(mf, code);
  const d0 = s0.currentLot.deadlineEpochMs;
  await sleep(1200);
  const bad = await c1.req('PLACE_BID', { franchiseId: 'MI', bidAmount: 999 }); // wrong amount
  assert.equal(bad.success, false);
  const s1 = await state(mf, code);
  assert.equal(s1.currentLot.deadlineEpochMs, d0, 'deadline unchanged after invalid bid');
  const good = await c1.req('PLACE_BID', { franchiseId: 'MI', expectedVersion: s1.currentLot.stateVersion });
  assert.equal(good.success, true, good.error);
  const s2 = await state(mf, code);
  assert.ok(s2.currentLot.deadlineEpochMs > d0 + 1000, 'deadline moved forward');
  assert.ok(Math.abs(s2.currentLot.deadlineEpochMs - (Date.now() + 15000)) < 1500, 'reset to ~15 s');
});

await t.it('simultaneous bids at the same version: exactly one is accepted', async () => {
  const s = await state(mf, code);
  const v = s.currentLot.stateVersion;
  const res = await Promise.all([
    host.req('PLACE_BID', { franchiseId: 'CSK', expectedVersion: v }),
    c2.req('PLACE_BID', { franchiseId: 'RCB', expectedVersion: v }),
    c3.req('PLACE_BID', { franchiseId: 'KKR', expectedVersion: v })
  ]);
  assert.equal(res.filter(r => r.success).length, 1);
  const after = await state(mf, code);
  assert.equal(after.currentLot.stateVersion, v + 1);
});

await t.it('replayed message id is answered from the ACK cache and not applied twice', async () => {
  const s = await state(mf, code);
  const leader = s.currentLot.highestBidderFranchiseId;
  const bidder = leader === 'MI' ? c2 : c1;
  const fid = leader === 'MI' ? 'RCB' : 'MI';
  const first = await bidder.req('PLACE_BID', { franchiseId: fid, expectedVersion: s.currentLot.stateVersion }, 'replay-1');
  assert.equal(first.success, true, first.error);
  const versionAfter = (await state(mf, code)).currentLot.stateVersion;
  bidder.msgs = [];
  const again = await bidder.req('PLACE_BID', { franchiseId: fid, expectedVersion: s.currentLot.stateVersion }, 'replay-1');
  assert.equal(again.success, true);
  assert.equal((await state(mf, code)).currentLot.stateVersion, versionAfter, 'not applied twice');
});

await t.it('reconnect with the same token reuses the participant and franchise (no duplicates); old socket is replaced', async () => {
  const before = await state(mf, code);
  const again = await new Client(mf, code).open();
  const j = await again.req('JOIN_ROOM', { participantName: 'P1-renamed', participantToken: P1 });
  assert.equal(j.success, true);
  assert.equal(j.payload.participant.franchiseId, 'MI');
  assert.equal(j.payload.participant.name, 'P1', 'original registered name kept');
  await c1.waitFor(m => m.type === 'SESSION_REPLACED');
  const after = await state(mf, code);
  assert.equal(after.franchises.MI.ownerId, before.franchises.MI.ownerId);
  const stale = await c1.req('PLACE_BID', { franchiseId: 'MI' }).catch(() => ({ success: false }));
  assert.equal(stale.success, false, 'replaced connection cannot act');
  c1.ws = again.ws; c1.msgs = again.msgs; // continue with the new socket
});

await t.it('explicit LEAVE_ROOM keeps the franchise; rejoining restores it', async () => {
  const r = await c3.req('LEAVE_ROOM');
  assert.equal(r.success, true);
  await sleep(100);
  assert.equal(c3.closed, true, 'server closed the left connection');
  const s = await state(mf, code);
  assert.equal(s.franchises.KKR.isClaimed, true, 'franchise kept after leave');
  const back = await new Client(mf, code).open();
  const j = await back.req('JOIN_ROOM', { participantName: 'P3', participantToken: P3 });
  assert.equal(j.success, true);
  assert.equal(j.payload.participant.franchiseId, 'KKR');
  back.close();
});

await t.it('new participants cannot join once the auction has started', async () => {
  const late = await new Client(mf, code).open();
  const r = await late.req('JOIN_ROOM', { participantName: 'Late', participantToken: tok('late') });
  assert.equal(r.success, false);
  late.close();
});

await t.it('pause freezes the clock and refuses bids; resume restores remaining time', async () => {
  assert.equal((await host.req('PAUSE_AUCTION')).success, true);
  const p = await state(mf, code);
  assert.equal(p.status, 'paused');
  assert.equal(p.currentLot.deadlineEpochMs, null);
  const r = await c2.req('PLACE_BID', { franchiseId: 'RCB' });
  assert.equal(r.success, false);
  assert.equal((await host.req('RESUME_AUCTION')).success, true);
  const q = await state(mf, code);
  assert.equal(q.status, 'active');
  assert.ok(q.currentLot.deadlineEpochMs > Date.now());
});

await t.it('SOLD: purse is debited in integer lakhs, squad grows, no duplicate sale; host can hammer', async () => {
  const s = await state(mf, code);
  const leader = s.currentLot.highestBidderFranchiseId;
  const price = s.currentLot.highestBid;
  const pid = s.currentLot.player.id;
  const purseBefore = s.franchises[leader].remainingPurse;
  assert.equal((await host.req('ADVANCE_LOT')).success, true);
  const done = await host.waitFor(m => m.type === 'LOT_COMPLETED');
  assert.equal(done.payload.result, 'SOLD');
  const s2 = await state(mf, code);
  assert.equal(Math.round(s2.franchises[leader].remainingPurse * 100), Math.round(purseBefore * 100) - Math.round(price * 100));
  assert.ok(s2.franchises[leader].squad.some(p => p.id === pid));
  const owners = Object.values(s2.franchises).filter(f => f.squad.some(p => p.id === pid));
  assert.equal(owners.length, 1, 'sold exactly once');
  assert.equal(done.payload.franchises, undefined, 'delta broadcast (no full franchise list)');
  assert.ok(done.payload.franchiseUpdates[leader], 'winner delta present');
});

await t.it('overseas cap: a franchise with 8 overseas players cannot bid on another overseas player', async () => {
  // Drive lots: CSK (host) buys every overseas player at base price until it has 8
  let guard = 0;
  while (guard++ < 200) {
    let s = await state(mf, code);
    if (s.franchises.CSK.overseasCount >= 8) break;
    if (!s.currentLot || s.currentLot.hammerStatus !== 'OPEN') { await host.req('ADVANCE_LOT'); continue; }
    if (s.currentLot.player.isOverseas && !s.currentLot.highestBidderFranchiseId) {
      const b = await host.req('PLACE_BID', { franchiseId: 'CSK', expectedVersion: s.currentLot.stateVersion });
      assert.equal(b.success, true, b.error);
    }
    await host.req('ADVANCE_LOT'); // hammer
    s = await state(mf, code);
    if (s.currentLot && s.currentLot.hammerStatus !== 'OPEN') await host.req('ADVANCE_LOT'); // next lot
  }
  let s = await state(mf, code);
  assert.equal(s.franchises.CSK.overseasCount, 8);
  guard = 0;
  while (guard++ < 200 && !(s.currentLot?.hammerStatus === 'OPEN' && s.currentLot.player.isOverseas)) {
    await host.req('ADVANCE_LOT');
    s = await state(mf, code);
  }
  const r = await host.req('PLACE_BID', { franchiseId: 'CSK', expectedVersion: s.currentLot.stateVersion });
  assert.equal(r.success, false);
  assert.match(r.error, /Overseas/i);
  const d = (await state(mf, code)).currentLot.deadlineEpochMs;
  assert.equal(d, s.currentLot.deadlineEpochMs, 'rejected bid did not reset the timer');
});

await t.it('Playing XI: server rejects an incomplete XI and edits to a franchise you do not own', async () => {
  const s = await state(mf, code);
  const squad = s.franchises.CSK.squad.map(p => p.id);
  const short = await host.req('UPDATE_PLAYING_XI', { franchiseId: 'CSK', playingXI: squad.slice(0, 5), captainId: squad[0], viceCaptainId: squad[1] });
  assert.equal(short.success, false);
  const foreign = await c2.req('UPDATE_PLAYING_XI', { franchiseId: 'CSK', playingXI: squad.slice(0, 11) });
  assert.equal(foreign.success, false);
  assert.equal(foreign.code, 'FORBIDDEN');
});

await t.it('purse can never go negative across every franchise', async () => {
  const s = await state(mf, code);
  for (const f of Object.values(s.franchises)) assert.ok(f.remainingPurse >= 0, `${f.id} purse ${f.remainingPurse}`);
});

await t.it('Skip Set marks the rest of the current set SKIPPED and moves to the next set', async () => {
  let s = await state(mf, code);
  if (s.currentLot?.hammerStatus !== 'OPEN') { await host.req('ADVANCE_LOT'); s = await state(mf, code); }
  const setKey = s.currentLot.player.categorySet;
  const r = await host.req('SKIP_SET');
  assert.equal(r.success, true, r.error);
  const s2 = await state(mf, code);
  const remainingInSet = s2.playersCatalog.filter(p => p.categorySet === setKey && !['sold', 'unsold', 'SKIPPED', 'skipped'].includes(p.status));
  assert.equal(remainingInSet.length, 0);
  assert.notEqual(s2.currentLot.player.categorySet, setKey);
});

await t.it('Worker restart: room, purses, squads and current lot survive; clients reconnect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'do-persist-'));
  let m1 = await makeMf({ persist: dir });
  const rc = await createRoom(m1, 'H', HOST);
  const h = await new Client(m1, rc).open();
  await h.req('JOIN_ROOM', { participantName: 'H', participantToken: HOST });
  await h.req('SELECT_FRANCHISE', { franchiseId: 'GT' });
  const g = await new Client(m1, rc).open();
  await g.req('JOIN_ROOM', { participantName: 'G', participantToken: P2 });
  await g.req('SELECT_FRANCHISE', { franchiseId: 'LSG' });
  const st = await h.req('START_AUCTION');
  assert.equal(st.success, true, st.error);
  const s1 = await state(m1, rc);
  await h.req('PLACE_BID', { franchiseId: 'GT', expectedVersion: s1.currentLot.stateVersion });
  const before = await state(m1, rc);
  h.close(); g.close();
  await sleep(50);
  await m1.dispose();
  const m2 = await makeMf({ persist: dir });
  const after = await state(m2, rc);
  assert.equal(after.status, before.status);
  assert.equal(after.currentLot.player.id, before.currentLot.player.id);
  assert.equal(after.currentLot.highestBid, before.currentLot.highestBid);
  assert.equal(after.franchises.GT.ownerId, before.franchises.GT.ownerId);
  const h2 = await new Client(m2, rc).open();
  const j = await h2.req('JOIN_ROOM', { participantName: 'H', participantToken: HOST });
  assert.equal(j.success, true);
  assert.equal(j.payload.participant.franchiseId, 'GT');
  h2.close();
  await sleep(50);
  await m2.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function wsUpgradeStatus(mfInst, reqPath, headers = {}) {
  const base = await mfInst.ready;
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(reqPath, base), {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers
      }
    }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

await t.it('production: disallowed Origin is refused for WebSocket and room creation; missing secret → 503', async () => {
  const prod = await makeMf({ bindings: { ENVIRONMENT: 'production', TOKEN_HASH_SECRET: 'p'.repeat(40) } });
  const bad = await prod.dispatchFetch('https://edge.workers.dev/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ hostName: 'X', hostToken: HOST })
  });
  assert.equal(bad.status, 403);
  assert.equal(await wsUpgradeStatus(prod, '/api/rooms/ABCDEF/ws', { Origin: 'https://evil.example' }), 403);
  assert.equal(await wsUpgradeStatus(prod, '/api/rooms/ABCDEF/ws'), 403, 'production requires an Origin');
  await prod.dispose();
  const unconfigured = await makeMf({ bindings: { ENVIRONMENT: 'production' } });
  const r = await unconfigured.dispatchFetch('https://edge.workers.dev/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ hostName: 'X', hostToken: HOST })
  });
  assert.equal(r.status, 503);
  await unconfigured.dispose();
});

await t.it('request limits: oversized create body (413), oversized WS frame and malformed messages are rejected', async () => {
  const big = await mf.dispatchFetch('https://edge.workers.dev/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ hostName: 'X', hostToken: HOST, pad: 'x'.repeat(10000) })
  });
  assert.equal(big.status, 413);
  const c = await new Client(mf, code).open();
  c.ws.send('x'.repeat(40000));
  await c.waitFor(m => m.type === 'ERROR' && /too large/i.test(m.error));
  c.ws.send('{not json');
  await c.waitFor(m => m.type === 'ERROR' && /Malformed/i.test(m.error));
  c.ws.send(JSON.stringify({ id: 'p', type: 'JOIN_ROOM', payload: [] }));
  await c.waitFor(m => m.id === 'p' && m.success === false);
  c.close();
});

await t.it('per-connection rate limit: a burst above 30 msgs/s is refused', async () => {
  const c = await new Client(mf, code).open();
  for (let i = 0; i < 45; i++) c.ws.send(JSON.stringify({ id: `burst${i}`, type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
  await c.waitFor(m => m.type === 'ERROR' && /Rate limit/i.test(m.error));
  c.close();
});

await t.it('room creation is rate limited per client address (10 per minute)', async () => {
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const r = await mf.dispatchFetch('https://edge.workers.dev/api/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7' },
      body: JSON.stringify({ hostName: 'Spam', hostToken: HOST })
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.ok(statuses.slice(10).every(s => s === 429), `statuses ${statuses}`);
});

await t.it('room-code collision never overwrites an existing room (DO refuses a second init)', async () => {
  const doInst = new AuctionRoomDO({ storage: {} }, {});
  const init = (name) => doInst.fetch(new Request('https://internal/init', { method: 'POST', body: JSON.stringify({ roomCode: 'SAME01', hostName: name, hostToken: HOST }) }));
  assert.equal((await init('First')).status, 200);
  assert.equal((await init('Second')).status, 409);
  assert.equal(doInst.room.hostName, 'First');
  assert.equal(doInst.room.hostToken, undefined, 'raw token not kept in memory');
  assert.ok(/^[0-9a-f]{64}$/.test(doInst.room.hostTokenHash));
});

await t.it('rooms from older builds with raw tokens are migrated to hashes on load', async () => {
  const doInst = new AuctionRoomDO({ storage: {} }, {});
  doInst.room = {
    roomCode: 'OLD001', hostToken: HOST, franchises: { CSK: { id: 'CSK', ownerToken: P1, isClaimed: true } },
    participants: new Map([['h', { tokenHash: 'h', rawToken: P1 }]])
  };
  doInst.normalizeSecrets();
  const json = JSON.stringify({ ...doInst.room, participants: [...doInst.room.participants.values()] });
  assert.ok(!json.includes(HOST) && !json.includes(P1));
  assert.ok(doInst.room.hostTokenHash && doInst.room.franchises.CSK.ownerTokenHash);
});

for (const c of [host, c1, c2, c3]) c.close();
await sleep(50);
await mf.dispose();
process.exit(await t.finish() ? 1 : 0);
