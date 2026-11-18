// One-way hashing of private session tokens for storage.
//
// The database never sees a raw token. In memory, a participant restored from PostgreSQL is
// keyed by HASH_PREFIX + hash until its owner reconnects with the raw token (joinRoom then
// re-keys it). HASH_PREFIX contains ':' which the token validator never accepts, so a client
// can never present a hash key as if it were a token.
//
// Scheme:
//  - TOKEN_HASH_SECRET set   → HMAC-SHA256(secret, token)        scheme "hmac-sha256-v1"
//  - otherwise               → SHA-256("ipl-auction-token:v1:" + token)  scheme "sha256-v1"
// The scheme is recorded in storage_meta; the server refuses to start if it changes, because
// existing hashes could no longer be matched (participants could not reconnect).
import crypto from 'node:crypto';

export const HASH_PREFIX = 'hash:';

export function tokenHashScheme(env = process.env) {
  return env.TOKEN_HASH_SECRET ? 'hmac-sha256-v1' : 'sha256-v1';
}

export function hashToken(token, env = process.env) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('hashToken: token must be a non-empty string');
  const secret = env.TOKEN_HASH_SECRET;
  if (secret) return crypto.createHmac('sha256', secret).update(token).digest('hex');
  return crypto.createHash('sha256').update(`ipl-auction-token:v1:${token}`).digest('hex');
}

export const MIN_SECRET_LENGTH = 32;

/** Validate TOKEN_HASH_SECRET when set. Returns an error message, or null when acceptable. */
export function tokenHashSecretProblem(env = process.env) {
  const s = env.TOKEN_HASH_SECRET;
  if (s === undefined || s === '') return null;
  if (s.length < MIN_SECRET_LENGTH) return `TOKEN_HASH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")`;
  if (s.trim() !== s) return 'TOKEN_HASH_SECRET must not start or end with whitespace';
  return null;
}

// Verifier stored in the database to detect a changed secret value (never the secret itself)
export function tokenHashVerifier(env = process.env) {
  return hashToken('ipl-auction:token-hash-check:v1', env);
}

export const isHashKey = k => typeof k === 'string' && k.startsWith(HASH_PREFIX) && /^[0-9a-f]{64}$/.test(k.slice(HASH_PREFIX.length));

// Hash for a value that is either a raw token or an in-memory hash key
export function tokenHashOf(keyOrToken, env = process.env) {
  if (keyOrToken === null || keyOrToken === undefined) return null;
  if (isHashKey(keyOrToken)) return keyOrToken.slice(HASH_PREFIX.length);
  return hashToken(String(keyOrToken), env);
}

export const hashKeyOf = (keyOrToken, env = process.env) => {
  const h = tokenHashOf(keyOrToken, env);
  return h ? HASH_PREFIX + h : null;
};
