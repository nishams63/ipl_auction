// Input validation for client-supplied identity fields.

// Private session tokens: long, URL-safe, opaque. Client-generated tokens
// (`usr_<timestamp>_<random>` legacy, `usr_<32 hex>` current) both pass.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

// Room codes are 6 chars from an unambiguous alphabet; accept any case on input
const ROOM_RE = /^[A-Za-z0-9]{4,12}$/;
export function isValidRoomCode(code) {
  return typeof code === 'string' && ROOM_RE.test(code);
}

// Display names: trimmed, 1–30 chars, no control characters
export function cleanName(name) {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (n.length < 1 || n.length > 30) return null;
  return n;
}
