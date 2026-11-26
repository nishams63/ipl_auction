// Shared harness for real-browser E2E tests.
// Starts the real Cloudflare Worker + Durable Object (SQLite) in local workerd via Miniflare,
// serves the production React build (client/dist), proxies /api HTTP + WebSocket upgrades to
// workerd (same-origin, like a production reverse proxy), and launches headless Chrome.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Miniflare } from 'miniflare';
import esbuild from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const distDir = path.join(root, 'client', 'dist');

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

export function bundleWorker() {
  const build = esbuild.buildSync({
    entryPoints: [path.join(root, 'cloudflare', 'src', 'index.js')],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    external: ['node:*', 'cloudflare:*']
  });
  return build.outputFiles[0].text;
}

// persistDir: when set, Durable Object SQLite is persisted on disk so a "Worker restart"
// (dispose + new Miniflare on the same dir) can be tested.
export async function startWorker({ persistDir = null, bindings = {} } = {}) {
  const mf = new Miniflare({
    modules: true,
    script: bundleWorker(),
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { ENVIRONMENT: 'development', ...bindings },
    durableObjects: { AUCTION_ROOMS: { className: 'AuctionRoomDO', useSQLite: true } },
    ...(persistDir ? { durableObjectsPersist: persistDir } : {})
  });
  const origin = (await mf.ready).origin;
  return { mf, origin, port: Number(new URL(origin).port) };
}

// Front server: static dist + /api proxy. `target` is mutable so the worker can be restarted
// behind a stable frontend URL. `wsDelayMs` (optional function) delays proxied WS bytes.
export async function startFrontend(target) {
  const state = { target, sockets: new Set() };
  const app = express();
  app.all('/api/*', async (req, res) => {
    try {
      const init = { method: req.method, headers: { ...req.headers, host: '127.0.0.1:' + state.target.port } };
      delete init.headers['content-length'];
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        init.body = Buffer.concat(chunks);
      }
      const r = await fetch(state.target.origin + req.originalUrl, init);
      res.status(r.status);
      for (const [k, v] of r.headers) {
        if (!['transfer-encoding', 'content-length', 'content-encoding'].includes(k.toLowerCase())) res.setHeader(k, v);
      }
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      res.status(502).json({ error: 'upstream unavailable' });
    }
  });
  app.use(express.static(distDir));
  app.get('*', (_q, res) => res.sendFile(path.join(distDir, 'index.html')));
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(state.target.port, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    state.sockets.add(socket);
    const drop = () => { state.sockets.delete(socket); socket.destroy(); up.destroy(); };
    up.on('error', drop); socket.on('error', drop); up.on('close', drop); socket.on('close', drop);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    setTarget(t) { state.target = t; },
    // Simulate a network drop for every open WebSocket (server keeps running)
    dropAllSockets() { for (const s of [...state.sockets]) s.destroy(); },
    close: () => new Promise(r => { for (const s of state.sockets) s.destroy(); server.close(() => r()); })
  };
}

export async function launchChrome() {
  const executablePath = findChrome();
  if (!executablePath) return null;
  return chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--mute-audio', '--no-sandbox']
  });
}

export function trackErrors(page, sink, label) {
  page.on('pageerror', e => sink.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') sink.push(`[${label}] console.error: ${m.text()}`); });
}
