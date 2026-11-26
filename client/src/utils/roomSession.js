// Room session controller: the single client-side source of truth for "which room is this tab
// in, as whom, over which connection". React subscribes to it (see useRoomSession.js); it has no
// React dependency so it can be unit-tested with a fake connection.
//
// Race protection: every enter/leave starts a new *generation*. Each room attempt gets its own
// connection object and AbortController; every callback checks that its generation is still
// current before touching state. A late response from Room A therefore cannot overwrite Room B.

import {
  applyStateSnapshot, applyLotPresented, applyBidAccepted, applyLotCompleted, applySetSkipped, applyTimerTick,
  findMyFranchiseId, activityForEvent, activityFromAudit, activityItem
} from './roomState.js';
import { normalizeRoomCode } from './session.js';

const JOIN_TIMEOUT_MS = 15000;
const MAX_ACTIVITY = 40;

export const IDLE_STATE = Object.freeze({
  phase: 'idle',          // idle | restoring | entering | in_room | replaced
  roomCode: null,
  room: null,
  participant: null,
  link: 'offline',        // online | reconnecting | offline
  activity: [],
  lastLot: null,          // last SOLD/UNSOLD event (for the hammer overlay)
  notice: null            // one-line message for the landing page
});

export class RoomSessionController {
  constructor({ serverUrl = '', store, createConnection, fetchImpl = (...a) => globalThis.fetch(...a), onSound = null }) {
    this.serverUrl = serverUrl;
    this.store = store;
    this.createConnection = createConnection;
    this.fetchImpl = fetchImpl;
    this.onSound = onSound || (() => {});
    this.gen = 0;
    this.conn = null;
    this.abort = null;
    this.state = { ...IDLE_STATE };
    this.subs = new Set();
    this.identity = store.getUserSession();
  }

  // ── subscription ───────────────────────────────────────────
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  getState() { return this.state; }
  _set(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    for (const fn of Array.from(this.subs)) { try { fn(this.state); } catch { /* ignore */ } }
  }

  // ── generation management ──────────────────────────────────
  _teardown() {
    this.gen += 1;
    if (this.abort) { try { this.abort.abort(); } catch { /* ignore */ } }
    this.abort = null;
    if (this.conn) { try { this.conn.dispose(); } catch { /* ignore */ } }
    this.conn = null;
    return this.gen;
  }
  isCurrent(g) { return g === this.gen; }

  // ── lifecycle ──────────────────────────────────────────────
  // On page load: re-enter ONLY the room this tab was in (sessionStorage). Never another tab's
  // room, never a room from a previous visit (that is offered as an explicit "Resume" button).
  async restore() {
    const code = this.store.getActiveRoom();
    if (!code || !this.identity.name) return false;
    const g = this._teardown();
    this._set({ ...IDLE_STATE, phase: 'restoring', roomCode: code });
    try {
      await this._enter(g, code, this.identity.name);
      return true;
    } catch (err) {
      if (!this.isCurrent(g)) return false;
      this._teardown();
      this.store.forgetRoom(code);
      this._set({ ...IDLE_STATE, notice: `Could not restore room ${code}: ${err.message}` });
      return false;
    }
  }

  async createRoom({ hostName, maxSquadSize, maxOverseas }) {
    const name = String(hostName || '').trim();
    const g = this._teardown();
    this._set({ ...IDLE_STATE, phase: 'entering' });
    const controller = new AbortController();
    this.abort = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    const configPayload = { basePurse: 120 };
    if (maxSquadSize !== undefined && maxSquadSize !== null) {
      const sq = Number(maxSquadSize);
      configPayload.maxSquadSize = sq;
      configPayload.max_squad_size = sq;
    }
    if (maxOverseas !== undefined && maxOverseas !== null) {
      const os = Number(maxOverseas);
      configPayload.maxOverseas = os;
      configPayload.max_overseas_players = os;
    }
    let res;
    try {
      res = await this.fetchImpl(`${this.serverUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          hostName: name,
          hostToken: this.identity.token,
          ...(configPayload.max_squad_size !== undefined ? { max_squad_size: configPayload.max_squad_size } : {}),
          ...(configPayload.max_overseas_players !== undefined ? { max_overseas_players: configPayload.max_overseas_players } : {}),
          config: configPayload
        })
      });
    } catch {
      if (!this.isCurrent(g)) throw cancelled();
      this._set({ ...IDLE_STATE });
      throw new Error(controller.signal.aborted
        ? 'The server took too long to respond. Please try again.'
        : 'Unable to reach the auction server. Check your internet connection and try again.');
    } finally {
      clearTimeout(timer);
    }
    if (!this.isCurrent(g)) throw cancelled();
    const data = await res.json().catch(() => ({}));
    if (!this.isCurrent(g)) throw cancelled();
    if (!res.ok || !normalizeRoomCode(data.roomCode)) {
      this._set({ ...IDLE_STATE });
      throw new Error(data.errors?.join('\n') || data.error || `Server error (${res.status})`);
    }
    return this._enterOrReset(g, data.roomCode, name);
  }

  async joinRoom({ participantName, roomCode }) {
    const code = normalizeRoomCode(roomCode);
    const name = String(participantName || '').trim();
    if (!code) throw new Error('Please enter a valid room code');
    const g = this._teardown();
    this._set({ ...IDLE_STATE, phase: 'entering', roomCode: code });
    return this._enterOrReset(g, code, name);
  }

  async _enterOrReset(g, code, name) {
    try {
      return await this._enter(g, code, name);
    } catch (err) {
      if (this.isCurrent(g)) {
        this._teardown();
        this._set({ ...IDLE_STATE });
      }
      throw err;
    }
  }

  _enter(g, roomCode, name) {
    const code = normalizeRoomCode(roomCode);
    const conn = this.createConnection();
    this.conn = conn;
    const token = this.identity.token;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new Error('Could not connect to the room. The server may be waking up; please retry.'));
      }, JOIN_TIMEOUT_MS);

      const guard = (fn) => (data) => { if (this.isCurrent(g) && this.conn === conn) fn(data); };

      const join = () => {
        conn.emit('join_room', { roomCode: code, participantName: name, participantToken: token }, guard((res) => {
          if (res?.success) {
            const firstJoin = !settled;
            this.store.enteredRoom({ name, roomCode: code });
            this.identity = { ...this.identity, name };
            const room = res.room;
            this._set((s) => ({
              phase: 'in_room',
              roomCode: code,
              room,
              participant: { ...res.participant, franchiseId: findMyFranchiseId(room, res.participant) },
              link: 'online',
              notice: null,
              activity: firstJoin ? activityFromAudit(room?.auditLog) : s.activity
            }));
            finish(null, { room, participant: res.participant });
          } else if (!settled) {
            finish(new Error(res?.error || 'Could not join room'));
          } else if (res?.code !== 'CANCELLED' && res?.code !== 'TIMEOUT') {
            // Rejoin after a reconnect was refused (room gone, etc.): leave cleanly
            this.leave({ notice: `You were disconnected from room ${code}: ${res?.error || 'rejoin refused'}` });
          }
        }));
      };

      conn.on('connect', guard(() => join()));
      conn.on('disconnect', guard(() => this._set({ link: 'reconnecting' })));
      conn.on('reconnecting', guard(() => this._set({ link: 'reconnecting' })));
      conn.on('session_replaced', guard(() => this._set({ phase: 'replaced', link: 'offline' })));

      conn.on('state_updated', guard((snap) => this._applyRoom('state_updated', snap, applyStateSnapshot)));
      conn.on('lot_presented', guard((snap) => {
        this._applyRoom('lot_presented', snap, applyLotPresented);
        this._set({ lastLot: null });
        this.onSound('gavel');
      }));
      conn.on('bid_accepted', guard((d) => { this._applyRoom('bid_accepted', d, applyBidAccepted); this.onSound('bid'); }));
      conn.on('lot_completed', guard((d) => {
        this._applyRoom('lot_completed', d, applyLotCompleted);
        this._set({ lastLot: d });
        this.onSound(d?.result === 'SOLD' ? 'sold' : 'unsold');
      }));
      conn.on('set_skipped', guard((d) => this._applyRoom('set_skipped', d, applySetSkipped)));
      conn.on('auction_completed', guard((snap) => this._applyRoom('auction_completed', snap, applyStateSnapshot)));
      conn.on('analysis_updated', guard((snap) => this._applyRoom('analysis_updated', snap, applyStateSnapshot)));
      conn.on('timer_tick', guard((t) => {
        const next = applyTimerTick(this.state.room, t);
        if (next !== this.state.room) this._set({ room: next });
      }));

      conn.connect(code);
    });
  }

  _applyRoom(event, data, reducer) {
    const prev = this.state.room;
    const next = reducer(prev, data);
    if (next === prev) return;
    const item = activityForEvent(event, data, prev);
    const participant = this.state.participant
      ? { ...this.state.participant, franchiseId: findMyFranchiseId(next, this.state.participant) }
      : null;
    this._set((s) => ({
      room: next,
      participant,
      activity: item ? [item, ...s.activity].slice(0, MAX_ACTIVITY) : s.activity
    }));
  }

  addActivity(kind, text) {
    this._set((s) => ({ activity: [activityItem(kind, text), ...s.activity].slice(0, MAX_ACTIVITY) }));
  }

  // "Use this tab" after another tab took over the same seat
  takeOver() {
    if (this.state.phase !== 'replaced' || !this.conn || !this.state.roomCode) return;
    this._set({ phase: 'in_room', link: 'reconnecting' });
    this.conn.connect(this.state.roomCode);
  }

  // Explicit leave. Server-side room, franchise ownership and auction data are untouched; the
  // player can come back with the room code (same device token = same franchise).
  leave({ notice = null } = {}) {
    const code = this.state.roomCode;
    const conn = this.conn;
    if (conn?.connected && this.state.phase === 'in_room') {
      try { conn.emit('leave_room', {}); } catch { /* best effort */ }
    }
    this._teardown();
    if (code) this.store.leftRoom(code);
    this._set({ ...IDLE_STATE, notice });
  }

  // Logout: leave, then forget this device's identity (new token, no name, no resume offer)
  logout() {
    this.leave();
    this.store.logout();
    this.identity = this.store.getUserSession();
    this._set({ ...IDLE_STATE, notice: 'You have signed out on this device.' });
  }

  // Another tab signed out (token changed in localStorage)
  identityChangedElsewhere() {
    const fresh = this.store.getUserSession();
    if (fresh.token === this.identity.token) return;
    this._teardown();
    this.identity = fresh;
    this._set({ ...IDLE_STATE, notice: 'You signed out in another tab.' });
  }

  // ── actions (server validates everything; tokens are never sent with actions) ─────
  emit(event, payload = {}, cb) {
    const done = typeof cb === 'function' ? cb : () => {};
    if (this.state.phase !== 'in_room' || !this.conn) {
      done({ success: false, error: this.state.phase === 'replaced' ? 'This room is open in another tab.' : 'Not connected to a room' });
      return;
    }
    const g = this.gen;
    const conn = this.conn;
    conn.emit(event, { ...payload, roomCode: this.state.roomCode }, (res) => {
      if (this.isCurrent(g) && this.conn === conn) done(res);
    });
  }

  now() { return this.conn?.now ? this.conn.now() : Date.now(); }
}

function cancelled() {
  const e = new Error('Cancelled');
  e.cancelled = true;
  return e;
}
