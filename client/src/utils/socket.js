import { io } from 'socket.io-client';

const SOCKET_URL = window.location.hostname === 'localhost' && window.location.port === '5173'
  ? 'http://localhost:4000'
  : '/';

export const socket = io(SOCKET_URL, {
  autoConnect: true,
  transports: ['websocket', 'polling']
});

export function getUserSession() {
  let token = localStorage.getItem('ipl_user_token');
  if (!token) {
    token = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    localStorage.setItem('ipl_user_token', token);
  }
  const name = localStorage.getItem('ipl_user_name') || '';
  const lastRoom = localStorage.getItem('ipl_room_code') || '';
  return { token, name, lastRoom };
}

export function saveUserSession({ name, roomCode }) {
  if (name) localStorage.setItem('ipl_user_name', name);
  if (roomCode) localStorage.setItem('ipl_room_code', roomCode);
}
