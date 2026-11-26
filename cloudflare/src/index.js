import { AuctionRoomDO } from './AuctionRoomDO.js';
import { IPL_FRANCHISES } from '../../server/data/franchises.js';
import { cleanName, isValidToken, isValidRoomCode } from '../../server/security.js';
import { tokenHashSecretProblem } from '../../server/persistence/tokenHash.js';

export { AuctionRoomDO };

// Production Origin Allowlist
export const PRODUCTION_ALLOWED_ORIGINS = new Set([
  'https://ipl-auction-omega-nine.vercel.app'
]);

// Allow deployment-specific preview URLs strictly scoped to this Vercel project
const PROJECT_PREVIEW_ORIGIN_RE = /^https:\/\/ipl-auction-[a-z0-9-]+-nishams63s-projects\.vercel\.app$/;

export function isProductionEnv(env = {}) {
  return env?.ENVIRONMENT === 'production' || env?.NODE_ENV === 'production';
}

export function isAuthConfigValid(env = {}) {
  const problem = tokenHashSecretProblem(env);
  if (problem) return false;
  if (isProductionEnv(env) && !env?.TOKEN_HASH_SECRET) return false;
  return true;
}

export function isAllowedOrigin(origin, env = {}) {
  if (!origin) return false;
  const cleanOrigin = origin.replace(/\/+$/, '');

  // 1. Explicit production allowlist & project-scoped Vercel preview URLs
  if (PRODUCTION_ALLOWED_ORIGINS.has(cleanOrigin)) return true;
  if (PROJECT_PREVIEW_ORIGIN_RE.test(cleanOrigin)) return true;

  // 2. Custom production frontend domain(s) passed via env.FRONTEND_URL (comma-separated supported)
  if (env?.FRONTEND_URL) {
    const allowedList = String(env.FRONTEND_URL)
      .split(',')
      .map(s => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    if (allowedList.includes(cleanOrigin)) {
      return true;
    }
  }

  // 3. Localhost development origins allowed ONLY when not in strict production mode
  if (!isProductionEnv(env)) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cleanOrigin)) {
      return true;
    }
  }

  return false;
}

export function getCorsHeaders(request, env = {}) {
  const origin = request?.headers?.get('Origin');
  if (origin && isAllowedOrigin(origin, env)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, X-Host-Token',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    };
  }
  return {
    'Vary': 'Origin'
  };
}

function json(data, status = 200, request = null, env = {}) {
  const origin = request?.headers?.get('Origin');
  if (origin && !isAllowedOrigin(origin, env)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed by CORS policy' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'Vary': 'Origin'
      }
    });
  }

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env)
    }
  });
}

// Best-effort abuse protection for room creation (per Worker isolate; not a global limit).
// Free tier has no paid rate-limiting product, so this caps bursts from one client address.
const CREATE_LIMIT = 10;          // rooms
const CREATE_WINDOW_MS = 60_000;  // per minute per address
const createLog = new Map();
export function allowRoomCreate(ip, now = Date.now()) {
  if (!ip) return true; // no client address (local workerd/dev): nothing meaningful to key on
  const key = ip;
  const recent = (createLog.get(key) || []).filter(t => now - t < CREATE_WINDOW_MS);
  if (recent.length >= CREATE_LIMIT) { createLog.set(key, recent); return false; }
  recent.push(now);
  createLog.set(key, recent);
  if (createLog.size > 5000) createLog.clear(); // bound memory
  return true;
}

const MAX_CREATE_BODY_BYTES = 4096;

function generateRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      if (origin && !isAllowedOrigin(origin, env)) {
        return new Response('CORS Origin Forbidden', { status: 403 });
      }
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }

    // Health Check
    if (url.pathname === '/api/health') {
      return json({
        status: isAuthConfigValid(env) ? 'ok' : 'degraded',
        platform: 'cloudflare-workers-durable-objects',
        environment: isProductionEnv(env) ? 'production' : 'development',
        time: new Date().toISOString(),
        storage: {
          kind: 'cloudflare-durable-objects-sqlite',
          authoritative: true,
          durable: true
        }
      }, 200, request, env);
    }

    // Production auth configuration gate (require 32+ char TOKEN_HASH_SECRET in production)
    if (!isAuthConfigValid(env)) {
      return json({ error: 'Server authentication configuration is incomplete' }, 503, request, env);
    }

    // Official Franchises List
    if (url.pathname === '/api/franchises') {
      return json(IPL_FRANCHISES, 200, request, env);
    }

    // Create Room
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      try {
        if (origin && !isAllowedOrigin(origin, env)) {
          return json({ error: 'Origin not allowed' }, 403, request, env);
        }
        if (!allowRoomCreate(request.headers.get('CF-Connecting-IP'))) {
          return json({ error: 'Too many rooms created from this network. Please wait a minute and try again.' }, 429, request, env);
        }
        const raw = await request.text();
        if (raw.length > MAX_CREATE_BODY_BYTES) {
          return json({ error: 'Request too large' }, 413, request, env);
        }
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'Malformed JSON' }, 400, request, env); }
        const hostName = cleanName(body?.hostName);
        const hostToken = body?.hostToken;
        if (!hostName || !isValidToken(hostToken)) {
          return json({ error: 'A valid hostName and hostToken are required' }, 400, request, env);
        }
        const rawCfg = body?.config && typeof body.config === 'object' && !Array.isArray(body.config) ? { ...body.config } : {};
        if (body?.max_squad_size !== undefined && rawCfg.max_squad_size === undefined && rawCfg.maxSquadSize === undefined) {
          rawCfg.max_squad_size = body.max_squad_size;
        }
        if (body?.maxSquadSize !== undefined && rawCfg.maxSquadSize === undefined && rawCfg.max_squad_size === undefined) {
          rawCfg.maxSquadSize = body.maxSquadSize;
        }
        if (body?.max_overseas_players !== undefined && rawCfg.max_overseas_players === undefined && rawCfg.maxOverseas === undefined) {
          rawCfg.max_overseas_players = body.max_overseas_players;
        }
        if (body?.maxOverseas !== undefined && rawCfg.maxOverseas === undefined && rawCfg.max_overseas_players === undefined) {
          rawCfg.maxOverseas = body.maxOverseas;
        }
        const config = rawCfg;

        // A code collision is refused by the Durable Object (409); retry with a fresh code
        for (let attempt = 0; attempt < 5; attempt++) {
          const roomCode = generateRoomCode();
          const roomDO = env.AUCTION_ROOMS.get(env.AUCTION_ROOMS.idFromName(roomCode));
          const res = await roomDO.fetch(new Request(`https://internal/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomCode, hostName, hostToken, config })
          }));
          if (res.status === 409) continue;
          const result = await res.json();
          return json(result, res.status, request, env);
        }
        return json({ error: 'Could not allocate a room code. Please try again.' }, 503, request, env);
      } catch (err) {
        return json({ error: 'Room creation failed' }, 500, request, env);
      }
    }

    // Helper for WebSocket origin enforcement (strict in production: Origin required & allowlisted)
    const isWsOriginAllowed = () => {
      if (isProductionEnv(env)) {
        return isAllowedOrigin(origin, env);
      }
      return !origin || isAllowedOrigin(origin, env);
    };

    // Room Dispatcher: /api/rooms/:code or /api/rooms/:code/ws or /api/rooms/:code/analysis or /api/rooms/:code/export or /ws/:code
    const wsDirectMatch = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,12})$/);
    if (wsDirectMatch) {
      if (!isWsOriginAllowed()) {
        return new Response('Forbidden WebSocket Origin', { status: 403 });
      }

      const roomCode = wsDirectMatch[1].toUpperCase();
      const id = env.AUCTION_ROOMS.idFromName(roomCode);
      const roomDO = env.AUCTION_ROOMS.get(id);
      return roomDO.fetch(request);
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})(\/ws|\/analysis|\/export)?$/);
    if (roomMatch) {
      const roomCode = roomMatch[1].toUpperCase();
      const subpath = roomMatch[2] || '';
      const id = env.AUCTION_ROOMS.idFromName(roomCode);
      const roomDO = env.AUCTION_ROOMS.get(id);

      // WebSocket Upgrade: /api/rooms/:code/ws
      if (subpath === '/ws' || request.headers.get('Upgrade') === 'websocket') {
        if (!isWsOriginAllowed()) {
          return new Response('Forbidden WebSocket Origin', { status: 403 });
        }
        return roomDO.fetch(request);
      }

      // Analysis: /api/rooms/:code/analysis
      if (subpath === '/analysis') {
        const req = new Request(`https://internal/analysis`, { method: 'GET' });
        const res = await roomDO.fetch(req);
        return json(await res.json(), res.status, request, env);
      }

      // Full State Export / Backup: /api/rooms/:code/export
      if (subpath === '/export') {
        const req = new Request(`https://internal/export${url.search}`, {
          method: 'GET',
          headers: request.headers
        });
        const res = await roomDO.fetch(req);
        return json(await res.json(), res.status, request, env);
      }

      // Public Room State: /api/rooms/:code
      if (request.method === 'GET') {
        const req = new Request(`https://internal/state`, { method: 'GET' });
        const res = await roomDO.fetch(req);
        return json(await res.json(), res.status, request, env);
      }
    }

    return json({ error: 'Not Found' }, 404, request, env);
  }
};
