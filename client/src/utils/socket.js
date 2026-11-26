import { CloudflareNativeWsAdapter } from './wsAdapter.js';
import { SocketIoRoomConnection } from './socketIoConnection.js';
import { createSessionStore } from './session.js';

// Backend origin, no trailing slash. Empty = same origin (local proxy / reverse proxy).
export const SERVER_URL = String(import.meta.env.VITE_SERVER_URL || (
  typeof window !== 'undefined' && window.location.hostname === 'localhost' && window.location.port === '5173'
    ? 'http://localhost:4000'
    : ''
)).replace(/\/+$/, '');

// Native WebSocket (Cloudflare Durable Objects) is the default. Socket.IO is only for the legacy
// Node server that hosts historical auctions (explicit opt-in, or a Render backend URL).
export const USE_SOCKETIO = import.meta.env.VITE_USE_SOCKETIO === 'true' || SERVER_URL.includes('onrender.com');

// A NEW connection object per room session: nothing (listeners, queues, timers, acks) is ever
// shared between two rooms.
export function createRoomConnection() {
  return USE_SOCKETIO ? new SocketIoRoomConnection(SERVER_URL) : new CloudflareNativeWsAdapter(SERVER_URL);
}

const safeStorage = (name) => {
  try { return typeof window !== 'undefined' ? window[name] : null; } catch { return null; }
};

export const sessionStore = createSessionStore(safeStorage('localStorage'), safeStorage('sessionStorage'));
