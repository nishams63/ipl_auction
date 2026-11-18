// Browser session identity (private token + display name + last room).
// Pure module (storage and crypto injected) so it can be unit-tested outside the browser.

// Old clients generated: 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)
export const LEGACY_TOKEN_RE = /^usr_\d+_[a-z0-9]{0,8}$/;

// 128-bit random private token. It identifies this browser to the server and is never
// broadcast to other players; treat it like a password.
export function generateToken(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return 'usr_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function createSessionStore(storage, cryptoImpl = globalThis.crypto) {
  return {
    getUserSession() {
      let token = storage.getItem('ipl_user_token');
      const lastRoom = storage.getItem('ipl_room_code') || '';
      // Upgrade weak legacy tokens, but only when not mid-room, so an existing player
      // can still reconnect to their room with the token the server knows them by.
      if (!token || (LEGACY_TOKEN_RE.test(token) && !lastRoom)) {
        token = generateToken(cryptoImpl);
        storage.setItem('ipl_user_token', token);
      }
      const name = storage.getItem('ipl_user_name') || '';
      return { token, name, lastRoom };
    },
    saveUserSession({ name, roomCode }) {
      if (name) storage.setItem('ipl_user_name', name);
      if (roomCode) storage.setItem('ipl_room_code', roomCode);
    }
  };
}
