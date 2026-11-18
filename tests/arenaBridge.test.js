// Stage 4 — Unity arena bridge (display only).
// What this suite verifies WITHOUT a browser or a Unity build:
//   A. toArenaState(): the snapshot sent to Unity is public, bounded and complete
//   B. ArenaController lifecycle with FAKE window/document/Unity instance (simulated):
//      unsupported WebGL, missing build, loader failure, Unity error event, timeout,
//      queue-until-ready, dedupe, quality, idle shutdown, re-attach, destroy idempotence
//   C. Static guarantees: Unity code/jslib has no network, no bid/purse/timer capability;
//      React passes only `room` to the arena; only built-in Unity modules; no new npm deps
//   D. Event sync against a REAL server: snapshots built from the server's room state follow
//      new lot, bid, SOLD, UNSOLD, pause/resume and completion
// Real WebGL rendering is NOT verified here (the WebGL module/build is not available).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunner, startServer, connect, emit, createRoom, strongToken, tempStorageFile, findPrivateData, waitFor, sleep } from './helpers/harness.js';
import { toArenaState, ARENA_PROTOCOL_VERSION } from '../client/src/utils/arenaState.js';
import { ArenaController, ARENA_FILES } from '../client/src/utils/arenaController.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
// code only (comments may describe what the code must NOT do)
const code = p => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const t = makeRunner('Stage 4 Unity Arena Bridge Suite (mapping, simulated lifecycle, static checks, real-server sync)');

// ── A. mapping ─────────────────────────────────────────────────────────────
const sampleRoom = () => ({
  roomCode: 'ABC123', status: 'active', hostToken: 'SECRET-HOST', config: { timerDuration: 15 },
  currentLot: {
    lotNumber: 3, totalLots: 250, stateVersion: 7, countdown: 4.6, hammerStatus: 'GOING_TWICE',
    highestBid: 2.4, highestBidderFranchiseId: 'MI', highestBidderName: 'Alice', bidHistory: [{}, {}, {}],
    player: { id: 'PL_001', name: 'Virat Kohli', role: 'Top-order Batter', category: 'BAT', country: 'India', isOverseas: false, basePrice: 2, imageUrl: 'https://x' }
  },
  franchises: {
    CSK: { id: 'CSK', code: 'CSK', name: 'Chennai Super Kings', primaryColor: '#FACC15', secondaryColor: '#1E3A8A', remainingPurse: 118.5, squad: [{ id: 1 }], isClaimed: true, ownerToken: 'tok-csk', ownerSocketId: 'sock-1', ownerId: 'p_1', ownerName: 'Host' },
    MI: { id: 'MI', code: 'MI', name: 'Mumbai Indians', primaryColor: '#004BA0', secondaryColor: '#D1AB3E', remainingPurse: 120, squad: [], isClaimed: true, ownerToken: 'tok-mi', ownerSocketId: 'sock-2' }
  },
  participants: [{ token: 'x' }]
});

await t.it('A1: maps the current lot, bid, bidder, countdown, hammer and franchises', async () => {
  const s = toArenaState(sampleRoom());
  assert.strictEqual(s.v, ARENA_PROTOCOL_VERSION);
  assert.strictEqual(s.status, 'active');
  assert.strictEqual(s.hasLot, true);
  assert.deepStrictEqual(
    { n: s.lot.number, t: s.lot.total, id: s.lot.playerId, name: s.lot.name, role: s.lot.role, base: s.lot.basePrice, bid: s.lot.highestBid, by: s.lot.bidder, c: s.lot.countdown, d: s.lot.timerDuration, h: s.lot.hammer, v: s.lot.version, bids: s.lot.bidCount },
    { n: 3, t: 250, id: 'PL_001', name: 'Virat Kohli', role: 'Top-order Batter', base: 2, bid: 2.4, by: 'MI', c: 5, d: 15, h: 'GOING_TWICE', v: 7, bids: 3 });
  assert.deepStrictEqual(s.franchises.find(f => f.id === 'CSK'), { id: 'CSK', code: 'CSK', name: 'Chennai Super Kings', color: '#FACC15', color2: '#1E3A8A', purse: 118.5, squad: 1, claimed: true });
});

await t.it('A2: the snapshot carries no private data (tokens, socket ids, owner identity, participants)', async () => {
  const s = toArenaState(sampleRoom());
  assert.deepStrictEqual(findPrivateData(s, { secrets: ['SECRET-HOST', 'tok-csk', 'tok-mi', 'sock-1', 'p_1', 'Alice', 'Host'], forbiddenKeys: ['ownerToken', 'hostToken', 'ownerSocketId', 'ownerId', 'participants', 'imageUrl'] }), []);
});

await t.it('A3: robust to missing data (no room, no lot, hostile values) and bounded in size', async () => {
  assert.strictEqual(toArenaState(null), null);
  const s = toArenaState({ status: 'paused', franchises: {} });
  assert.strictEqual(s.hasLot, false);
  assert.strictEqual(s.lot.countdown, 0);
  assert.strictEqual(s.lot.timerDuration, 15);
  const r = sampleRoom();
  r.currentLot.player.name = 'x'.repeat(10000); r.currentLot.countdown = -3; r.currentLot.highestBid = NaN; r.franchises.CSK.primaryColor = { evil: true };
  const h = toArenaState(r);
  assert.strictEqual(h.lot.name.length, 60);
  assert.strictEqual(h.lot.countdown, 0);
  assert.strictEqual(h.lot.highestBid, 0);
  assert.strictEqual(h.franchises[0].color, '');
  assert.ok(JSON.stringify(toArenaState(sampleRoom())).length < 200000, 'Unity rejects payloads over 200000 chars');
});

// ── B. controller lifecycle (simulated browser + Unity) ───────────────────
function fakeEnv({ webgl = true, build = true, html = false, loader = 'ok', unity = 'ok', readyEvent = true, timeoutMs = 2000 } = {}) {
  const listeners = new Map();
  const calls = { sent: [], quits: 0, scripts: 0, created: 0 };
  const win = {
    devicePixelRatio: 2,
    addEventListener: (n, f) => { (listeners.get(n) || listeners.set(n, new Set()).get(n)).add(f); },
    removeEventListener: (n, f) => { listeners.get(n)?.delete(f); },
    dispatch: (n, detail) => { for (const f of [...(listeners.get(n) || [])]) f({ detail }); },
    listenerCount: n => listeners.get(n)?.size || 0
  };
  const instance = {
    SendMessage: (obj, method, value) => { if (unity === 'throwOnSend') throw new Error('dead'); calls.sent.push([obj, method, value]); },
    Quit: () => { calls.quits++; return Promise.resolve(); }
  };
  const doc = {
    createElement: tag => ({ tag, setAttribute() {}, remove() {}, parentNode: null }),
    body: {
      appendChild: s => {
        calls.scripts++;
        setTimeout(() => {
          if (loader === 'error') return s.onerror();
          if (loader !== 'noGlobal') win.createUnityInstance = (canvas, cfg, progress) => {
            calls.created++; calls.cfg = cfg;
            progress(0.5);
            if (unity === 'reject') return Promise.reject(new Error('wasm failed'));
            if (unity === 'hang') return new Promise(() => {});
            if (readyEvent) setTimeout(() => win.dispatch('ipl-arena', { type: 'ready' }), 0);
            return Promise.resolve(instance);
          };
          s.onload();
        }, 1);
      }
    }
  };
  const fetch = async (url, opts) => { calls.head = [url, opts?.method]; if (!build) return { ok: false, headers: { get: () => 'text/plain' } }; return { ok: true, headers: { get: () => (html ? 'text/html' : 'application/javascript') } }; };
  const ctl = new ArenaController({ window: win, document: doc, fetch, detectWebGL: () => webgl, loadTimeoutMs: timeoutMs, idleDestroyMs: 30 });
  const host = { kids: [], appendChild(c) { c.parentNode = this; this.kids.push(c); }, removeChild(c) { c.parentNode = null; this.kids = this.kids.filter(k => k !== c); } };
  return { ctl, win, doc, host, calls };
}
const settle = async (ctl, want, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end && !want.includes(ctl.status)) await sleep(5); return ctl.status; };
const stateWith = (patch = {}) => { const r = sampleRoom(); Object.assign(r.currentLot, patch); return toArenaState(r); };

await t.it('B1: no WebGL → "unsupported", nothing fetched or loaded', async () => {
  const e = fakeEnv({ webgl: false });
  e.ctl.attach(e.host);
  assert.strictEqual(await settle(e.ctl, ['unsupported']), 'unsupported');
  assert.strictEqual(e.calls.head, undefined);
  assert.strictEqual(e.calls.scripts, 0);
});

await t.it('B2: missing build (404, or an SPA index.html fallback) → "unavailable", no script, no listener', async () => {
  for (const opts of [{ build: false }, { html: true }]) {
    const e = fakeEnv(opts);
    e.ctl.attach(e.host);
    assert.strictEqual(await settle(e.ctl, ['unavailable']), 'unavailable');
    assert.deepStrictEqual(e.calls.head, [ARENA_FILES.loaderUrl, 'HEAD']);
    assert.strictEqual(e.calls.scripts, 0);
    assert.strictEqual(e.win.listenerCount('ipl-arena'), 0);
  }
});

await t.it('B3: loader script error / loader without createUnityInstance / wasm rejection → "failed", cleaned up', async () => {
  for (const opts of [{ loader: 'error' }, { loader: 'noGlobal' }, { unity: 'reject' }]) {
    const e = fakeEnv(opts);
    e.ctl.attach(e.host);
    assert.strictEqual(await settle(e.ctl, ['failed']), 'failed', JSON.stringify(opts));
    assert.ok(e.ctl.error);
    assert.strictEqual(e.win.listenerCount('ipl-arena'), 0, 'listener removed after failure');
    assert.strictEqual(e.host.kids.length, 0, 'canvas removed after failure');
  }
});

await t.it('B4: load timeout → "failed" with a timeout message', async () => {
  const e = fakeEnv({ unity: 'hang', timeoutMs: 40 });
  e.ctl.attach(e.host);
  assert.strictEqual(await settle(e.ctl, ['failed']), 'failed');
  assert.match(e.ctl.error, /too long/);
});

await t.it('B5: snapshots pushed while loading are queued (latest only) and delivered once ready; duplicates dropped', async () => {
  const e = fakeEnv();
  e.ctl.push(stateWith({ stateVersion: 1 })); // before attach (idle)
  e.ctl.attach(e.host);
  e.ctl.push(stateWith({ stateVersion: 2 }));
  e.ctl.push(stateWith({ stateVersion: 3 }));
  assert.strictEqual(await settle(e.ctl, ['ready']), 'ready');
  await sleep(10);
  const applied = e.calls.sent.filter(c => c[1] === 'ApplyState');
  assert.strictEqual(applied.length, 1, 'only the newest queued snapshot is delivered');
  assert.strictEqual(JSON.parse(applied[0][2]).lot.version, 3);
  assert.ok(e.calls.sent.every(c => c[0] === 'ArenaBridge' && ['ApplyState', 'SetQuality'].includes(c[1])), 'only display methods are called');
  e.ctl.push(stateWith({ stateVersion: 3 }));
  assert.strictEqual(e.calls.sent.filter(c => c[1] === 'ApplyState').length, 1, 'identical snapshot dropped');
  e.ctl.push(stateWith({ stateVersion: 4 }));
  assert.strictEqual(e.calls.sent.filter(c => c[1] === 'ApplyState').length, 2);
  assert.strictEqual(e.calls.cfg.devicePixelRatio, 1.5, 'pixel ratio capped for weaker GPUs');
});

await t.it('B6: quality changes are forwarded; invalid levels ignored', async () => {
  const e = fakeEnv();
  e.ctl.attach(e.host);
  await settle(e.ctl, ['ready']);
  e.ctl.setQuality('low'); e.ctl.setQuality('ultra');
  const q = e.calls.sent.filter(c => c[1] === 'SetQuality').map(c => c[2]);
  assert.deepStrictEqual(q, ['auto', 'low']);
});

await t.it('B7: a Unity "error" event or a throwing SendMessage → "failed" without throwing into React', async () => {
  const e = fakeEnv();
  e.ctl.attach(e.host); await settle(e.ctl, ['ready']);
  e.win.dispatch('ipl-arena', { type: 'error', message: 'boom' });
  assert.strictEqual(e.ctl.status, 'failed'); assert.strictEqual(e.ctl.error, 'boom'); assert.strictEqual(e.calls.quits, 1);
  const e2 = fakeEnv({ unity: 'throwOnSend' });
  e2.ctl.attach(e2.host); await settle(e2.ctl, ['failed', 'ready']);
  assert.doesNotThrow(() => e2.ctl.push(stateWith({ stateVersion: 9 })));
  assert.strictEqual(e2.ctl.status, 'failed');
});

await t.it('B8: moving between views re-parents the canvas (no reload); leaving shuts Unity down; destroy is idempotent', async () => {
  const e = fakeEnv();
  e.ctl.attach(e.host); await settle(e.ctl, ['ready']);
  const canvas = e.host.kids[0];
  const host2 = { kids: [], appendChild(c) { c.parentNode = this; this.kids.push(c); }, removeChild(c) { c.parentNode = null; this.kids = this.kids.filter(k => k !== c); } };
  e.ctl.detach(e.host); e.ctl.attach(host2);           // live view → results view
  await sleep(60);
  assert.strictEqual(e.ctl.status, 'ready'); assert.strictEqual(host2.kids[0], canvas); assert.strictEqual(e.calls.created, 1); assert.strictEqual(e.calls.scripts, 1);
  e.ctl.detach(host2);                                  // left the room
  await sleep(80);
  assert.strictEqual(e.ctl.status, 'idle'); assert.strictEqual(e.calls.quits, 1); assert.strictEqual(e.win.listenerCount('ipl-arena'), 0);
  e.ctl.destroy(); e.ctl.destroy();
  assert.strictEqual(e.calls.quits, 1, 'Quit called once');
  e.ctl.attach(e.host); await settle(e.ctl, ['ready']);  // coming back reuses the loaded script
  assert.strictEqual(e.calls.scripts, 1); assert.strictEqual(e.calls.created, 2); assert.strictEqual(e.win.listenerCount('ipl-arena'), 1, 'exactly one listener');
  e.ctl.destroy();
});

await t.it('B9: a StrictMode-style attach/detach/attach does not double-load; retry after failure works', async () => {
  const e = fakeEnv();
  e.ctl.attach(e.host); e.ctl.detach(e.host); e.ctl.attach(e.host);
  await settle(e.ctl, ['ready']);
  assert.strictEqual(e.calls.created, 1); assert.strictEqual(e.win.listenerCount('ipl-arena'), 1);
  e.win.dispatch('ipl-arena', { type: 'error', message: 'x' });
  e.ctl.retry(e.host);
  assert.strictEqual(await settle(e.ctl, ['ready']), 'ready');
  assert.strictEqual(e.win.listenerCount('ipl-arena'), 1);
  e.ctl.destroy();
});

// ── C. static guarantees ───────────────────────────────────────────────────
const unityDir = 'unity/IPLAuctionArena';
const csFiles = ['Assets/Scripts', 'Assets/Editor'].flatMap(d => fs.readdirSync(path.join(root, unityDir, d)).filter(f => f.endsWith('.cs')).map(f => `${unityDir}/${d}/${f}`));

await t.it('C1: Unity scripts and jslib contain no network, socket, storage or URL-opening code', async () => {
  const banned = [/UnityWebRequest/, /\bWWW\b/, /https?:\/\//, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\bsocket\b/i, /OpenURL/, /localStorage/, /System\.Net/, /PlayerPrefs/];
  const files = [...csFiles, `${unityDir}/Assets/Plugins/WebGL/ArenaBridge.jslib`];
  assert.ok(csFiles.length >= 8, 'all scripts scanned');
  for (const f of files) for (const re of banned) assert.ok(!re.test(read(f)), `${f} matches ${re}`);
});

await t.it('C2: Unity has no way to act on the auction: jslib only reports ready/error; bridge only accepts ApplyState/SetQuality', async () => {
  const jslib = read(`${unityDir}/Assets/Plugins/WebGL/ArenaBridge.jslib`);
  const fns = [...jslib.matchAll(/^\s*(\w+)\s*:\s*function/gm)].map(m => m[1]).sort();
  assert.deepStrictEqual(fns, ['ArenaNotifyError', 'ArenaNotifyReady']);
  const bridge = code(`${unityDir}/Assets/Scripts/ArenaBridge.cs`);
  const pub = [...bridge.matchAll(/public\s+void\s+(\w+)\s*\(/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(pub, ['ApplyState', 'SetQuality']);
  for (const f of [...csFiles, `${unityDir}/Assets/Plugins/WebGL/ArenaBridge.jslib`]) {
    assert.ok(!/place_?bid|advance_?lot|pause_auction|resume_auction|finish_auction|skip_set|remainingPurse\s*=|SendMessage/i.test(code(f)), `${f} references an auction action`);
  }
});

await t.it('C3: React gives the arena only the room (no callbacks); arena modules never touch the socket', async () => {
  const live = read('client/src/components/LiveAuctionView.jsx');
  const fin = read('client/src/components/FinalResultsView.jsx');
  assert.deepStrictEqual([...live.matchAll(/<UnityArena[^>]*\/>/g)].map(m => m[0]), ['<UnityArena room={room} />']);
  assert.deepStrictEqual([...fin.matchAll(/<UnityArena[^>]*\/>/g)].map(m => m[0]), ['<UnityArena room={room} compact />']);
  for (const f of ['client/src/components/UnityArena.jsx', 'client/src/utils/arenaController.js', 'client/src/utils/arenaState.js']) {
    const src = code(f);
    assert.ok(!/socket|emit\(|onPlaceBid|fetch\(['"`]\/api|anthropic|api[_-]?key/i.test(src.replace(/fetchFn\(ARENA_FILES\.loaderUrl/g, '')), `${f} touches the network/auction`);
  }
});

await t.it('C4: zero-cost dependencies — only built-in Unity modules; no new npm packages', async () => {
  const manifest = JSON.parse(read(`${unityDir}/Packages/manifest.json`));
  for (const name of Object.keys(manifest.dependencies)) assert.match(name, /^com\.unity\.modules\./, `${name} is not a built-in module`);
  assert.ok(!manifest.scopedRegistries, 'no third-party registries');
  const client = JSON.parse(read('client/package.json'));
  assert.deepStrictEqual(Object.keys(client.dependencies).sort(), ['@tailwindcss/vite', 'canvas-confetti', 'lucide-react', 'react', 'react-dom', 'socket.io-client', 'tailwindcss']);
  assert.deepStrictEqual(Object.keys(client.devDependencies).sort(), ['@types/react', '@types/react-dom', '@vitejs/plugin-react', 'oxlint', 'vite']);
  assert.ok(!fs.existsSync(path.join(root, unityDir, 'Assets/Plugins/x86_64')), 'no native plugins');
  assert.strictEqual(read(`${unityDir}/ProjectSettings/ProjectVersion.txt`).split(/\r?\n/)[0].trim(), 'm_EditorVersion: 6000.3.28f1'); // Unity appends a revision line on first open
});

await t.it('C5: WebGL build settings match the loader and avoid known browser failures', async () => {
  const src = code(`${unityDir}/Assets/Editor/ArenaBuild.cs`);
  assert.match(src, /compressionFormat = WebGLCompressionFormat\.Gzip/);
  assert.match(src, /decompressionFallback = true/, '.unityweb names + JS decompression: works on any static host');
  assert.match(src, /nameFilesAsHashes = false/, 'stable names that arenaController.js requests');
  assert.match(src, /dataCaching = false/, 'Unity IndexedDB cache served stale .data after a rebuild');
  assert.match(src, /totalErrors == 0/, 'a build with logged errors is reported as FAILED');
  const builder = code(`${unityDir}/Assets/Scripts/ArenaBuilder.cs`);
  assert.match(builder, /sharedMesh = mesh/, 'primitives are built from meshes: physics is stripped from WebGL');
});

// The generated build is only checked when it exists (it is produced by Unity, not by npm).
const buildDir = path.join(root, 'client/public/unity/arena/Build');
if (fs.existsSync(buildDir)) {
  await t.it('C6: generated WebGL build matches what arenaController.js loads (names, gzip, no IndexedDB cache)', async () => {
    for (const url of Object.values(ARENA_FILES)) {
      const file = path.join(root, 'client/public', url);
      assert.ok(fs.existsSync(file), `missing ${url}`);
      if (url.endsWith('.unityweb')) {
        const head = fs.readFileSync(file).subarray(0, 2);
        assert.deepStrictEqual([...head], [0x1f, 0x8b], `${url} is not gzip`);
      }
    }
    const loader = fs.readFileSync(path.join(buildDir, 'arena.loader.js'), 'utf8');
    assert.ok(loader.includes('createUnityInstance'));
    assert.ok(!/indexedDB/.test(loader), 'loader still uses the IndexedDB data cache'); // a "[UnityCache]" log prefix alone is fine
    const total = fs.readdirSync(buildDir).reduce((n, f) => n + fs.statSync(path.join(buildDir, f)).size, 0);
    assert.ok(total < 15 * 1024 * 1024, `build is ${total} bytes`);
  });
} else {
  console.log('  ⏭  C6 not run: no WebGL build in client/public/unity/arena (not counted as passed)');
}

// ── D. event sync with a real server ──────────────────────────────────────
const srv = await startServer({ storageFile: tempStorageFile('arena') });
const getState = async code => toArenaState(await (await fetch(`${srv.url}/api/rooms/${code}`)).json());

await t.it('D1: snapshots follow a real auction: new lot, bid + leader, SOLD, next lot, UNSOLD, pause/resume, completion', async () => {
  const H = strongToken('h'), A = strongToken('a');
  const c = await createRoom(srv.url, { hostToken: H, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  const code = c.body.roomCode;
  const host = await connect(srv.url), alice = await connect(srv.url);
  assert.ok((await emit(host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H })).success);
  assert.ok((await emit(alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A })).success);
  assert.ok((await emit(host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' })).success);
  assert.ok((await emit(alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' })).success);
  assert.ok((await emit(host, 'start_auction', { roomCode: code })).success);

  const s0 = await getState(code);
  assert.strictEqual(s0.status, 'active'); assert.strictEqual(s0.hasLot, true); assert.strictEqual(s0.lot.number, 1);
  assert.strictEqual(s0.lot.bidder, ''); assert.strictEqual(s0.lot.hammer, 'OPEN'); assert.ok(s0.lot.basePrice > 0);
  assert.strictEqual(s0.franchises.length, 10);
  assert.deepStrictEqual(s0.franchises.filter(f => f.claimed).map(f => f.id).sort(), ['CSK', 'MI']);
  assert.deepStrictEqual(findPrivateData(s0, { secrets: [H, A, 'Alice'], forbiddenKeys: ['ownerToken', 'ownerId', 'ownerSocketId'] }), []);

  const b = await emit(alice, 'place_bid', { roomCode: code, franchiseId: 'MI', expectedVersion: s0.lot.version });
  assert.ok(b.success, JSON.stringify(b));
  const s1 = await getState(code);
  assert.strictEqual(s1.lot.bidder, 'MI'); assert.ok(s1.lot.version > s0.lot.version); assert.strictEqual(s1.lot.highestBid, s0.lot.basePrice); assert.strictEqual(s1.lot.bidCount, 1);

  assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success); // hammer (server decides)
  const s2 = await getState(code);
  assert.strictEqual(s2.lot.hammer, 'SOLD'); assert.strictEqual(s2.lot.playerId, s0.lot.playerId);
  const mi = s2.franchises.find(f => f.id === 'MI');
  assert.strictEqual(mi.squad, 1); assert.strictEqual(+(120 - mi.purse).toFixed(2), s1.lot.highestBid);

  assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success); // next lot
  const s3 = await getState(code);
  assert.strictEqual(s3.lot.number, 2); assert.notStrictEqual(s3.lot.playerId, s0.lot.playerId); assert.strictEqual(s3.lot.hammer, 'OPEN'); assert.strictEqual(s3.lot.bidder, '');

  assert.ok((await emit(host, 'pause_auction', { roomCode: code })).success);
  assert.strictEqual((await getState(code)).status, 'paused');
  assert.ok((await emit(host, 'resume_auction', { roomCode: code })).success);
  assert.strictEqual((await getState(code)).status, 'active');

  assert.ok((await emit(host, 'advance_lot', { roomCode: code })).success); // no bids → UNSOLD
  const s4 = await getState(code);
  assert.strictEqual(s4.lot.hammer, 'UNSOLD'); assert.strictEqual(s4.lot.number, 2);

  const done = waitFor(alice, 'auction_completed');
  assert.ok((await emit(host, 'finish_auction', { roomCode: code })).success);
  const completedRoom = await done;
  assert.strictEqual(toArenaState(completedRoom).status, 'completed');
  assert.strictEqual((await getState(code)).status, 'completed');
  host.close(); alice.close();
});

await t.it('D2: a refresh/reconnect builds the same snapshot from the room the client re-fetches (first-apply is static in Unity)', async () => {
  const H = strongToken('h');
  const c = await createRoom(srv.url, { hostToken: H, config: { minParticipants: 1 } });
  const code = c.body.roomCode;
  const a = await connect(srv.url);
  const j1 = await emit(a, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  a.close();
  const b = await connect(srv.url);
  const j2 = await emit(b, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  assert.ok(j1.success && j2.success);
  assert.deepStrictEqual(toArenaState(j2.room), await getState(code));
  b.close();
});

await srv.stop();
process.exit(await t.finish());
