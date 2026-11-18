// Owns the (optional) Unity WebGL arena. Display only: the only call into Unity is
// SendMessage('ArenaBridge', 'ApplyState' | 'SetQuality', string). Unity can only tell us
// "ready" or "error" through a window 'ipl-arena' event. Bids, timer, purses, order and
// SOLD/UNSOLD stay entirely in the server + existing React controls.
//
// One controller instance per page (getArena()). The canvas is owned here, so moving
// between the live view and the results view re-parents it instead of reloading Unity.
// If nothing shows it for IDLE_DESTROY_MS (left the room), Unity is shut down to free memory.

export const ARENA_BASE = '/unity/arena/Build';
export const ARENA_FILES = {
  loaderUrl: `${ARENA_BASE}/arena.loader.js`,
  // Gzip + "decompression fallback" builds use the .unityweb extension and decompress in JS,
  // so plain static hosting (Vite dev server, Vercel) works without Content-Encoding rules.
  dataUrl: `${ARENA_BASE}/arena.data.unityweb`,
  frameworkUrl: `${ARENA_BASE}/arena.framework.js.unityweb`,
  codeUrl: `${ARENA_BASE}/arena.wasm.unityweb`
};
const LOAD_TIMEOUT_MS = 60000;
const IDLE_DESTROY_MS = 8000;

export function detectWebGL(doc = globalThis.document) {
  try {
    const c = doc.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

export class ArenaController {
  constructor(env = {}) {
    this.win = env.window ?? globalThis.window;
    this.doc = env.document ?? globalThis.document;
    this.fetchFn = env.fetch ?? ((...a) => globalThis.fetch(...a));
    this.webgl = env.detectWebGL ?? (() => detectWebGL(this.doc));
    this.loadTimeoutMs = env.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    this.idleDestroyMs = env.idleDestroyMs ?? IDLE_DESTROY_MS;
    this.status = 'idle'; // idle | unsupported | unavailable | loading | ready | failed
    this.error = null;
    this.progress = 0;
    this.instance = null;
    this.canvas = null;
    this.pending = null;   // latest JSON waiting for "ready"
    this.lastSent = null;  // last JSON delivered (dedupe)
    this.quality = 'auto';
    this.subscribers = new Set();
    this.owner = null;
    this.idleTimer = null;
    this.generation = 0;
    this.sent = 0;
    this.onArenaEvent = (e) => this.handleEvent(e?.detail);
  }

  subscribe(fn) { this.subscribers.add(fn); fn(this.snapshot()); return () => this.subscribers.delete(fn); }
  snapshot() { return { status: this.status, error: this.error, progress: this.progress, quality: this.quality }; }
  setStatus(status, error = null) {
    this.status = status; this.error = error;
    for (const fn of this.subscribers) { try { fn(this.snapshot()); } catch { /* subscriber errors must not break the arena */ } }
  }

  // Called by the component when it mounts a host element. Starts loading on first use.
  attach(host) {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    this.owner = host;
    if (this.canvas && host && this.canvas.parentNode !== host) host.appendChild(this.canvas);
    if (this.status === 'idle') this.start(host);
  }

  detach(host) {
    if (this.owner !== host) return;
    this.owner = null;
    if (this.canvas?.parentNode === host) host.removeChild(this.canvas);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.owner) this.destroy(); }, this.idleDestroyMs);
  }

  async start(host) {
    if (!this.webgl()) return this.setStatus('unsupported', 'WebGL is not available in this browser.');
    const gen = ++this.generation;
    this.setStatus('loading');
    let present = false;
    try {
      const res = await this.fetchFn(ARENA_FILES.loaderUrl, { method: 'HEAD', cache: 'no-store' });
      const type = res?.headers?.get?.('content-type') || '';
      present = !!res?.ok && !type.includes('text/html'); // SPA fallbacks answer HTML for missing files
    } catch { present = false; }
    if (gen !== this.generation) return;
    if (!present) return this.setStatus('unavailable', 'The 3D arena has not been built for this deployment.');

    this.win.addEventListener('ipl-arena', this.onArenaEvent);
    const canvas = this.doc.createElement('canvas');
    canvas.id = 'ipl-arena-canvas';
    canvas.className = 'w-full h-full block';
    canvas.setAttribute('aria-label', 'Animated 3D auction hall (display only)');
    canvas.tabIndex = -1;
    this.canvas = canvas;
    (this.owner || host)?.appendChild(canvas);

    try {
      await this.loadScript(ARENA_FILES.loaderUrl);
      if (gen !== this.generation) return;
      if (typeof this.win.createUnityInstance !== 'function') throw new Error('Unity loader did not initialise.');
      const instance = await this.withTimeout(this.win.createUnityInstance(canvas, {
        ...ARENA_FILES,
        streamingAssetsUrl: '/unity/arena/StreamingAssets',
        companyName: 'IPL Auction', productName: 'IPL Arena', productVersion: '1',
        matchWebGLToCanvasSize: true,
        devicePixelRatio: Math.min(this.win.devicePixelRatio || 1, 1.5)
      }, (p) => { this.progress = p; this.setStatus('loading'); }), this.loadTimeoutMs);
      if (gen !== this.generation) { try { await instance.Quit(); } catch { /* ignore */ } return; }
      this.instance = instance;
      // Unity signals readiness itself (ArenaNotifyReady from Start()); this covers a
      // build where Start ran before the listener existed.
      if (this.status === 'loading') this.markReady();
    } catch (err) {
      if (gen !== this.generation) return;
      this.fail(err?.message || String(err));
    }
  }

  withTimeout(promise, ms) {
    let t;
    return Promise.race([
      Promise.resolve(promise).finally(() => clearTimeout(t)),
      new Promise((_, reject) => { t = setTimeout(() => reject(new Error('The 3D arena took too long to load.')), ms); })
    ]);
  }

  loadScript(src) {
    if (this.win.__iplArenaLoader) return this.win.__iplArenaLoader;
    this.win.__iplArenaLoader = new Promise((resolve, reject) => {
      const s = this.doc.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { this.win.__iplArenaLoader = null; s.remove?.(); reject(new Error('Could not load the 3D arena loader.')); };
      this.doc.body.appendChild(s);
    });
    return this.win.__iplArenaLoader;
  }

  handleEvent(detail) {
    if (!detail || typeof detail !== 'object') return;
    if (detail.type === 'ready') this.markReady();
    else if (detail.type === 'error') this.fail(String(detail.message || 'Unity reported an error.').slice(0, 300));
  }

  markReady() {
    // Needs the instance: an early "ready" event before createUnityInstance resolves is
    // covered by the markReady() call that follows the resolution.
    if (this.status === 'ready' || !this.instance) return;
    this.setStatus('ready');
    this.sendRaw('SetQuality', this.quality);
    if (this.pending) { const json = this.pending; this.pending = null; this.deliver(json); }
  }

  fail(message) {
    this.setStatus('failed', message);
    this.teardown();
  }

  sendRaw(method, value) {
    if (!this.instance || this.status !== 'ready') return false;
    try { this.instance.SendMessage('ArenaBridge', method, value); return true; }
    catch (err) { this.fail('Unity stopped responding: ' + (err?.message || err)); return false; }
  }

  deliver(json) {
    if (this.sendRaw('ApplyState', json)) { this.lastSent = json; this.sent++; }
  }

  // Push the latest display snapshot. Identical snapshots are dropped; before "ready"
  // only the newest one is kept (Unity needs the present, not the history).
  push(state) {
    if (!state) return;
    const json = JSON.stringify(state);
    if (json === this.lastSent || json === this.pending) return;
    if (this.status === 'ready') this.deliver(json);
    else if (this.status === 'loading' || this.status === 'idle') this.pending = json;
  }

  setQuality(level) {
    if (!['auto', 'low', 'high'].includes(level)) return;
    this.quality = level;
    this.sendRaw('SetQuality', level);
    this.setStatus(this.status, this.error);
  }

  teardown() {
    this.generation++;
    clearTimeout(this.idleTimer); this.idleTimer = null;
    this.win?.removeEventListener?.('ipl-arena', this.onArenaEvent);
    const inst = this.instance; this.instance = null;
    if (inst) { try { const r = inst.Quit(); r?.catch?.(() => {}); } catch { /* already gone */ } }
    if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null; this.pending = null; this.lastSent = null;
  }

  destroy() {
    this.teardown();
    this.progress = 0;
    this.setStatus('idle');
  }

  // Lets the user retry after a failure.
  retry(host) {
    this.teardown();
    this.setStatus('idle');
    this.attach(host ?? this.owner);
  }
}

let shared = null;
export function getArena() {
  if (!shared) shared = new ArenaController();
  return shared;
}
