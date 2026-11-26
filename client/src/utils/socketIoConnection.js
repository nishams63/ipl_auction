// Legacy transport for the Node/Express + Socket.IO server (server/index.js), which still hosts
// the historical interrupted auctions. Enabled only with VITE_USE_SOCKETIO=true. Same surface as
// CloudflareNativeWsAdapter, one instance per room session, and socket.io-client is loaded lazily
// so the default (Cloudflare) bundle does not ship it.

export class SocketIoRoomConnection {
  constructor(url) {
    this.baseUrl = url || (typeof window !== 'undefined' ? window.location.origin : '');
    this.listeners = new Map();
    this.socket = null;
    this.pending = [];
    this.currentRoomCode = null;
    this.disposed = false;
    this.suspended = false;
    this.clockOffsetMs = 0;
    this._loading = null;
  }

  get connected() { return !!this.socket?.connected; }
  get roomCode() { return this.currentRoomCode; }
  now() { return Date.now(); }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
  }
  off(event, fn) {
    if (!event) { this.listeners.clear(); return; }
    if (!fn) { this.listeners.delete(event); return; }
    this.listeners.get(event)?.delete(fn);
  }
  trigger(event, data) {
    for (const fn of Array.from(this.listeners.get(event) || [])) {
      try { fn(data); } catch { console.error(`[socket.io] listener for ${event} failed`); }
    }
  }

  async _ensure() {
    if (this.socket || this.disposed) return;
    if (!this._loading) {
      this._loading = import('socket.io-client').then(({ io }) => {
        if (this.disposed) return;
        const s = io(this.baseUrl, {
          autoConnect: false,
          transports: ['polling', 'websocket'],
          reconnection: true,
          reconnectionAttempts: 15,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          timeout: 20000
        });
        const forward = ['state_updated', 'lot_presented', 'bid_accepted', 'lot_completed', 'timer_tick',
          'auction_completed', 'analysis_updated', 'set_skipped'];
        for (const ev of forward) s.on(ev, (d) => { if (!this.disposed) this.trigger(ev, d); });
        s.on('connect', () => { if (!this.disposed) { this.trigger('connect'); this._flush(); } });
        s.on('disconnect', (reason) => { if (!this.disposed) this.trigger('disconnect', { reason }); });
        s.on('session_replaced', (d) => {
          if (this.disposed) return;
          this.suspended = true;
          s.io.opts.reconnection = false;
          s.disconnect();
          this.trigger('session_replaced', d);
        });
        this.socket = s;
      });
    }
    await this._loading;
  }

  _flush() {
    while (this.pending.length && this.connected) {
      const [ev, payload, cb] = this.pending.shift();
      this.socket.emit(ev, payload, cb);
    }
  }

  connect(roomCode) {
    if (this.disposed) return;
    if (roomCode) {
      this.currentRoomCode = String(roomCode).toUpperCase();
      this.suspended = false;
    }
    this._ensure().then(() => {
      if (this.disposed || !this.socket) return;
      this.socket.io.opts.reconnection = true;
      if (!this.socket.connected) this.socket.connect();
    });
  }

  emit(event, payload = {}, cb) {
    if (this.disposed) { if (cb) cb({ success: false, error: 'Connection closed', code: 'CANCELLED' }); return; }
    const timer = cb ? setTimeout(() => { done({ success: false, error: 'The server did not respond in time.', code: 'TIMEOUT' }); }, 15000) : null;
    let fired = false;
    const done = (res) => { if (fired) return; fired = true; if (timer) clearTimeout(timer); if (cb && !this.disposed) cb(res); };
    if (this.connected) this.socket.emit(event, payload, done);
    else this.pending.push([event, payload, done]);
  }

  disconnect() {
    this.pending = [];
    this.currentRoomCode = null;
    if (this.socket) {
      this.socket.io.opts.reconnection = false;
      this.socket.disconnect();
    }
  }

  dispose() {
    this.disconnect();
    if (this.socket) this.socket.removeAllListeners();
    this.listeners.clear();
    this.disposed = true;
  }
}
