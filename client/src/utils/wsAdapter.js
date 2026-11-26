// Native WebSocket client for one auction room on the Cloudflare Durable Object backend.
//
// Socket.IO-like surface: .on(event, fn) / .off(event, [fn]) / .emit(event, payload, [ack])
// / .connected / .connect(roomCode) / .disconnect() / .dispose().
//
// Session-safety rules (see docs/SESSION_LIFECYCLE.md):
//  * The adapter never reads browser storage. It only ever connects to the room it was
//    explicitly given; there is no "last room" fallback.
//  * Every WebSocket instance gets its own handlers that ignore events once that socket is no
//    longer the current one, so a late message/close from Room A can never touch Room B.
//  * disconnect() forgets the room, cancels reconnection and fails pending acks.
//  * After the server reports SESSION_REPLACED (the same player opened the room in another tab),
//    automatic reconnection stops until connect(roomCode) is called explicitly again. This stops
//    two tabs from stealing the session from each other forever.

const ROOM_CODE_RE = /^[A-Z0-9]{4,12}$/;
const ACK_TIMEOUT_MS = 15000;
const MAX_QUEUE = 50;

export class CloudflareNativeWsAdapter {
  constructor(url) {
    this.baseUrl = (url || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/+$/, '');
    this.ws = null;
    this.listeners = new Map();
    this.pendingAcks = new Map();
    this.ackTimers = new Map();
    this.currentRoomCode = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.pingTimer = null;
    this.localTimerInterval = null;
    this.currentLotState = null;
    this.outboundQueue = [];
    this._socketId = null;
    this.manualClose = false;
    this.suspended = false; // set by SESSION_REPLACED
    this.disposed = false;
    this.clockOffsetMs = 0; // serverNow - clientNow (best estimate)
    this._offsetSamples = [];
  }

  get id() {
    if (!this._socketId) {
      this._socketId = 'ws_' + Math.random().toString(36).substring(2, 10);
    }
    return this._socketId;
  }

  get connected() {
    return !!(this.ws && this.ws.readyState === 1 /* OPEN */);
  }

  get roomCode() {
    return this.currentRoomCode;
  }

  // Server time estimate, used for the countdown so a wrong device clock cannot skew the timer
  now() {
    return Date.now() + this.clockOffsetMs;
  }

  connect(roomCode) {
    if (this.disposed) return;
    const explicit = roomCode ? String(roomCode).trim().toUpperCase() : null;
    const targetCode = explicit || this.currentRoomCode;
    if (!targetCode || !ROOM_CODE_RE.test(targetCode)) return;
    if (explicit) this.suspended = false; // explicit request ("Use this tab") resumes

    if (this.ws) {
      if (this.currentRoomCode === targetCode && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
        return;
      }
      this._closeSocket();
    }
    if (this.currentRoomCode && this.currentRoomCode !== targetCode) {
      // Switching rooms on one adapter: nothing queued/pending for the old room may leak across
      this._failPending('Switched to another room');
      this.outboundQueue = [];
    }

    this.currentRoomCode = targetCode;
    this.manualClose = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const isHttps = this.baseUrl.startsWith('https:');
    const protocol = isHttps ? 'wss:' : 'ws:';
    const host = this.baseUrl.replace(/^https?:\/\//, '');
    const wsUrl = host
      ? `${protocol}//${host}/api/rooms/${targetCode}/ws`
      : `/api/rooms/${targetCode}/ws`;

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      console.error('[ws] connection failed');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const isCurrent = () => this.ws === ws && !this.disposed;

    ws.onopen = () => {
      if (!isCurrent()) return;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.trigger('connect');
      this.flushOutboundQueue();
    };

    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      this.handleMessage(event.data);
    };

    ws.onclose = (ev) => {
      if (!isCurrent()) return; // a stale socket closing must not disturb the current one
      this.ws = null;
      this.stopHeartbeat();
      this.stopLocalCountdown();
      this.trigger('disconnect', { code: ev?.code, reason: ev?.reason });
      if (!this.manualClose && !this.suspended) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; nothing sensitive is logged
    };
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.timestamp || msg.serverTime) this._sampleClock(msg.serverTime || msg.timestamp);

    if (msg.type === 'ACK') {
      if (msg.id && this.pendingAcks.has(msg.id)) {
        const cb = this.pendingAcks.get(msg.id);
        this._clearAck(msg.id);
        const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
        if (msg.success) cb({ success: true, ...payload });
        else cb({ success: false, error: msg.error || 'Operation failed', code: msg.code, errors: msg.errors });
      }
      return;
    }
    if (msg.type === 'PONG') return;
    if (msg.type === 'ERROR') {
      if (msg.id && this.pendingAcks.has(msg.id)) {
        const cb = this.pendingAcks.get(msg.id);
        this._clearAck(msg.id);
        cb({ success: false, error: msg.error || 'Request rejected' });
      }
      this.trigger('server_error', { error: msg.error });
      return;
    }

    if (msg.type === 'SESSION_REPLACED') {
      this.suspended = true;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Drive the local countdown from the authoritative deadline
    if (msg.type === 'LOT_PRESENTED' || msg.type === 'BID_ACCEPTED' || msg.type === 'STATE_UPDATED') {
      const p = msg.payload || {};
      const status = p.status || p.room?.status;
      const lot = p.currentLot || p.room?.currentLot;
      const deadline = p.deadlineEpochMs || lot?.deadlineEpochMs;
      if (status === 'paused' || status === 'completed') this.stopLocalCountdown();
      else if (lot && deadline) this.syncLocalCountdown(deadline, lot);
    } else if (msg.type === 'LOT_COMPLETED' || msg.type === 'AUCTION_COMPLETED') {
      this.stopLocalCountdown();
    }

    this.trigger(msg.type.toLowerCase(), msg.payload);
  }

  _sampleClock(ts) {
    const serverMs = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(serverMs)) return;
    // serverMs = clientNow + offset - latency, so the largest recent sample is the best estimate
    this._offsetSamples.push(serverMs - Date.now());
    if (this._offsetSamples.length > 8) this._offsetSamples.shift();
    const best = Math.max(...this._offsetSamples);
    // Ignore sub-second noise on correctly-synchronised clocks
    this.clockOffsetMs = Math.abs(best) < 750 ? 0 : best;
  }

  _closeSocket() {
    const ws = this.ws;
    this.ws = null; // detach first: its handlers now see themselves as stale
    this.stopHeartbeat();
    this.stopLocalCountdown();
    if (ws) {
      try { ws.close(1000, 'client closed'); } catch { /* ignore */ }
    }
  }

  _clearAck(id) {
    this.pendingAcks.delete(id);
    const t = this.ackTimers.get(id);
    if (t) clearTimeout(t);
    this.ackTimers.delete(id);
  }

  _failPending(reason) {
    const cbs = Array.from(this.pendingAcks.entries());
    for (const [id] of cbs) this._clearAck(id);
    for (const [, cb] of cbs) {
      try { cb({ success: false, error: reason, code: 'CANCELLED' }); } catch { /* ignore */ }
    }
  }

  // Leave the room: no reconnection, nothing queued, the room is forgotten
  disconnect() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._closeSocket();
    this.outboundQueue = [];
    this._failPending('Disconnected');
    this.currentRoomCode = null;
    this.suspended = false;
  }

  // Permanently retire this adapter (used when a room session ends)
  dispose() {
    this.disconnect();
    this.listeners.clear();
    this.disposed = true;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.connected) {
        try { this.ws.send(JSON.stringify({ type: 'PING' })); } catch { /* ignore */ }
      }
    }, 25000);
  }

  stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  scheduleReconnect() {
    if (this.manualClose || this.suspended || this.disposed || !this.currentRoomCode) return;
    clearTimeout(this.reconnectTimer);
    const attempt = this.reconnectAttempts++;
    const base = Math.min(10000, 1000 * Math.pow(2, attempt));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    const room = this.currentRoomCode;
    this.trigger('reconnecting', { attempt: attempt + 1, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose && !this.suspended && !this.disposed && this.currentRoomCode === room) {
        this.connect();
      }
    }, delay);
  }

  syncLocalCountdown(deadlineEpochMs, lot) {
    this.stopLocalCountdown();
    this.currentLotState = { ...lot, deadlineEpochMs };

    const tick = () => {
      const remainingMs = Math.max(0, deadlineEpochMs - this.now());
      const countdown = Math.ceil(remainingMs / 1000);
      let hammerStatus = this.currentLotState.hammerStatus || 'OPEN';
      if (hammerStatus === 'OPEN' && countdown <= 3) {
        hammerStatus = countdown <= 1 ? 'GOING_TWICE' : 'GOING_ONCE';
      }
      this.trigger('timer_tick', {
        countdown,
        hammerStatus,
        stateVersion: this.currentLotState.stateVersion,
        lotNumber: this.currentLotState.lotNumber || this.currentLotState.number
      });
      if (remainingMs <= 0) this.stopLocalCountdown();
    };

    tick();
    this.localTimerInterval = setInterval(tick, 250);
  }

  stopLocalCountdown() {
    if (this.localTimerInterval) {
      clearInterval(this.localTimerInterval);
      this.localTimerInterval = null;
    }
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
  }

  off(event, handler) {
    if (!event) {
      this.listeners.clear();
      return;
    }
    if (!handler) {
      this.listeners.delete(event);
      return;
    }
    this.listeners.get(event)?.delete(handler);
  }

  trigger(event, data) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const fn of Array.from(handlers)) {
      try {
        fn(data);
      } catch {
        console.error(`[ws] listener for ${event} failed`);
      }
    }
  }

  flushOutboundQueue() {
    while (this.outboundQueue.length > 0 && this.connected) {
      const packet = this.outboundQueue.shift();
      try {
        this.ws.send(packet);
      } catch {
        this.outboundQueue.unshift(packet);
        break;
      }
    }
  }

  emit(event, payload = {}, callback = null) {
    if (this.disposed) {
      if (typeof callback === 'function') callback({ success: false, error: 'Connection closed', code: 'CANCELLED' });
      return;
    }
    const msgId = 'msg_' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
    if (typeof callback === 'function') {
      this.pendingAcks.set(msgId, callback);
      this.ackTimers.set(msgId, setTimeout(() => {
        if (!this.pendingAcks.has(msgId)) return;
        const cb = this.pendingAcks.get(msgId);
        this._clearAck(msgId);
        cb({ success: false, error: 'The server did not respond in time. Check your connection and try again.', code: 'TIMEOUT' });
      }, ACK_TIMEOUT_MS));
    }

    if (event === 'join_room' && payload.roomCode) {
      const targetRoom = String(payload.roomCode).trim().toUpperCase();
      if (!this.connected || this.currentRoomCode !== targetRoom) {
        this.connect(targetRoom);
      }
    }

    const packet = JSON.stringify({ id: msgId, type: String(event).toUpperCase(), payload });
    if (this.connected) {
      try {
        this.ws.send(packet);
        return;
      } catch { /* fall through to queue */ }
    }
    if (this.outboundQueue.length >= MAX_QUEUE) this.outboundQueue.shift();
    this.outboundQueue.push(packet);
  }
}
