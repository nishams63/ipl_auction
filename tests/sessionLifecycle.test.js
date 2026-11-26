// Regression suite for the P1 "old room comes back" bug and the room-session lifecycle.
// Exercises the real client modules (session store, RoomSessionController, native WS adapter)
// with in-memory storages, a scripted fake connection and a fake WebSocket.
import assert from 'node:assert/strict';
import { makeRunner } from './helpers/harness.js';
import { createSessionStore, STORAGE_KEYS } from '../client/src/utils/session.js';
import { RoomSessionController } from '../client/src/utils/roomSession.js';
import { CloudflareNativeWsAdapter } from '../client/src/utils/wsAdapter.js';
import { applyLotPresented, applyLotCompleted, applyBidAccepted } from '../client/src/utils/roomState.js';

const t = makeRunner('Session lifecycle & old-room restoration regression suite');

const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    dump: () => Object.fromEntries(m)
  };
};

// Scripted connection: join acks are held until the test releases them
class FakeConn {
  constructor(log) { this.log = log; this.listeners = new Map(); this.acks = []; this.disposed = false; this.connected = false; this.room = null; log.push(this); }
  on(e, f) { (this.listeners.get(e) || this.listeners.set(e, new Set()).get(e)).add(f); }
  off() {}
  trigger(e, d) { for (const f of this.listeners.get(e) || []) f(d); }
  connect(code) { this.room = code; this.connected = true; queueMicrotask(() => this.trigger('connect')); }
  emit(ev, payload, cb) { this.acks.push({ ev, payload, cb }); }
  dispose() { this.disposed = true; this.connected = false; this.listeners.clear(); }
  now() { return Date.now(); }
  ackJoin(roomCode, extra = {}) {
    const a = this.acks.find(x => x.ev === 'join_room' && !x.done);
    a.done = true;
    a.cb({ success: true, room: fakeRoom(roomCode), participant: { publicId: 'usr_me', name: a.payload.participantName, isHost: true, franchiseId: null }, ...extra });
  }
  failJoin(error) {
    const a = this.acks.find(x => x.ev === 'join_room' && !x.done);
    a.done = true;
    a.cb({ success: false, error });
  }
}
const fakeRoom = code => ({ roomCode: code, status: 'lobby', franchises: {}, playersCatalog: [], history: [], auditLog: [], config: {} });
const tick = () => new Promise(r => setTimeout(r, 5));

function setup({ local = {}, tab = {}, fetchImpl } = {}) {
  const ls = mem({ ipl_user_name: 'Nisha', ...local });
  const ss = mem(tab);
  const store = createSessionStore(ls, ss);
  const conns = [];
  let codeSeq = 0;
  const c = new RoomSessionController({
    serverUrl: 'http://srv',
    store,
    createConnection: () => new FakeConn(conns),
    fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ roomCode: `ROOM${String.fromCharCode(65 + codeSeq++)}${codeSeq}X` }) }))
  });
  return { ls, ss, store, conns, c };
}

// ── session store ───────────────────────────────────────────
await t.it('a fresh tab has no active room even when another tab/visit used one', () => {
  const ls = mem({ ipl_user_token: 'usr_' + 'a'.repeat(32), ipl_resume_room: JSON.stringify({ code: 'AAAAAA', savedAt: Date.now() }) });
  const store = createSessionStore(ls, mem());
  assert.equal(store.getActiveRoom(), '', 'fresh tab must not be pulled into a room');
  assert.equal(store.getUserSession().lastRoom, 'AAAAAA', 'offered only as an explicit resume');
});

await t.it('legacy ipl_room_code (old auto-rejoin key) becomes a resume offer, never an active room', () => {
  const ls = mem({ ipl_room_code: 'OLDROO' });
  const ss = mem();
  const store = createSessionStore(ls, ss);
  assert.equal(store.getUserSession().lastRoom, 'OLDROO');
  assert.equal(store.getActiveRoom(), '');
  assert.equal(ls.dump().ipl_room_code, undefined, 'legacy key removed');
});

await t.it('leftRoom clears this tab and the resume offer; logout rotates the token', () => {
  const ls = mem(); const ss = mem();
  const store = createSessionStore(ls, ss);
  const tok = store.getUserSession().token;
  store.enteredRoom({ name: 'N', roomCode: 'ROOMAA' });
  assert.equal(store.getActiveRoom(), 'ROOMAA');
  store.leftRoom('ROOMAA');
  assert.equal(store.getActiveRoom(), '');
  assert.equal(store.getUserSession().lastRoom, '');
  store.enteredRoom({ name: 'N', roomCode: 'ROOMBB' });
  const newTok = store.logout();
  assert.notEqual(newTok, tok);
  assert.equal(store.getActiveRoom(), '');
  assert.equal(store.getUserSession().lastRoom, '');
  assert.equal(store.getUserSession().name, '');
});

// ── controller lifecycle ────────────────────────────────────
await t.it('page load with no active room for this tab opens nothing (no connection created)', async () => {
  const { c, conns } = setup({ local: { ipl_resume_room: JSON.stringify({ code: 'ROOMAA', savedAt: Date.now() }) } });
  const restored = await c.restore();
  assert.equal(restored, false);
  assert.equal(conns.length, 0);
  assert.equal(c.getState().phase, 'idle');
});

await t.it('refresh restores the same room and participant for this tab', async () => {
  const { c, conns } = setup({ tab: { [STORAGE_KEYS.active]: 'ROOMAA' } });
  const p = c.restore();
  await tick();
  assert.equal(conns.length, 1);
  assert.equal(conns[0].room, 'ROOMAA');
  assert.equal(conns[0].acks[0].payload.roomCode, 'ROOMAA');
  conns[0].ackJoin('ROOMAA');
  assert.equal(await p, true);
  assert.equal(c.getState().room.roomCode, 'ROOMAA');
  assert.equal(c.getState().participant.publicId, 'usr_me');
});

await t.it('EXACT BUG: leave Room A, create Room B → Room B opens; Room A never comes back', async () => {
  const { c, conns, store } = setup();
  const pa = c.joinRoom({ participantName: 'Nisha', roomCode: 'ROOMAA' });
  await tick(); conns[0].ackJoin('ROOMAA'); await pa;
  c.leave();
  assert.equal(conns[0].disposed, true, 'Room A connection stopped');
  assert.equal(store.getActiveRoom(), '');
  const pb = c.createRoom({ hostName: 'Nisha' });
  await tick(); // POST /api/rooms resolves, then the new connection joins
  const b = conns[1];
  assert.ok(b && b.room !== 'ROOMAA', 'new connection targets the new room');
  const bCode = b.room;
  b.ackJoin(bCode);
  await pb;
  assert.equal(c.getState().room.roomCode, bCode);
  assert.equal(store.getActiveRoom(), bCode);
  // A late reconnect/ack from Room A cannot resurrect it
  conns[0].trigger('state_updated', fakeRoom('ROOMAA'));
  assert.equal(c.getState().room.roomCode, bCode);
});

await t.it('a slow join ack from Room A arriving after the user switched to Room B is ignored', async () => {
  const { c, conns } = setup();
  const pa = c.joinRoom({ participantName: 'Nisha', roomCode: 'ROOMAA' }).catch(e => e);
  await tick();
  const pb = c.joinRoom({ participantName: 'Nisha', roomCode: 'ROOMBB' });
  await tick();
  conns[1].ackJoin('ROOMBB');
  await pb;
  // Room A's ack finally arrives (its callback was captured before the switch)
  conns[0].acks[0].cb({ success: true, room: fakeRoom('ROOMAA'), participant: { publicId: 'x', name: 'N' } });
  await tick();
  assert.equal(c.getState().room.roomCode, 'ROOMBB');
  assert.equal(conns[0].disposed, true);
  const resA = await Promise.race([pa, new Promise(r => setTimeout(() => r('pending'), 20))]);
  assert.ok(resA === 'pending' || resA instanceof Error, 'Room A attempt never resolves as success');
});

await t.it('a slow room-creation response that returns after Leave/cancel does not open a room', async () => {
  let release;
  const fetchImpl = () => new Promise(r => { release = () => r({ ok: true, status: 200, json: async () => ({ roomCode: 'LATEAA' }) }); });
  const { c, conns } = setup({ fetchImpl });
  const p = c.createRoom({ hostName: 'Nisha' }).catch(e => e);
  await tick();
  c.leave(); // user cancels
  release();
  const err = await p;
  assert.ok(err?.cancelled, 'stale create is cancelled');
  assert.equal(conns.length, 0, 'no connection to the late room');
  assert.equal(c.getState().phase, 'idle');
});

await t.it('explicit join by code opens exactly that room even if this tab had another active room', async () => {
  const { c, conns } = setup({ tab: { [STORAGE_KEYS.active]: 'ROOMAA' } });
  const pr = c.restore().catch(() => {});
  await tick();
  const pj = c.joinRoom({ participantName: 'Nisha', roomCode: 'ROOMCC' });
  await tick();
  conns[1].ackJoin('ROOMCC');
  await pj; await pr;
  conns[0].acks[0]?.cb?.({ success: true, room: fakeRoom('ROOMAA'), participant: {} });
  assert.equal(c.getState().room.roomCode, 'ROOMCC');
});

await t.it('restore of a room that no longer exists clears the stale pointer and shows the landing page', async () => {
  const { c, conns, store } = setup({ tab: { [STORAGE_KEYS.active]: 'GONEAA' } });
  const p = c.restore();
  await tick();
  conns[0].failJoin('Auction room not found');
  assert.equal(await p, false);
  assert.equal(store.getActiveRoom(), '');
  assert.equal(conns[0].disposed, true);
  assert.equal(c.getState().phase, 'idle');
  assert.match(c.getState().notice, /GONEAA/);
});

await t.it('logout stops the connection, rotates identity and leaves server data alone (no destructive message)', async () => {
  const { c, conns, store } = setup();
  const before = c.identity.token;
  const p = c.joinRoom({ participantName: 'Nisha', roomCode: 'ROOMAA' });
  await tick(); conns[0].ackJoin('ROOMAA'); await p;
  c.logout();
  assert.equal(conns[0].disposed, true);
  assert.notEqual(c.identity.token, before);
  assert.equal(store.getActiveRoom(), '');
  const sent = conns[0].acks.map(a => a.ev);
  assert.ok(!sent.some(e => /delete|destroy|remove/i.test(e)), 'no destructive server call');
});

await t.it('sign-out in another tab tears down this tab\'s session', async () => {
  const { c, conns, ls } = setup();
  const p = c.joinRoom({ participantName: 'Nisha', roomCode: 'ROOMAA' });
  await tick(); conns[0].ackJoin('ROOMAA'); await p;
  ls.setItem('ipl_user_token', 'usr_' + 'f'.repeat(32));
  c.identityChangedElsewhere();
  assert.equal(conns[0].disposed, true);
  assert.equal(c.getState().phase, 'idle');
});

await t.it('session replaced by another tab pauses this tab; actions are refused until "Use this tab"', async () => {
  const { c, conns } = setup();
  const p = c.joinRoom({ participantName: 'Nisha', roomCode: 'ROOMAA' });
  await tick(); conns[0].ackJoin('ROOMAA'); await p;
  conns[0].trigger('session_replaced', {});
  assert.equal(c.getState().phase, 'replaced');
  let res; c.emit('place_bid', {}, r => { res = r; });
  assert.equal(res.success, false);
  c.takeOver();
  assert.equal(c.getState().phase, 'in_room');
});

await t.it('repeat leave/create/join cycles never return to a previous room', async () => {
  const { c, conns } = setup();
  const visited = [];
  for (let i = 0; i < 5; i++) {
    const code = `CYC${i}AA`;
    const p = c.joinRoom({ participantName: 'Nisha', roomCode: code });
    await tick(); conns.at(-1).ackJoin(code); await p;
    assert.equal(c.getState().room.roomCode, code);
    visited.push(code);
    c.leave();
    assert.equal(c.getState().room, null);
    for (const old of conns.slice(0, -1)) old.trigger('state_updated', fakeRoom(visited[0]));
    assert.equal(c.getState().room, null, 'stale events after leave are ignored');
  }
  assert.ok(conns.every(x => x.disposed));
});

// ── native adapter ──────────────────────────────────────────
class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.all.push(this); }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  serverClose(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  deliver(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}
globalThis.WebSocket = FakeWS;

await t.it('adapter never falls back to a stored/previous room after disconnect', () => {
  FakeWS.all = [];
  globalThis.localStorage = { getItem: () => 'ROOMAA' }; // must be ignored
  const a = new CloudflareNativeWsAdapter('http://x');
  a.connect('ROOMAA');
  a.disconnect();
  a.connect(); // old code reconnected to ROOMAA here
  assert.equal(FakeWS.all.length, 1);
  delete globalThis.localStorage;
});

await t.it('a stale socket closing after a room switch cannot disturb the new socket', async () => {
  FakeWS.all = [];
  const a = new CloudflareNativeWsAdapter('http://x');
  let disconnects = 0;
  a.on('disconnect', () => disconnects++);
  a.connect('ROOMAA'); FakeWS.all[0].open();
  a.connect('ROOMBB'); FakeWS.all[1].open();
  FakeWS.all[0].serverClose();               // late close of Room A's socket
  FakeWS.all[0].deliver({ type: 'STATE_UPDATED', payload: { roomCode: 'ROOMAA' } });
  assert.equal(disconnects, 0);
  assert.equal(a.connected, true);
  assert.equal(a.roomCode, 'ROOMBB');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(FakeWS.all.length, 2, 'no reconnect triggered by the stale socket');
  a.dispose();
});

await t.it('SESSION_REPLACED stops automatic reconnection (no tab ping-pong)', async () => {
  FakeWS.all = [];
  const a = new CloudflareNativeWsAdapter('http://x');
  a.connect('ROOMAA'); FakeWS.all[0].open();
  FakeWS.all[0].deliver({ type: 'SESSION_REPLACED', payload: {} });
  FakeWS.all[0].serverClose(1000);
  await new Promise(r => setTimeout(r, 1600));
  assert.equal(FakeWS.all.length, 1, 'must not reconnect and steal the seat back');
  a.connect('ROOMAA'); // explicit "Use this tab"
  assert.equal(FakeWS.all.length, 2);
  a.dispose();
});

await t.it('unexpected drop reconnects to the SAME room with backoff; pending acks time out cleanly on dispose', async () => {
  FakeWS.all = [];
  const a = new CloudflareNativeWsAdapter('http://x');
  a.connect('ROOMAA'); FakeWS.all[0].open();
  let ack;
  a.emit('place_bid', {}, r => { ack = r; });
  FakeWS.all[0].serverClose(1006);
  await new Promise(r => setTimeout(r, 1400));
  assert.equal(FakeWS.all.length, 2);
  assert.match(FakeWS.all[1].url, /ROOMAA/);
  a.dispose();
  assert.equal(ack.success, false);
});

// ── delta reducers (bandwidth hardening keeps state consistent) ─────
await t.it('lean LOT_PRESENTED / LOT_COMPLETED / BID_ACCEPTED deltas keep catalogue, franchises and purse consistent', () => {
  const room = {
    roomCode: 'R1', status: 'active', currentPlayerIndex: 0,
    playersCatalog: [{ id: 'P1', status: 'in_auction' }, { id: 'P2', status: 'available' }],
    franchises: { CSK: { id: 'CSK', remainingPurse: 120, squad: [] }, MI: { id: 'MI', remainingPurse: 120, squad: [] } },
    currentLot: { lotNumber: 1, stateVersion: 1, player: { id: 'P1' } }, history: []
  };
  let r = applyBidAccepted(room, { bid: { amount: 2 }, currentLot: { lotNumber: 1, stateVersion: 2, highestBid: 2, player: { id: 'P1' } } });
  assert.equal(r.currentLot.highestBid, 2);
  assert.equal(r.franchises, room.franchises, 'franchises untouched by a bid');
  const stale = applyBidAccepted(r, { bid: {}, currentLot: { lotNumber: 1, stateVersion: 1, player: { id: 'P1' } } });
  assert.equal(stale, r, 'older stateVersion ignored');
  r = applyLotCompleted(r, {
    result: 'SOLD', lot: { lotNumber: 1, player: { id: 'P1' }, highestBid: 2, hammerStatus: 'SOLD' },
    historyEntry: { lotNumber: 1, player: { id: 'P1' }, status: 'SOLD' },
    franchiseUpdates: { CSK: { id: 'CSK', remainingPurse: 118, squad: [{ id: 'P1' }] } },
    playerUpdate: { id: 'P1', status: 'sold', soldTo: 'CSK', soldPrice: 2 }
  });
  assert.equal(r.franchises.CSK.remainingPurse, 118);
  assert.equal(r.franchises.MI.remainingPurse, 120);
  assert.equal(r.playersCatalog[0].status, 'sold');
  r = applyLotPresented(r, { partial: true, roomCode: 'R1', status: 'active', currentPlayerIndex: 1, currentLot: { lotNumber: 2, stateVersion: 1, player: { id: 'P2' } } });
  assert.equal(r.currentLot.lotNumber, 2);
  assert.equal(r.playersCatalog[1].status, 'in_auction');
  assert.equal(r.playersCatalog.length, 2);
  assert.equal(applyLotPresented(r, { partial: true, roomCode: 'OTHER', currentLot: { lotNumber: 3 } }), r, 'cross-room delta ignored');
});

process.exit(await t.finish() ? 1 : 0);
