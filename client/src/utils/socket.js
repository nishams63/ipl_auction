import { io } from 'socket.io-client';
import { createSessionStore } from './session.js';

export const SERVER_URL = import.meta.env.VITE_SERVER_URL || (
  typeof window !== 'undefined' && window.location.hostname === 'localhost' && window.location.port === '5173'
    ? 'http://localhost:4000'
    : ''
);

export const socket = io(SERVER_URL || (typeof window !== 'undefined' ? window.location.origin : ''), {
  autoConnect: true,
  transports: ['polling', 'websocket'],
  reconnection: true,
  reconnectionAttempts: 15,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000
});

// Session identity lives in ./session.js (pure, unit-tested in tests/compatibility.test.js)
const store = createSessionStore(localStorage);
export const getUserSession = () => store.getUserSession();
export const saveUserSession = (args) => store.saveUserSession(args);
