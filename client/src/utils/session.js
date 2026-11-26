// Browser session identity and room memory.
// Pure module (storages and crypto injected) so it can be unit-tested outside the browser.
//
// What is stored where (see docs/SESSION_LIFECYCLE.md):
//   localStorage   ipl_user_token   private device token (identifies this browser to the server;
//                                   never broadcast; treat like a password)
//   localStorage   ipl_user_name    display-name preference
//   localStorage   ipl_resume_room  {code, savedAt}: offered as an explicit "Resume room" button on
//                                   the landing page only. It NEVER opens a room by itself.
//   sessionStorage ipl_active_room  the room THIS TAB is in. Survives refresh of this tab only, so
//                                   another tab or a later visit can never be pulled into it.
//
// Legacy key ipl_room_code (older builds auto-rejoined it on every load) is migrated into
// ipl_resume_room and removed.

export const LEGACY_TOKEN_RE = /^usr_\d+_[a-z0-9]{0,8}$/;
export const ROOM_CODE_RE = /^[A-Z0-9]{4,12}$/;
export const RESUME_TTL_MS = 24 * 60 * 60 * 1000;

const K = {
  token: 'ipl_user_token',
  name: 'ipl_user_name',
  resume: 'ipl_resume_room',
  legacyRoom: 'ipl_room_code',
  active: 'ipl_active_room'
};
export const STORAGE_KEYS = K;

// 128-bit random private token.
export function generateToken(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return 'usr_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeRoomCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return ROOM_CODE_RE.test(c) ? c : '';
}

const safe = {
  get(s, k) { try { return s?.getItem(k) ?? null; } catch { return null; } },
  set(s, k, v) { try { s?.setItem(k, v); } catch { /* storage blocked/full */ } },
  del(s, k) { try { if (typeof s?.removeItem === 'function') s.removeItem(k); else s?.setItem(k, ''); } catch { /* ignore */ } }
};

export function createSessionStore(storage, tabStorage = null, cryptoImpl = globalThis.crypto, now = () => Date.now()) {
  const readResume = () => {
    const raw = safe.get(storage, K.resume);
    if (raw) {
      try {
        const v = JSON.parse(raw);
        const code = normalizeRoomCode(v?.code);
        if (code && (!v.savedAt || now() - v.savedAt < RESUME_TTL_MS)) return code;
      } catch { /* corrupt */ }
      safe.del(storage, K.resume);
    }
    // Migrate the legacy auto-rejoin key into an explicit resume offer
    const legacy = normalizeRoomCode(safe.get(storage, K.legacyRoom));
    if (legacy) {
      safe.set(storage, K.resume, JSON.stringify({ code: legacy, savedAt: now() }));
      safe.del(storage, K.legacyRoom);
      return legacy;
    }
    return '';
  };

  return {
    getUserSession() {
      const lastRoom = readResume();
      let token = safe.get(storage, K.token);
      // Upgrade weak legacy tokens, but only when there is no room to resume, so an existing
      // player can still reconnect to their room with the token the server knows them by.
      if (!token || (LEGACY_TOKEN_RE.test(token) && !lastRoom)) {
        token = generateToken(cryptoImpl);
        safe.set(storage, K.token, token);
      }
      const name = safe.get(storage, K.name) || '';
      return { token, name, lastRoom };
    },

    // Room this tab is in (refresh restores it); '' when none
    getActiveRoom() {
      return normalizeRoomCode(safe.get(tabStorage, K.active));
    },

    // Called only after the server confirmed the join
    enteredRoom({ name, roomCode }) {
      const code = normalizeRoomCode(roomCode);
      if (name) safe.set(storage, K.name, name);
      if (!code) return;
      safe.set(tabStorage, K.active, code);
      safe.set(storage, K.resume, JSON.stringify({ code, savedAt: now() }));
    },

    // Explicit leave: this tab is no longer in a room and nothing will reopen it automatically
    leftRoom(roomCode) {
      const code = normalizeRoomCode(roomCode);
      const active = normalizeRoomCode(safe.get(tabStorage, K.active));
      if (!code || active === code) safe.del(tabStorage, K.active);
      const resume = readResume();
      if (!code || resume === code) safe.del(storage, K.resume);
      safe.del(storage, K.legacyRoom);
    },

    // Room disappeared / join refused during restore: drop the stale pointer silently
    forgetRoom(roomCode) {
      this.leftRoom(roomCode);
    },

    // Logout: forget the identity on this device. Server-side rooms/history are untouched.
    logout() {
      safe.del(tabStorage, K.active);
      safe.del(storage, K.resume);
      safe.del(storage, K.legacyRoom);
      safe.del(storage, K.name);
      const token = generateToken(cryptoImpl);
      safe.set(storage, K.token, token);
      return token;
    },

    // Back-compat (older callers/tests)
    saveUserSession({ name, roomCode }) {
      this.enteredRoom({ name, roomCode });
    }
  };
}
