// In-Memory Authoritative Room Manager for Real-Time IPL Auction
//
// ⚠ PERSISTENCE STATUS: TEMPORARY JSON FILE, NOT DURABLE IN PRODUCTION.
// Rooms are written to a local JSON file. On Render's free plan the filesystem is
// ephemeral, so every deploy, restart or spin-down DELETES this file and all rooms.
// This only protects against in-process restarts on a machine with a persistent disk
// (e.g. local development). The approved durable store is Neon PostgreSQL; see
// docs/PERSISTENT_STORAGE_MIGRATION_PLAN.md (not implemented, awaiting approval).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { IPL_FRANCHISES } from './data/franchises.js';
import {
  DEFAULT_CONFIG,
  calculateDynamicPurse,
  calculateNextBid,
  validateBid,
  isLotOpen,
  checkFinancialElimination,
  reserveFloorLakh,
  evaluateFranchiseSquad,
  rankFranchises
} from './auctionEngine.js';
import { validateConfig, ConfigValidationError, FIXED_RULES } from './config.js';
import { stableStringify } from './persistence/roomMapper.js';
import { toLakh, fromLakh } from './money.js';
import { evaluateAuction } from './analysis/evaluation.js';
import { aiConfig, generateAiAnalysis } from './analysis/aiAnalysis.js';
import { hashKeyOf, isHashKey } from './persistence/tokenHash.js';

/**
 * Players a franchise has PURCHASED, from authoritative server state (shared by live lineup
 * validation and legacy cleanup so the two can never disagree).
 * Source of truth: franchise.squad (written only when a lot is SOLD, see closeCurrentLot).
 * Each entry must also match the catalogue's sale record (status 'sold', soldTo this
 * franchise), so a corrupted or hand-edited squad entry can't make a player eligible.
 * Read-only: never modifies the saved squad.
 */
export function getOwnedPlayers(room, franchiseId) {
  const owned = new Map();
  const franchise = room?.franchises?.[franchiseId];
  if (!franchise) return owned;
  const catalogById = new Map((room.playersCatalog || []).map(p => [p.id, p]));
  for (const p of franchise.squad || []) {
    const sale = catalogById.get(p?.id);
    if (sale && sale.status === 'sold' && sale.soldTo === franchiseId) owned.set(p.id, p);
  }
  return owned;
}

const ROOM_STATUSES = ['lobby', 'active', 'paused', 'completed'];
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Structural check for a room read from disk. Returns a problem description, or null if the
 * room has the shape the server relies on. It does NOT repair anything: a room that fails is
 * quarantined (kept verbatim on disk, not loaded) for manual recovery.
 */
export function findRoomShapeProblem(r) {
  if (!isPlainObject(r)) return 'room is not an object';
  if (!ROOM_STATUSES.includes(r.status)) return `invalid status ${JSON.stringify(r.status)}`;
  if (!isPlainObject(r.config)) return 'config is missing or not an object';
  if (!isPlainObject(r.franchises)) return 'franchises is missing or not an object';
  for (const [fid, f] of Object.entries(r.franchises)) {
    if (!isPlainObject(f)) return `franchise ${fid} is not an object`;
    if (!Array.isArray(f.squad)) return `franchise ${fid} squad is not a list`;
  }
  if (!Array.isArray(r.playersCatalog)) return 'playersCatalog is not a list';
  for (const key of ['history', 'allBids', 'auditLog']) {
    if (!Array.isArray(r[key])) return `${key} is not a list`;
  }
  if (r.participants !== undefined && !Array.isArray(r.participants)) return 'participants is not a list';
  const seenTokens = new Set();
  for (const entry of r.participants || []) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !isPlainObject(entry[1])) return 'participants contains an invalid entry';
    // Two entries for one token would silently collapse into one participant
    if (seenTokens.has(entry[0])) return 'participants contains the same session token twice';
    seenTokens.add(entry[0]);
  }
  if (r.currentLot !== null && r.currentLot !== undefined && !isPlainObject(r.currentLot)) return 'currentLot is not an object';
  if (r.playingXIConfigurations !== undefined && !isPlainObject(r.playingXIConfigurations)) return 'playingXIConfigurations is not an object';
  return null;
}

const LINEUP_FIELDS = ['playingXI', 'captainId', 'viceCaptainId', 'wicketKeeperId', 'impactPlayerId', 'isConfirmed'];

// Clean one lineup record (franchise fields or a playingXIConfigurations entry).
// Returns a NEW object with only lineup fields; never touches the input.
function cleanLineupRecord(rec, owned) {
  const removed = [];
  const xi = [];
  const seen = new Set();
  for (const id of Array.isArray(rec.playingXI) ? rec.playingXI : []) {
    if (typeof id !== 'string') { removed.push({ id: String(id), reason: 'invalid id' }); continue; }
    if (seen.has(id)) { removed.push({ id, reason: 'duplicate' }); continue; }
    if (!owned.has(id)) { removed.push({ id, reason: 'not purchased by this franchise' }); continue; }
    if (xi.length >= 11) { removed.push({ id, reason: 'more than 11 players' }); continue; }
    seen.add(id);
    xi.push(id);
  }
  const cleared = [];
  const keep = (field, ok) => {
    const v = rec[field] ?? null;
    if (v === null) return null;
    if (ok(v)) return v;
    cleared.push(field);
    return null;
  };
  const captainId = keep('captainId', v => xi.includes(v));
  const viceCaptainId = keep('viceCaptainId', v => xi.includes(v) && v !== captainId);
  const impactPlayerId = keep('impactPlayerId', v => owned.has(v) && !xi.includes(v));
  // The designated keeper must be a WK in the XI. If it isn't, use the same automatic rule
  // updatePlayingXI applies (first WK in the XI, else none) - no player is added to the XI.
  let wicketKeeperId = rec.wicketKeeperId ?? null;
  if (wicketKeeperId !== null && !(xi.includes(wicketKeeperId) && owned.get(wicketKeeperId)?.category === 'WK')) {
    cleared.push('wicketKeeperId');
    wicketKeeperId = xi.find(id => owned.get(id).category === 'WK') || null;
  }
  const changed = removed.length > 0 || cleared.length > 0 ||
    !Array.isArray(rec.playingXI) && rec.playingXI !== undefined;
  // A lineup that had to be changed is no longer the one its owner confirmed
  const isConfirmed = changed ? false : rec.isConfirmed;
  return { cleaned: { playingXI: xi, captainId, viceCaptainId, wicketKeeperId, impactPlayerId, isConfirmed }, removed, cleared, changed };
}

/**
 * Legacy Playing XI cleanup for a restored room (pure: returns a plan, mutates nothing).
 * Removes lineup entries the franchise does not own (per getOwnedPlayers), duplicates, and
 * captain / vice-captain / impact / keeper designations that are no longer eligible.
 * Never touches squads, purses, sale records, bids, history, config or participants, and
 * never adds players. Cross-franchise duplicates cannot survive: a catalogue sale record
 * names exactly one franchise, so a player can be "owned" by at most one lineup.
 */
export function planLegacyLineupCleanup(room) {
  const plan = { changed: false, franchises: {} };
  for (const fid of Object.keys(room.franchises || {})) {
    const owned = getOwnedPlayers(room, fid);
    const targets = { franchise: room.franchises[fid] };
    if (room.playingXIConfigurations?.[fid]) targets.config = room.playingXIConfigurations[fid];
    for (const [where, rec] of Object.entries(targets)) {
      const hasLineup = LINEUP_FIELDS.some(f => rec[f] !== undefined && rec[f] !== null && !(Array.isArray(rec[f]) && rec[f].length === 0) && f !== 'isConfirmed');
      if (!hasLineup) continue;
      const r = cleanLineupRecord(rec, owned);
      if (r.changed) {
        plan.changed = true;
        (plan.franchises[fid] ||= {})[where] = r;
      }
    }
  }
  return plan;
}

// Single, consistent authorization error for Playing XI changes
export const PLAYING_XI_FORBIDDEN = 'Only the owner of this franchise can update its Playing XI';

// Fields on a franchise that must never leave the server
const PRIVATE_FRANCHISE_FIELDS = ['ownerToken', 'ownerSocketId'];

export function newPublicId() {
  return 'p_' + crypto.randomBytes(6).toString('hex');
}

export function toPublicFranchise(f) {
  if (!f) return f;
  const copy = { ...f };
  for (const k of PRIVATE_FRANCHISE_FIELDS) delete copy[k];
  return copy;
}

export function toPublicFranchises(franchises = {}) {
  const out = {};
  for (const [id, f] of Object.entries(franchises)) out[id] = toPublicFranchise(f);
  return out;
}

// What a participant may see about themselves. No token: the client already holds its
// own, and no server payload should ever contain one.
export function toSelfParticipant(p) {
  if (!p) return p;
  return { publicId: p.publicId, name: p.name, franchiseId: p.franchiseId, isHost: !!p.isHost };
}

// ── restore helpers shared by the JSON loader, the PostgreSQL store and the JSON importer ──

// Append one audit entry. seq is a per-room, never-reused sequence number (the database keeps
// every entry by seq; memory keeps the newest 200).
export function appendAuditEntry(room, type, message) {
  if (!Array.isArray(room.auditLog)) room.auditLog = [];
  const seq = (Number.isInteger(room.auditSeq) ? room.auditSeq : 0) + 1;
  room.auditSeq = seq;
  room.auditLog.unshift({ seq, timestamp: new Date().toISOString(), type, message });
  if (room.auditLog.length > 200) room.auditLog.pop();
}

// Rooms saved before audit sequence numbers existed: number the entries oldest-first
export function backfillAuditSeq(room) {
  if (!Array.isArray(room.auditLog)) return;
  let max = Number.isInteger(room.auditSeq) ? room.auditSeq : 0;
  for (const e of room.auditLog) if (isPlainObject(e) && Number.isInteger(e.seq) && e.seq > max) max = e.seq;
  for (let i = room.auditLog.length - 1; i >= 0; i--) {
    const e = room.auditLog[i];
    if (isPlainObject(e) && !Number.isInteger(e.seq)) e.seq = ++max;
  }
  room.auditSeq = max;
}

const FINAL_PLAYER_STATUSES = ['sold', 'unsold', 'SKIPPED'];

/**
 * Shuffle the room's catalogue copy WITHIN each player set (contiguous runs of the same
 * categorySet), keeping the set order, then renumber the per-room lot fields (overallLot,
 * lotInSet) to the new order. Uses crypto.randomInt. Called once, when the auction starts; the
 * resulting order is part of the persisted room and never regenerated.
 * The catalogue file itself is never touched (each room has its own copy).
 */
export function shuffleWithinSets(catalog, randomInt = crypto.randomInt) {
  const key = p => (p && (p.categorySet || p.setName)) || null;
  let i = 0;
  while (i < catalog.length) {
    const k = key(catalog[i]);
    let j = i + 1;
    while (j < catalog.length && key(catalog[j]) === k) j++;
    if (k !== null) {
      for (let a = j - 1; a > i; a--) {
        const b = i + randomInt(a - i + 1);
        [catalog[a], catalog[b]] = [catalog[b], catalog[a]];
      }
    }
    i = j;
  }
  const inSet = new Map();
  catalog.forEach((p, idx) => {
    if (!p) return;
    p.overallLot = idx + 1;
    const k = key(p);
    if (k !== null) {
      inSet.set(k, (inSet.get(k) || 0) + 1);
      p.lotInSet = inSet.get(k);
    }
  });
  return catalog;
}

/**
 * After a JSON restore, currentLot.player and history[].player are separate COPIES of catalogue
 * entries (JSON cannot express shared objects). Live, they are the catalogue objects
 * themselves; closing a restored lot would otherwise update only the copy, leaving the
 * catalogue sale record unset (breaking ownership checks for that player).
 * Re-link each copy to its catalogue entry. If an earlier run already hit that bug (copy says
 * sold/unsold/skipped, catalogue still says in_auction/available) and, for a sale, the buyer's
 * squad really contains the player, the catalogue record is repaired from the copy.
 * A copy is only re-linked when it then matches the catalogue entry exactly; anything else is
 * left untouched (never discarded). Returns the list of repairs made.
 */
export function relinkLotPlayers(room) {
  const repairs = [];
  if (!Array.isArray(room.playersCatalog)) return repairs;
  const byId = new Map();
  for (const p of room.playersCatalog) if (isPlainObject(p) && typeof p.id === 'string' && !byId.has(p.id)) byId.set(p.id, p);
  const link = (holder, where) => {
    const copy = holder.player;
    if (!isPlainObject(copy) || typeof copy.id !== 'string') return;
    const cat = byId.get(copy.id);
    if (!cat || cat === copy) return;
    const proposed = { ...cat };
    let repair = null;
    if (FINAL_PLAYER_STATUSES.includes(copy.status) && !FINAL_PLAYER_STATUSES.includes(cat.status)) {
      const buyerHasPlayer = copy.status !== 'sold' ||
        (Array.isArray(room.franchises?.[copy.soldTo]?.squad) && room.franchises[copy.soldTo].squad.some(e => e?.id === copy.id));
      if (buyerHasPlayer) {
        proposed.status = copy.status;
        if ('soldTo' in copy) proposed.soldTo = copy.soldTo;
        if ('soldPrice' in copy) proposed.soldPrice = copy.soldPrice;
        repair = { playerId: cat.id, where, from: cat.status ?? null, to: copy.status, soldTo: copy.soldTo ?? null, soldPrice: copy.soldPrice ?? null };
      }
    }
    if (stableStringify(proposed) !== stableStringify(copy)) return; // differs in other ways: keep the copy
    if (repair) {
      Object.assign(cat, { status: proposed.status, soldTo: proposed.soldTo, soldPrice: proposed.soldPrice });
      repairs.push(repair);
    }
    holder.player = cat;
  };
  if (isPlainObject(room.currentLot)) link(room.currentLot, 'currentLot');
  if (Array.isArray(room.history)) room.history.forEach((h, i) => { if (isPlainObject(h)) link(h, `history[${i}]`); });
  return repairs;
}

// Rebuild in-memory structures for one room read from JSON (migrations included).
// Returns the sale-record repairs made by relinkLotPlayers.
export function reconstructRoomData(code, r) {
  r.participants = new Map(r.participants || []);
  // Migrate rooms saved before public ids existed
  for (const p of r.participants.values()) {
    if (!p.publicId) p.publicId = newPublicId();
  }
  for (const f of Object.values(r.franchises || {})) {
    if (f.isClaimed && !f.ownerId && f.ownerToken) {
      f.ownerId = r.participants.get(f.ownerToken)?.publicId || null;
    }
  }
  if (!r.playingXIConfigurations) {
    r.playingXIConfigurations = {};
    for (const f of IPL_FRANCHISES) {
      const franchise = r.franchises?.[f.id];
      r.playingXIConfigurations[f.id] = {
        franchiseId: f.id,
        playingXI: franchise?.playingXI || [],
        captainId: franchise?.captainId || null,
        viceCaptainId: franchise?.viceCaptainId || null,
        wicketKeeperId: franchise?.wicketKeeperId || null,
        impactPlayerId: franchise?.impactPlayerId || null,
        isConfirmed: !!(franchise?.playingXI && franchise.playingXI.length === 11),
        confirmedAt: null
      };
    }
  }
  backfillAuditSeq(r);
  return relinkLotPlayers(r);
}

/**
 * Apply legacy lineup cleanup to one restored room. Only lineup fields
 * (playingXI, captain, vice-captain, keeper, impact player, isConfirmed) on the franchise
 * and in playingXIConfigurations can change, plus one audit entry describing it.
 * Returns true when something was cleaned.
 */
export function applyLegacyLineupCleanupTo(code, room) {
  let plan;
  try {
    plan = planLegacyLineupCleanup(room);
  } catch (err) {
    console.error(`Legacy lineup cleanup skipped for room ${code} (room left unchanged):`, err.message);
    return false;
  }
  if (!plan.changed) return false;
  const notes = [];
  for (const [fid, parts] of Object.entries(plan.franchises)) {
    for (const [where, r] of Object.entries(parts)) {
      const target = where === 'config' ? room.playingXIConfigurations[fid] : room.franchises[fid];
      Object.assign(target, r.cleaned); // fresh arrays: never edits a shared array in place
      if (where === 'franchise') {
        const bits = [];
        if (r.removed.length) bits.push(`removed ${r.removed.length} player(s)`);
        if (r.cleared.length) bits.push(`cleared ${r.cleared.join(', ')}`);
        notes.push(`${fid}: ${bits.join('; ')}`);
      } else if (!parts.franchise) {
        notes.push(`${fid}: saved lineup config cleaned`);
      }
    }
  }
  appendAuditEntry(room, 'LEGACY_LINEUP_CLEANUP', `Removed invalid legacy Playing XI selections on restore. ${notes.join(' | ')}`);
  console.log(`[restore] Legacy lineup cleanup applied to room ${code}: ${notes.join(' | ')}`);
  return true;
}

/**
 * Rooms created before the IPL rules were fixed may carry other squad/purse limits (older
 * defaults were squad 11–15). A room still in the LOBBY is brought to the fixed rules (nothing
 * has been bought yet, so this is safe). A room whose auction already started keeps the rules
 * it started with: changing squad limits mid-auction could instantly make franchises
 * ineligible. Returns the list of changed keys.
 */
export function applyFixedRulesToLobbyRoom(room) {
  if (!isPlainObject(room) || room.status !== 'lobby' || !isPlainObject(room.config)) return [];
  const changed = [];
  for (const [key, value] of Object.entries(FIXED_RULES)) {
    if (room.config[key] !== value) {
      changed.push(`${key} ${room.config[key] ?? 'unset'}→${value}`);
      room.config[key] = value;
    }
  }
  if (changed.some(c => c.startsWith('basePurse'))) { // lobby franchises show the purse they will start with
    for (const f of Object.values(room.franchises || {})) {
      if (isPlainObject(f) && Array.isArray(f.squad) && f.squad.length === 0) {
        f.initialPurse = FIXED_RULES.basePurse;
        f.remainingPurse = FIXED_RULES.basePurse;
        f.totalSpent = 0;
      }
    }
  }
  if (changed.length) appendAuditEntry(room, 'RULES_NORMALIZED', `Room brought to the fixed IPL auction rules before the auction: ${changed.join(', ')}`);
  return changed;
}

/**
 * Completed auctions get ONE deterministic evaluation snapshot (room.analysis). Rooms completed
 * before Stage 3 have none: it is computed once from their final squads (their legacy
 * evaluationResults are left untouched) and never recomputed afterwards.
 */
export function ensureAnalysisSnapshot(room) {
  if (!isPlainObject(room) || room.status !== 'completed' || isPlainObject(room.analysis)) return false;
  try {
    room.analysis = evaluateAuction(room);
  } catch (err) {
    console.error(`[analysis] could not evaluate room ${room.roomCode}: ${err.message}`);
    return false;
  }
  appendAuditEntry(room, 'ANALYSIS_SNAPSHOT_CREATED', 'Post-auction evaluation snapshot created from the final squads.');
  return true;
}

/**
 * Full restore preparation for one room read from JSON: shape check (throws → caller
 * quarantines), reconstruction, lot/history re-linking, legacy lineup cleanup.
 * Mutates r in place. Returns { cleaned, repairs }.
 */
export function prepareRestoredRoom(code, r) {
  const problem = findRoomShapeProblem(r);
  if (problem) throw new Error(problem);
  const repairs = reconstructRoomData(code, r);
  if (repairs.length) {
    appendAuditEntry(r, 'RESTORE_SALE_RECORD_REPAIRED',
      `Restored ${repairs.length} catalogue sale record(s) from lot results saved by an earlier version: ` +
      repairs.map(x => `${x.playerId} ${x.from ?? 'unset'}→${x.to}${x.soldTo ? ` (${x.soldTo})` : ''}`).join(', '));
    console.log(`[restore] Room ${code}: repaired ${repairs.length} catalogue sale record(s) from saved lot results.`);
  }
  const cleaned = applyLegacyLineupCleanupTo(code, r);
  const rulesNormalized = applyFixedRulesToLobbyRoom(r);
  const analysisAdded = ensureAnalysisSnapshot(r);
  return { cleaned: cleaned || rulesNormalized.length > 0 || analysisAdded, repairs, rulesNormalized };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the 290 deduplicated players
const playersRaw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'players.json'), 'utf-8')
);

const DEFAULT_STORAGE_FILE = path.join(__dirname, 'data', 'persisted_rooms.json');
const SAVE_DEBOUNCE_MS = 750;

export class RoomManager {
  constructor(io, options = {}) {
    this.io = io;
    // PostgreSQL store (PERSISTENCE=postgres). When set, the JSON file is never read or written.
    this.store = options.store || null;
    // Overridable so tests never touch the real file
    this.storageFile = this.store ? null : (options.storageFile || process.env.ROOM_STORAGE_FILE || DEFAULT_STORAGE_FILE);
    this.rooms = new Map(); // roomCode -> roomState
    // Post-auction AI: env and fetch can be injected (tests); in-flight generations per room
    this.aiEnv = options.aiEnv || null;
    this.aiDeps = options.aiDeps || null;
    this.aiInFlight = new Map();
    this.aiActive = 0;
    // Rooms that could not be restored: kept VERBATIM (as read from disk) and written back on
    // every save so they are never silently deleted. Not loaded, not served, not repaired.
    this.quarantinedRooms = new Map(); // roomCode -> original JSON object
    // Set when the save file itself is unreadable: no writes until it is recovered manually,
    // so the original file can never be replaced.
    this.writesDisabled = false;
    this.timerIntervals = new Map(); // roomCode -> intervalId
    this.advanceTimeouts = new Map(); // roomCode -> pending "next lot" timeout
    this.saveTimer = null;
    // false until rooms are restored (PostgreSQL mode: until init() has run)
    this.ready = !this.store;
    if (this.store) {
      this.storageStatus = this.store.status; // live object: /api/health shows the store's state
      // Room broadcasts describing changes that are not committed yet are held here and
      // released in order once the change commits (clients are never told about an
      // uncommitted change). code -> [{ seq, event, payload }]
      this.heldEmits = new Map();
      this.store.attach(code => this.rooms.get(code), {
        onCommitted: code => this.onStoreCommitted(code),
        onFailed: (code, err) => this.onStoreFailed(code, err),
        onLeaseLost: () => { for (const code of this.rooms.keys()) this.onStoreFailed(code, new Error('writer lease lost')); }
      });
      return; // rooms are loaded by `await init()` before the server accepts room traffic
    }
    this.storageStatus = {
      kind: 'json-file',
      durable: false,
      file: path.basename(this.storageFile),
      warning: 'Temporary JSON file storage. Not durable on Render: data is lost on deploy/restart. Set PERSISTENCE=postgres and DATABASE_URL for durable PostgreSQL storage.',
      lastWriteAt: null,
      lastError: null,
      loadError: null,          // e.g. UNREADABLE_SAVE_FILE
      preservedCopy: null,      // file name of the byte-identical copy of an unreadable save file
      quarantinedRooms: [],     // codes of rooms kept on disk but not loaded
      quarantineCopy: []        // file names of the per-room recovery copies
    };
    this.loadFromStorage();
    this.recoverAfterRestart();
  }

  /**
   * Restore from PostgreSQL (no-op in JSON mode, which loads in the constructor).
   * Rooms that cannot be rebuilt are not loaded and are reported as quarantined; their rows
   * stay in the database untouched. Then the normal restart-recovery rule runs.
   */
  async init() {
    if (!this.store) return;
    const { rooms, failures, quarantinedCodes } = await this.store.loadAll();
    for (const code of quarantinedCodes) this.quarantinedRooms.set(code, { source: 'postgres:quarantined_rooms' });
    for (const f of failures) {
      this.quarantinedRooms.set(f.code, { source: 'postgres:load-failure', error: f.error });
      console.error(`[restore] Room ${f.code} could not be rebuilt from PostgreSQL and was NOT loaded (rows left untouched): ${f.error}`);
    }
    for (const { code, room } of rooms) {
      if (this.applyLegacyLineupCleanup(code, room)) this.store.markDirty(code);
      if (applyFixedRulesToLobbyRoom(room).length) this.store.markDirty(code);
      if (ensureAnalysisSnapshot(room)) this.store.markDirty(code);
      this.rooms.set(code, room);
    }
    this.storageStatus.quarantinedRooms = [...this.quarantinedRooms.keys()];
    this.recoverAfterRestart();
    await this.store.flushAll();
    this.ready = true;
    const q = this.quarantinedRooms.size;
    console.log(`Loaded ${this.rooms.size} room(s) from PostgreSQL.${q ? ` ${q} room(s) not loaded (quarantined/failed).` : ''}`);
  }

  // Mark rooms for the PostgreSQL store (all rooms when the caller did not say which)
  markStoreDirty(room) {
    if (room && room.roomCode) this.store.markDirty(room.roomCode);
    else for (const code of this.rooms.keys()) this.store.markDirty(code);
  }

  // ── PostgreSQL durability helpers ──────────────────────────────────────
  /** Resolves true when every change made to this room so far is committed (JSON: true). */
  persisted(room) {
    if (!this.store || !room) return Promise.resolve(true);
    return this.store.persistNow(room.roomCode);
  }

  /** True while a room is on storage hold (saving failed): mutations must be refused. */
  storageBlocked(room) {
    return !!(this.store && room && room.storageHold);
  }

  // Send to everyone in the room, unless the room has uncommitted changes: then hold the
  // message (snapshotted now) until those changes commit, preserving order.
  emitToRoom(room, event, payload) {
    const code = room.roomCode;
    if (!this.store) { this.io.to(code).emit(event, payload); return; }
    const queue = this.heldEmits.get(code);
    if ((!queue || queue.length === 0) && this.store.isCommitted(code)) {
      this.io.to(code).emit(event, payload);
      return;
    }
    let snapshot;
    try { snapshot = structuredClone(payload); } catch { snapshot = JSON.parse(JSON.stringify(payload)); }
    if (!queue) this.heldEmits.set(code, []);
    this.heldEmits.get(code).push({ seq: this.store.seq.get(code) || 0, event, payload: snapshot });
  }

  releaseHeldEmits(code) {
    const queue = this.heldEmits.get(code);
    if (!queue || !queue.length) return;
    const committed = this.store.committedSeq.get(code) || 0;
    const allCommitted = this.store.isCommitted(code);
    while (queue.length && (allCommitted || queue[0].seq <= committed)) {
      const m = queue.shift();
      this.io.to(code).emit(m.event, m.payload);
    }
  }

  onStoreCommitted(code) {
    this.releaseHeldEmits(code);
    const room = this.rooms.get(code);
    if (room && room.storageHold && this.store.isCommitted(code) && !this.store.conflicts.has(code) && !this.store.status.leaseLost) {
      room.storageHold = false;
      this.updateHoldStatus();
      console.log(`[db] room ${code}: storage recovered; hold released (host can resume)`);
      this.broadcastRoomState(room, 'state_updated');
    }
  }

  // A write did not commit (after retries), hit a conflict, or the lease was lost: freeze the
  // room so nothing more happens on top of unsaved state. Live auctions are paused (clock
  // stopped); mutations are refused until storage recovers. Held broadcasts stay held, so no
  // client is told about the unsaved change. The store keeps retrying in the background.
  onStoreFailed(code, err) {
    const room = this.rooms.get(code);
    if (!room || room.storageHold) return;
    room.storageHold = true;
    this.clearRoomTimer(code);
    this.clearAdvanceTimeout(code);
    if (room.status === 'active') {
      room.status = 'paused';
      this.addAuditLog(room, 'STORAGE_HOLD_PAUSED', 'Saving to the database failed; the auction was paused automatically and will be saved when storage recovers. The host can resume afterwards.');
      this.store.markDirty(code);
    }
    this.updateHoldStatus();
    console.error(`[db] room ${code} placed on STORAGE HOLD (${err?.message || err}); actions are refused until it is saved.`);
  }

  updateHoldStatus() {
    this.storageStatus.roomsOnHold = [...this.rooms.values()].filter(r => r.storageHold).map(r => r.roomCode);
  }

  // Room creation whose first save failed: nobody has been told the room exists
  discardUnsavedRoom(code) {
    this.rooms.delete(code);
    if (this.store) {
      this.store.forget(code);
      this.heldEmits.delete(code);
      this.updateHoldStatus();
    }
  }

  // Immediate save. JSON: atomic write (temp file + rename) so a crash never leaves a
  // half-written file. PostgreSQL: same as scheduleSave (every change is written at once).
  saveToStorage(room) {
    if (this.store) {
      this.scheduleSave(room);
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.writesDisabled) {
      // The save file could not be read at startup; never replace it.
      this.storageStatus.lastError = 'WRITES_DISABLED_UNREADABLE_SAVE_FILE';
      return;
    }
    try {
      const serializableRooms = {};
      // Quarantined rooms first, exactly as they were read (never dropped by a later save)
      for (const [code, original] of this.quarantinedRooms.entries()) {
        if (!this.rooms.has(code)) serializableRooms[code] = original;
      }
      for (const [code, r] of this.rooms.entries()) {
        serializableRooms[code] = {
          ...r,
          participants: Array.from(r.participants ? r.participants.entries() : [])
        };
      }
      const tmp = `${this.storageFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(serializableRooms), 'utf-8');
      fs.renameSync(tmp, this.storageFile);
      this.storageStatus.lastWriteAt = new Date().toISOString();
      this.storageStatus.lastError = null;
    } catch (err) {
      this.storageStatus.lastError = err.code || 'WRITE_FAILED'; // code only: no server paths in /api/health
      console.error('Failed to save rooms to disk:', err.message);
    }
  }

  // JSON: coalesces bursts of changes into one write (debounced).
  // PostgreSQL: no debounce. The room's write starts immediately; changes made while a write
  // is in flight go into the next one (per-room serialization coalesces bursts).
  scheduleSave(room) {
    if (this.store) {
      this.markStoreDirty(room);
      const p = room && room.roomCode ? this.store.flushRoom(room.roomCode) : this.store.flushAll();
      p.catch(err => console.error('[db] flush failed:', err.message));
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToStorage();
    }, SAVE_DEBOUNCE_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  // Write any pending change now (used on shutdown and in tests).
  // PostgreSQL mode returns a promise that resolves to true when everything is written.
  flushStorage() {
    if (this.store) {
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      return this.store.flushAll();
    }
    if (this.saveTimer) this.saveToStorage();
  }

  // Stop every timer this manager owns (countdowns, pending lot advances, debounced save)
  // after flushing pending state. Used on process shutdown and by tests.
  // PostgreSQL mode returns a promise (await it before exiting).
  shutdown() {
    for (const code of [...this.timerIntervals.keys()]) this.clearRoomTimer(code);
    for (const code of [...this.advanceTimeouts.keys()]) this.clearAdvanceTimeout(code);
    if (this.store) return this.flushStorage();
    this.flushStorage();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  }

  /**
   * Restart recovery rule (exact behaviour):
   *  - A room that was ACTIVE when the process stopped is set to PAUSED. Its live clock
   *    was never persisted, so the open lot's countdown is reset to the full timer
   *    (config.timerDuration) and hammerStatus to OPEN. The highest bid and bidder are kept.
   *    Nobody can lose a lot to a clock that ran while the server was down.
   *  - A room the host had already PAUSED keeps its exact countdown: the clock was stopped
   *    and the value was saved at the moment of pausing.
   *  - A lot that had already been hammered (SOLD/UNSOLD gap) stays closed; on resume the
   *    next player is presented (see resumeAuction).
   *  - lobby/completed rooms are restored unchanged.
   * The host resumes when players have reconnected.
   */
  recoverAfterRestart() {
    for (const room of this.rooms.values()) {
      room.isSkippingSet = false;
      if (room.status === 'active') {
        room.status = 'paused';
        const lot = room.currentLot;
        if (lot && isLotOpen(lot)) {
          lot.countdown = room.config.timerDuration;
          lot.hammerStatus = 'OPEN';
        }
        this.addAuditLog(room, 'SERVER_RESTART_PAUSED',
          `Server restarted. Auction paused; countdown reset to ${room.config.timerDuration}s. Host can resume.`);
        this.scheduleSave(room);
      }
    }
  }

  /**
   * Restore rooms from the JSON save file. Each room is handled independently:
   *  - a structurally invalid room, or one whose reconstruction throws, is QUARANTINED: its
   *    original data is kept verbatim (in memory, in every later save, and in a separate
   *    recovery copy) and it is not loaded. Other rooms are unaffected.
   *  - legacy lineup cleanup runs per room and can never affect another room.
   *  - if the whole file cannot be read or parsed, a byte-identical copy is preserved and
   *    saving is disabled for this process, so the original is never replaced.
   */
  loadFromStorage() {
    if (!fs.existsSync(this.storageFile)) return;

    let data;
    try {
      const raw = fs.readFileSync(this.storageFile, 'utf-8');
      data = JSON.parse(raw);
      if (!isPlainObject(data)) throw new Error('top level is not an object of rooms');
    } catch (err) {
      this.handleUnreadableSaveFile(err);
      return;
    }

    let changedRooms = 0;
    const newlyQuarantined = {};
    for (const [code, r] of Object.entries(data)) {
      // Keep an untouched copy BEFORE reconstruction mutates anything
      let original;
      try {
        original = structuredClone(r);
      } catch {
        original = r;
      }
      try {
        // shape check, reconstruction, lot re-linking, legacy Playing XI cleanup (per room)
        const { cleaned, repairs } = prepareRestoredRoom(code, r);
        if (cleaned || repairs.length) changedRooms++;
        this.rooms.set(code, r);
        this.quarantinedRooms.delete(code);
      } catch (err) {
        this.rooms.delete(code);
        this.quarantinedRooms.set(code, original);
        newlyQuarantined[code] = original;
        console.error(`[restore] Room ${code} could not be restored and was QUARANTINED (kept on disk, not loaded): ${err.message}`);
      }
    }
    this.storageStatus.quarantinedRooms = [...this.quarantinedRooms.keys()];

    if (Object.keys(newlyQuarantined).length > 0) this.writeQuarantineCopy(newlyQuarantined);
    // Persist only when a real cleanup/repair happened (repeat loads are no-ops: idempotent).
    // Quarantined rooms are written back verbatim by saveToStorage.
    if (changedRooms > 0) this.saveToStorage();
    const q = this.quarantinedRooms.size;
    console.log(`Loaded ${this.rooms.size} persistent room(s) from disk.${q ? ` ${q} room(s) quarantined for manual recovery.` : ''}`);
  }

  // Rebuild in-memory structures for one room read from disk (see reconstructRoomData)
  reconstructRoom(code, r) {
    return reconstructRoomData(code, r);
  }

  // Whole save file unreadable: preserve a byte-identical copy, never overwrite the original
  handleUnreadableSaveFile(err) {
    this.writesDisabled = true;
    this.storageStatus.loadError = 'UNREADABLE_SAVE_FILE';
    console.error(`[restore] Save file could not be read (${err.message}). It will NOT be overwritten: saving is disabled for this process until it is recovered manually.`);
    try {
      const copy = `${this.storageFile}.unreadable-${Date.now()}.bak`;
      fs.copyFileSync(this.storageFile, copy, fs.constants.COPYFILE_EXCL);
      const same = fs.readFileSync(copy).equals(fs.readFileSync(this.storageFile));
      if (!same) throw new Error('preserved copy does not match the original');
      this.storageStatus.preservedCopy = path.basename(copy);
      console.error(`[restore] Byte-identical copy preserved as ${path.basename(copy)}`);
    } catch (copyErr) {
      console.error(`[restore] Could not create a preserved copy (${copyErr.message}); the original file is untouched.`);
    }
  }

  // Separate recovery copy per quarantined room. The name includes a hash of the room's
  // content, so repeated loads of the same data create no new files, and an existing file is
  // never overwritten.
  writeQuarantineCopy(rooms) {
    const written = [];
    for (const [code, original] of Object.entries(rooms)) {
      const json = JSON.stringify({ [code]: original });
      const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 12);
      const safeCode = String(code).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
      const copy = `${this.storageFile}.quarantined-${safeCode}-${hash}.json`;
      try {
        fs.writeFileSync(copy, json, { encoding: 'utf-8', flag: 'wx' });
        console.error(`[restore] Recovery copy of quarantined room ${code} written to ${path.basename(copy)}`);
      } catch (err) {
        if (err.code !== 'EEXIST') {
          console.error(`[restore] Could not write recovery copy for room ${code} (${err.message}); it remains preserved in the main save file.`);
          continue;
        }
      }
      written.push(path.basename(copy));
    }
    this.storageStatus.quarantineCopy = written;
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  createRoom({ hostName, hostToken, configOverrides = {} }) {
    let roomCode = this.generateRoomCode();
    while (this.rooms.has(roomCode) || this.quarantinedRooms.has(roomCode)) {
      roomCode = this.generateRoomCode();
    }

    // Shared validator: invalid creation config is rejected, never silently adjusted
    const checked = validateConfig(configOverrides || {}, DEFAULT_CONFIG);
    if (!checked.ok) throw new ConfigValidationError(checked.errors);
    const config = checked.config;

    // Deep clone players list for this room
    const catalog = JSON.parse(JSON.stringify(playersRaw));

    // Initialize all 10 franchises with flat ₹120.0 Crore purse and Playing XI management
    const franchises = {};
    for (const f of IPL_FRANCHISES) {
      franchises[f.id] = {
        ...f,
        ownerToken: null, // private: never broadcast (see toPublicFranchise)
        ownerId: null, // public participant id, safe to broadcast
        ownerName: null,
        ownerSocketId: null, // private
        isClaimed: false,
        initialPurse: config.basePurse || 120.0,
        remainingPurse: config.basePurse || 120.0,
        totalSpent: 0,
        squad: [],
        overseasCount: 0,
        isEliminated: false,
        eliminationReason: null,
        playingXI: [], // 11 players in batting order
        captainId: null, // Exactly 1
        viceCaptainId: null, // Exactly 1
        wicketKeeperId: null, // At least 1
        impactPlayerId: null // From bench
      };
    }

    // Independent, dedicated Playing XI configuration store for all franchises
    const playingXIConfigurations = {};
    for (const f of IPL_FRANCHISES) {
      playingXIConfigurations[f.id] = {
        franchiseId: f.id,
        playingXI: [],
        captainId: null,
        viceCaptainId: null,
        wicketKeeperId: null,
        impactPlayerId: null,
        isConfirmed: false,
        confirmedAt: null
      };
    }

    const room = {
      roomCode,
      createdAt: new Date().toISOString(),
      hostToken,
      hostName,
      status: 'lobby', // 'lobby' | 'active' | 'paused' | 'completed'
      config,
      playersCatalog: catalog,
      currentPlayerIndex: -1,
      currentLot: null,
      franchises,
      playingXIConfigurations,
      participants: new Map(), // token -> { token, name, socketId, franchiseId, isHost }
      history: [], // List of completed lots { player, winningFranchise, finalBid, bidsCount, status }
      allBids: [], // Complete audit log of every bid placed
      auditLog: [
        {
          seq: 1,
          timestamp: new Date().toISOString(),
          type: 'ROOM_CREATED',
          message: `Room ${roomCode} created by host "${hostName}"`
        }
      ],
      auditSeq: 1,
      evaluationResults: null
    };

    this.rooms.set(roomCode, room);
    if (this.store) this.store.noteAudit(roomCode, room.auditLog[0]);
    this.saveToStorage(room);
    return room;
  }

  getRoom(roomCode) {
    if (!roomCode || typeof roomCode !== 'string' || roomCode.length > 16) return null;
    return this.rooms.get(roomCode.toUpperCase()) || null;
  }

  joinRoom({ roomCode, participantName, participantToken, socketId }) {
    const room = this.getRoom(roomCode);
    if (!room) {
      return { success: false, error: 'Auction room not found' };
    }

    // A stored hash key is never a valid token (tokens cannot contain ':')
    if (typeof participantToken !== 'string' || isHashKey(participantToken) || participantToken.includes(':')) {
      return { success: false, error: 'Invalid session token' };
    }
    if (this.store) this.claimHashedSession(room, participantToken);

    // Check if participant is reconnecting
    let participant = room.participants.get(participantToken);
    if (participant) {
      // Reconnection: the newest connection becomes the only one allowed to act.
      // The display name is kept as registered so franchise ownership labels stay consistent.
      const previousSocketId = participant.socketId;
      participant.socketId = socketId;
      if (!participant.publicId) participant.publicId = newPublicId();
      if (participant.franchiseId && room.franchises[participant.franchiseId]) {
        room.franchises[participant.franchiseId].ownerSocketId = socketId;
      }
      this.addAuditLog(room, 'PARTICIPANT_RECONNECTED', `${participant.name} reconnected.`);
      this.scheduleSave(room); // persist: participant reconnected (socket binding)
      return {
        success: true,
        room: this.getPublicRoomState(room),
        participant: toSelfParticipant(participant),
        previousSocketId: previousSocketId !== socketId ? previousSocketId : null
      };
    }

    // New participant joining
    if (room.status !== 'lobby') {
      return {
        success: false,
        error: 'Auction has already started. New participants cannot join an active room.'
      };
    }

    const isHost = room.hostToken === participantToken;
    participant = {
      token: participantToken, // private
      publicId: newPublicId(), // public
      name: participantName,
      socketId,
      franchiseId: null,
      isHost
    };

    room.participants.set(participantToken, participant);
    this.addAuditLog(room, 'PARTICIPANT_JOINED', `${participantName} joined the lobby.`);
    this.scheduleSave(room); // persist: participant joined

    this.recalculateLobbyPurses(room);

    return { success: true, room: this.getPublicRoomState(room), participant: toSelfParticipant(participant), previousSocketId: null };
  }

  /**
   * Rooms restored from PostgreSQL hold only token HASHES (keys "hash:<hex>"). When someone
   * presents a raw token whose hash matches, switch that participant / host / franchise owner
   * back to the raw token in memory, so the rest of the server works unchanged. The database
   * never receives the raw token (it stores the same hash either way).
   */
  claimHashedSession(room, token) {
    if (room.participants.has(token)) return false;
    const key = hashKeyOf(token);
    let changed = false;
    if (room.participants.has(key)) {
      const rebuilt = new Map();
      for (const [k, p] of room.participants.entries()) {
        if (k === key) { p.token = token; rebuilt.set(token, p); } else rebuilt.set(k, p);
      }
      room.participants = rebuilt;
      changed = true;
    }
    if (room.hostToken === key) { room.hostToken = token; changed = true; }
    for (const f of Object.values(room.franchises)) {
      if (f.ownerToken === key) { f.ownerToken = token; changed = true; }
    }
    return changed;
  }

  selectFranchise({ roomCode, participantToken, franchiseId }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };

    if (room.status !== 'lobby') {
      return { success: false, error: 'Franchise selection is locked once auction begins' };
    }

    const participant = room.participants.get(participantToken);
    if (!participant) return { success: false, error: 'Participant not registered in room' };

    const targetFranchise = room.franchises[franchiseId];
    if (!targetFranchise) return { success: false, error: 'Invalid franchise selected' };

    // Check if already claimed by someone else
    if (targetFranchise.isClaimed && targetFranchise.ownerToken !== participantToken) {
      return { success: false, error: `${targetFranchise.name} has already been chosen by ${targetFranchise.ownerName}` };
    }

    // Free previously selected franchise if any
    if (participant.franchiseId && participant.franchiseId !== franchiseId) {
      const prev = room.franchises[participant.franchiseId];
      if (prev && prev.ownerToken === participantToken) {
        prev.isClaimed = false;
        prev.ownerToken = null;
        prev.ownerId = null;
        prev.ownerName = null;
        prev.ownerSocketId = null;
      }
    }

    // Claim new franchise
    targetFranchise.isClaimed = true;
    targetFranchise.ownerToken = participantToken;
    targetFranchise.ownerId = participant.publicId;
    targetFranchise.ownerName = participant.name;
    targetFranchise.ownerSocketId = participant.socketId;
    participant.franchiseId = franchiseId;

    this.recalculateLobbyPurses(room);

    this.addAuditLog(
      room,
      'FRANCHISE_SELECTED',
      `${participant.name} selected ${targetFranchise.name} (${targetFranchise.code})`
    );
    this.scheduleSave(room); // persist: franchise claimed/released

    return { success: true, room: this.getPublicRoomState(room) };
  }

  recalculateLobbyPurses(room) {
    // Every IPL franchise starts with exactly ₹120 Crore (Total across 10 franchises = ₹1,200 Cr)
    const flatPurse = room.config.basePurse || 120.0;
    for (const f of Object.values(room.franchises)) {
      f.initialPurse = flatPurse;
      if (f.squad.length === 0) {
        f.remainingPurse = flatPurse;
      }
    }
  }

  // Server-side ownership check shared by all franchise-scoped edits
  isFranchiseOwner(room, participantToken, franchiseId) {
    if (!room || typeof participantToken !== 'string' || typeof franchiseId !== 'string') return false;
    if (!Object.prototype.hasOwnProperty.call(room.franchises, franchiseId)) return false;
    const franchise = room.franchises[franchiseId];
    const participant = room.participants.get(participantToken);
    return !!participant &&
      franchise.isClaimed === true &&
      franchise.ownerToken === participantToken &&
      participant.franchiseId === franchiseId;
  }

  // Legacy lineup cleanup for one restored room (see applyLegacyLineupCleanupTo)
  applyLegacyLineupCleanup(code, room) {
    return applyLegacyLineupCleanupTo(code, room);
  }

  // Delegates to the shared ownership rule (also used by legacy lineup cleanup)
  getOwnedPlayers(room, franchiseId) {
    return getOwnedPlayers(room, franchiseId);
  }

  updatePlayingXI({ roomCode, participantToken, franchiseId, playingXI = [], captainId = null, viceCaptainId = null, wicketKeeperId = null, impactPlayerId = null, isConfirmed = true }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };

    // Authorization (approved rule): ONLY the authenticated owner of a franchise may change
    // its Playing XI. The host has no special permission over other franchises.
    // Ownership is decided purely from server-side state set by selectFranchise: the
    // franchise's private ownerToken AND the participant's own franchiseId must both match
    // the authenticated session. Client-supplied owner/participant ids or host flags are
    // never consulted. Unknown franchises get the same error (no information leak).
    if (!this.isFranchiseOwner(room, participantToken, franchiseId)) {
      return { success: false, error: PLAYING_XI_FORBIDDEN, code: 'FORBIDDEN' };
    }
    const franchise = room.franchises[franchiseId];

    const reject = (error, code = 'INVALID_LINEUP') => ({ success: false, error, code });

    // Shape checks (the socket layer checks too; repeated here so no caller can skip them)
    if (!Array.isArray(playingXI) || !playingXI.every(id => typeof id === 'string')) {
      return reject('Playing XI must be a list of player ids');
    }
    for (const [label, id] of [['Captain', captainId], ['Vice-Captain', viceCaptainId], ['Wicketkeeper', wicketKeeperId], ['Impact player', impactPlayerId]]) {
      if (id !== null && id !== undefined && typeof id !== 'string') return reject(`${label} must be a player id`);
    }

    // Max 11 players in Playing XI
    if (playingXI.length > 11) {
      return reject('Playing XI cannot have more than 11 players');
    }

    // The same player may not be listed twice
    if (new Set(playingXI).size !== playingXI.length) {
      return reject('Duplicate player: the same player cannot appear twice in the Playing XI', 'DUPLICATE_PLAYER');
    }

    // SQUAD OWNERSHIP: only players this franchise has purchased are eligible. Ownership is read
    // from authoritative server state on every update; nothing the browser sends about squads,
    // sale status or owners is consulted.
    const owned = this.getOwnedPlayers(room, franchiseId);
    const notOwned = id => {
      const p = (room.playersCatalog || []).find(c => c.id === id);
      return reject(`${p ? p.name : 'Selected player'} is not in ${franchise.name}'s purchased squad`, 'PLAYER_NOT_IN_SQUAD');
    };
    for (const pid of playingXI) {
      if (!owned.has(pid)) return notOwned(pid);
    }

    // Overseas limit in Playing XI (Max 4 overseas)
    const overseasInXI = playingXI.filter(pid => owned.get(pid).isOverseas).length;
    if (overseasInXI > 4) {
      return reject(`Maximum 4 overseas players allowed in Playing XI (Current: ${overseasInXI})`);
    }

    // Impact Player validation: must be a purchased squad player, not in starting XI
    if (impactPlayerId) {
      if (!owned.has(impactPlayerId)) return notOwned(impactPlayerId);
      if (playingXI.includes(impactPlayerId)) {
        return reject('Impact player cannot also be in the starting Playing XI');
      }
    }

    // A player can only ever be in one franchise's lineup. Squad ownership already implies this;
    // this guards against inconsistent restored data (e.g. a player duplicated into two squads).
    // An entry in another lineup only counts if that franchise really has the player in its
    // squad: stale lineups saved before the squad rule (lobby picks of catalogue players) must
    // not block the franchise that actually bought the player.
    const chosen = new Set([...playingXI, ...(impactPlayerId ? [impactPlayerId] : [])]);
    for (const [otherId, other] of Object.entries(room.franchises)) {
      if (otherId === franchiseId) continue;
      const cfg = room.playingXIConfigurations?.[otherId];
      const theirSquad = new Set((other.squad || []).map(p => p.id));
      const theirs = [...(other.playingXI || []), ...(cfg?.playingXI || []), other.impactPlayerId, cfg?.impactPlayerId]
        .filter(id => id && theirSquad.has(id));
      const clash = theirs.find(id => chosen.has(id));
      if (clash) {
        return reject(`${owned.get(clash)?.name || 'A selected player'} is already in ${other.name}'s Playing XI`, 'PLAYER_IN_OTHER_LINEUP');
      }
    }

    // Captain and Vice-Captain assignment checks
    if (captainId && !playingXI.includes(captainId)) {
      return reject('Captain must be selected from the Playing XI');
    }
    if (viceCaptainId && !playingXI.includes(viceCaptainId)) {
      return reject('Vice-Captain must be selected from the Playing XI');
    }
    if (captainId && viceCaptainId && captainId === viceCaptainId) {
      return reject('Captain and Vice-Captain must be two distinct players');
    }

    // A designated wicketkeeper must be a WK in this Playing XI (previously stored unchecked)
    if (wicketKeeperId && (!playingXI.includes(wicketKeeperId) || owned.get(wicketKeeperId)?.category !== 'WK')) {
      return reject('Designated wicketkeeper must be a wicketkeeper in the Playing XI');
    }

    // If XI is fully populated (11 players), enforce mandatory roles
    if (playingXI.length === 11) {
      const wkCount = playingXI.filter(pid => owned.get(pid).category === 'WK').length;
      if (wkCount < 1) {
        return reject('Playing XI must have at least 1 Wicketkeeper');
      }
      if (!captainId) {
        return reject('Playing XI must have exactly 1 Captain assigned');
      }
      if (!viceCaptainId) {
        return reject('Playing XI must have exactly 1 Vice-Captain assigned');
      }
    }

    // Update franchise state
    franchise.playingXI = [...playingXI];
    franchise.captainId = captainId;
    franchise.viceCaptainId = viceCaptainId;
    franchise.wicketKeeperId = wicketKeeperId || (playingXI.find(pid => owned.get(pid).category === 'WK') || null);
    franchise.impactPlayerId = impactPlayerId;
    franchise.isConfirmed = !!isConfirmed;

    // Independent persistent data structure
    if (!room.playingXIConfigurations) room.playingXIConfigurations = {};
    room.playingXIConfigurations[franchiseId] = {
      franchiseId,
      playingXI: [...playingXI],
      captainId,
      viceCaptainId,
      wicketKeeperId: franchise.wicketKeeperId,
      impactPlayerId,
      isConfirmed: !!isConfirmed,
      confirmedAt: new Date().toISOString()
    };

    this.addAuditLog(room, 'PLAYING_XI_UPDATED', `${franchise.name} confirmed their Playing XI (${playingXI.length}/11)`);
    this.saveToStorage(room);
    this.broadcastRoomState(room, 'state_updated');

    return {
      success: true,
      franchise: toPublicFranchise(franchise),
      configuration: room.playingXIConfigurations[franchiseId]
    };
  }

  updateConfig({ roomCode, hostToken, newConfig }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };
    if (room.hostToken !== hostToken) return { success: false, error: 'Only the host can configure auction settings' };
    if (room.status !== 'lobby') return { success: false, error: 'Settings can only be modified before starting' };

    // Same validator as room creation; on any error the config is left untouched
    const checked = validateConfig(newConfig, room.config);
    if (!checked.ok) {
      return { success: false, error: checked.errors.join('; '), errors: checked.errors };
    }
    room.config = checked.config;

    this.recalculateLobbyPurses(room);
    this.addAuditLog(room, 'CONFIG_UPDATED', `Host updated auction configuration.`);
    this.scheduleSave(room); // persist: config changed
    return { success: true, room: this.getPublicRoomState(room) };
  }

  startAuction({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };
    if (room.hostToken !== hostToken) return { success: false, error: 'Only host can start the auction' };
    if (room.status !== 'lobby') return { success: false, error: 'Auction has already started' };

    const claimedFranchises = Object.values(room.franchises).filter(f => f.isClaimed);
    if (claimedFranchises.length < room.config.minParticipants) {
      return {
        success: false,
        error: `At least ${room.config.minParticipants} human participants must select franchises to start.`
      };
    }

    // Fixed IPL rules (purse, squad 15–25, 8 overseas, 1 WK) apply to every auction that starts
    applyFixedRulesToLobbyRoom(room);
    // Lock dynamic purse allocation permanently
    this.recalculateLobbyPurses(room);

    // Auction order: shuffled within each set ONCE, then locked (persisted with the room)
    if (!room.auctionOrder) {
      shuffleWithinSets(room.playersCatalog);
      room.auctionOrder = { mode: 'shuffled-within-sets', generatedAt: new Date().toISOString(), locked: true };
      this.addAuditLog(room, 'AUCTION_ORDER_LOCKED', `Lot order generated (players shuffled within each set) and locked for ${room.playersCatalog.length} players.`);
    }
    room.status = 'active';

    this.addAuditLog(
      room,
      'AUCTION_STARTED',
      `Auction started with ${claimedFranchises.length} active teams. Purse locked at ₹${claimedFranchises[0].initialPurse} Cr each.`
    );
    this.scheduleSave(room); // persist: auction started

    // Present first player
    this.nextPlayer(room);

    return { success: true, room: this.getPublicRoomState(room) };
  }

  pauseAuction({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room || room.hostToken !== hostToken) return { success: false, error: 'Unauthorized' };

    if (room.status === 'active') {
      room.status = 'paused';
      this.clearRoomTimer(room.roomCode);
      this.addAuditLog(room, 'AUCTION_PAUSED', 'Auction was paused by the host.');
      this.scheduleSave(room); // persist: paused (exact countdown kept)
      return { success: true, room: this.getPublicRoomState(room) };
    }
    return { success: false, error: 'Auction is not active' };
  }

  resumeAuction({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room || room.hostToken !== hostToken) return { success: false, error: 'Unauthorized' };

    if (room.status === 'paused') {
      room.status = 'active';
      this.addAuditLog(room, 'AUCTION_RESUMED', 'Auction was resumed by the host.');
      this.scheduleSave(room); // persist: resumed
      if (room.currentLot && !isLotOpen(room.currentLot)) {
        // Paused in the gap after SOLD/UNSOLD: present the next player instead of
        // restarting a clock on a lot that is already closed
        this.nextPlayer(room);
      } else {
        this.startRoomTimer(room);
      }
      return { success: true, room: this.getPublicRoomState(room) };
    }
    return { success: false, error: 'Auction is not paused' };
  }

  nextPlayer(room) {
    this.clearRoomTimer(room.roomCode);
    // Whoever advances first (auto-advance, host advance, skip set, resume) cancels the others
    this.clearAdvanceTimeout(room.roomCode);
    // Never present an open lot's replacement before the open lot is resolved. (Skip Set marks
    // its current player SKIPPED first, which is a resolution: that lot is deliberately not sold.)
    if (room.currentLot && isLotOpen(room.currentLot) && room.currentLot.player?.status === 'in_auction') {
      this.closeCurrentLot(room);
      this.clearAdvanceTimeout(room.roomCode);
    }

    // Advance; a player that is already resolved (sold/unsold/skipped) is never presented again
    do {
      room.currentPlayerIndex++;
    } while (room.currentPlayerIndex < room.playersCatalog.length &&
      FINAL_PLAYER_STATUSES.includes(room.playersCatalog[room.currentPlayerIndex]?.status));
    if (room.currentPlayerIndex >= room.playersCatalog.length) {
      // Completed all players!
      this.finishAuction(room);
      return;
    }

    const player = room.playersCatalog[room.currentPlayerIndex];
    player.status = 'in_auction';

    const completedInSet = (player.lotInSet || 1) - 1;
    const remainingInSet = Math.max(1, (player.setTotal || 6) - completedInSet);
    const remainingInAuction = room.playersCatalog.filter((p, i) => i >= room.currentPlayerIndex && p && p.status !== 'sold' && p.status !== 'unsold' && p.status !== 'SKIPPED').length;
    const currentRound = player.round;
    const currentProfile = player.profile;
    const remainingInRound = room.playersCatalog.filter((p, i) => i >= room.currentPlayerIndex && p && (currentRound === undefined || p.round === currentRound) && (currentProfile === undefined || p.profile === currentProfile) && p.status !== 'sold' && p.status !== 'unsold' && p.status !== 'SKIPPED').length;
    const nextPlayerObj = room.playersCatalog[room.currentPlayerIndex + 1] || null;

    room.currentLot = {
      player,
      lotNumber: room.currentPlayerIndex + 1,
      totalLots: room.playersCatalog.length,
      profile: player.profile || 'standard',
      profileTitle: player.profileTitle || 'AUCTION',
      round: player.round || 1,
      category: player.category,
      categoryTitle: player.categoryTitle,
      setName: player.setName,
      setNumber: player.setNumber,
      lotInSet: player.lotInSet,
      setTotal: player.setTotal,
      completedInSet,
      remainingInSet,
      remainingInRound,
      remainingInAuction,
      nextPlayer: nextPlayerObj ? {
        id: nextPlayerObj.id,
        name: nextPlayerObj.name,
        category: nextPlayerObj.category,
        role: nextPlayerObj.role,
        imageUrl: nextPlayerObj.imageUrl
      } : null,
      highestBid: 0,
      highestBidderFranchiseId: null,
      highestBidderName: null,
      nextValidBid: player.basePrice,
      countdown: room.config.timerDuration,
      stateVersion: 1,
      bidHistory: [],
      hammerStatus: 'OPEN' // 'OPEN' | 'GOING_ONCE' | 'GOING_TWICE' | 'SOLD' | 'UNSOLD'
    };

    this.addAuditLog(
      room,
      'LOT_PRESENTED',
      `Lot #${room.currentLot.lotNumber}: ${player.name} (${player.category} - ${player.setName}) presented with base price ₹${player.basePrice} Cr`
    );
    this.scheduleSave(room); // persist: queue advanced to next lot

    this.broadcastRoomState(room, 'lot_presented');
    this.startRoomTimer(room);
  }

  // The interval is bound to the lot it was started for: a stale callback (a lot that was
  // replaced, or a room object that is no longer the live one) stops itself instead of ticking.
  startRoomTimer(room) {
    const code = room.roomCode;
    this.clearRoomTimer(code);
    const lot = room.currentLot;
    const intervalId = setInterval(() => {
      if (room.currentLot !== lot || this.rooms.get(code) !== room) {
        clearInterval(intervalId);
        if (this.timerIntervals.get(code) === intervalId) this.timerIntervals.delete(code);
        return;
      }
      this.tickRoom(room);
    }, 1000);
    this.timerIntervals.set(code, intervalId);
  }

  // One second of the server-authoritative clock. Ticks are deliberately NOT persisted
  // (no disk write per second); see recoverAfterRestart for the restart rule.
  tickRoom(room) {
    if (room.status !== 'active') return;

    const lot = room.currentLot;
    if (!lot || !isLotOpen(lot)) return;

    lot.countdown--;

    // Hammer callouts near the end of the countdown
    if (lot.highestBid > 0) {
      if (lot.countdown === 7) lot.hammerStatus = 'GOING_ONCE';
      if (lot.countdown === 3) lot.hammerStatus = 'GOING_TWICE';
    }

    if (lot.countdown <= 0) {
      this.closeCurrentLot(room);
    } else {
      this.emitToRoom(room, 'timer_tick', {
        countdown: lot.countdown,
        hammerStatus: lot.hammerStatus,
        stateVersion: lot.stateVersion
      });
    }
  }

  clearRoomTimer(roomCode) {
    if (this.timerIntervals.has(roomCode)) {
      clearInterval(this.timerIntervals.get(roomCode));
      this.timerIntervals.delete(roomCode);
    }
  }

  clearAdvanceTimeout(roomCode) {
    if (this.advanceTimeouts.has(roomCode)) {
      clearTimeout(this.advanceTimeouts.get(roomCode));
      this.advanceTimeouts.delete(roomCode);
    }
  }

  placeBid({ roomCode, participantToken, franchiseId, bidAmount, expectedVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };

    const participant = room.participants.get(participantToken);
    if (!participant || participant.franchiseId !== franchiseId) {
      return { success: false, error: 'You can only bid for your own assigned franchise' };
    }

    // Atomic bid validation
    const validation = validateBid({
      room,
      franchiseId,
      bidAmount,
      expectedVersion
    });

    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const lot = room.currentLot;
    const franchise = room.franchises[franchiseId];

    // Concurrency lock: Update lot state version atomically
    lot.stateVersion++;
    lot.highestBid = validation.validNextAmount;
    lot.highestBidderFranchiseId = franchiseId;
    lot.highestBidderName = franchise.name;
    lot.nextValidBid = calculateNextBid(lot.highestBid, lot.player.basePrice);
    lot.countdown = room.config.timerDuration; // Reset countdown
    lot.hammerStatus = 'OPEN';

    const bidRecord = {
      bidId: `BID_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      lotNumber: lot.lotNumber,
      playerId: lot.player.id,
      playerName: lot.player.name,
      franchiseId,
      franchiseCode: franchise.code,
      franchiseName: franchise.name,
      bidAmount: lot.highestBid,
      timestamp: new Date().toISOString(),
      participantName: participant.name,
      stateVersion: lot.stateVersion
    };

    lot.bidHistory.push(bidRecord);
    room.allBids.push(bidRecord);

    this.addAuditLog(
      room,
      'BID_ACCEPTED',
      `${franchise.code} placed bid of ₹${lot.highestBid.toFixed(2)} Cr on ${lot.player.name}`
    );
    this.scheduleSave(room); // persist: bid accepted

    // Broadcast bid accepted event immediately to all clients with sound trigger
    this.emitToRoom(room, 'bid_accepted', {
      bid: bidRecord,
      currentLot: lot,
      nextValidBid: lot.nextValidBid,
      franchises: toPublicFranchises(room.franchises)
    });

    return { success: true };
  }

  closeCurrentLot(room) {
    this.clearRoomTimer(room.roomCode);

    const lot = room.currentLot;
    if (!lot) return;
    // Idempotent: a lot can only be hammered once (timer expiry, host advance and
    // resume can otherwise race and sell the same player twice)
    if (!isLotOpen(lot)) return;
    lot.closed = true;

    const player = lot.player;

    if (lot.highestBidderFranchiseId && lot.highestBid > 0) {
      // SOLD!
      lot.hammerStatus = 'SOLD';
      player.status = 'sold';
      player.soldTo = lot.highestBidderFranchiseId;
      player.soldPrice = lot.highestBid;

      const winningFranchise = room.franchises[lot.highestBidderFranchiseId];
      // Exact (integer lakhs); deducted exactly once (this block runs once per lot, see isLotOpen)
      winningFranchise.remainingPurse = fromLakh(toLakh(winningFranchise.remainingPurse) - toLakh(lot.highestBid));
      winningFranchise.totalSpent = fromLakh(toLakh(winningFranchise.totalSpent || 0) + toLakh(lot.highestBid));

      winningFranchise.squad.push({
        ...player,
        boughtPrice: lot.highestBid
      });

      if (player.isOverseas) {
        winningFranchise.overseasCount++;
      }

      // Check financial elimination for all claimed franchises
      for (const f of Object.values(room.franchises)) {
        if (f.isClaimed && !f.isEliminated) {
          const elimCheck = checkFinancialElimination(f, room.config, reserveFloorLakh(room));
          if (elimCheck.isEliminated) {
            f.isEliminated = true;
            f.eliminationReason = elimCheck.reason;
            this.addAuditLog(
              room,
              'FINANCIAL_ELIMINATION',
              `${f.name} is FINANCIALLY ELIMINATED: ${elimCheck.reason}`
            );
          }
        }
      }

      const historyEntry = {
        lotNumber: lot.lotNumber,
        player,
        status: 'SOLD',
        winningFranchiseId: winningFranchise.id,
        winningFranchiseName: winningFranchise.name,
        winningFranchiseCode: winningFranchise.code,
        finalBid: lot.highestBid,
        bidsCount: lot.bidHistory.length,
        timestamp: new Date().toISOString()
      };

      room.history.unshift(historyEntry);

      this.addAuditLog(
        room,
        'PLAYER_SOLD',
        `SOLD! ${player.name} bought by ${winningFranchise.name} for ₹${lot.highestBid.toFixed(2)} Cr`
      );
      this.scheduleSave(room); // persist: SOLD result

      this.emitToRoom(room, 'lot_completed', {
        result: 'SOLD',
        lot: lot,
        historyEntry,
        franchises: toPublicFranchises(room.franchises),
        playersCatalog: room.playersCatalog
      });
    } else {
      // UNSOLD
      lot.hammerStatus = 'UNSOLD';
      player.status = 'unsold';

      const historyEntry = {
        lotNumber: lot.lotNumber,
        player,
        status: 'UNSOLD',
        winningFranchiseId: null,
        winningFranchiseName: null,
        finalBid: 0,
        bidsCount: 0,
        timestamp: new Date().toISOString()
      };

      room.history.unshift(historyEntry);

      this.addAuditLog(room, 'PLAYER_UNSOLD', `${player.name} went UNSOLD at base price ₹${player.basePrice} Cr`);
      this.scheduleSave(room); // persist: UNSOLD result

      this.emitToRoom(room, 'lot_completed', {
        result: 'UNSOLD',
        lot: lot,
        historyEntry,
        franchises: toPublicFranchises(room.franchises),
        playersCatalog: room.playersCatalog
      });
    }

    // Auto advance to next player after configured delay (e.g. 4 seconds).
    // Tracked so a host advance / skip / resume in the gap cancels it (no double advance).
    this.clearAdvanceTimeout(room.roomCode);
    const advance = setTimeout(() => {
      this.advanceTimeouts.delete(room.roomCode);
      if (room.status === 'active' && room.currentLot === lot) {
        this.nextPlayer(room);
      }
    }, room.config.autoAdvanceDelay * 1000);
    if (advance.unref) advance.unref();
    this.advanceTimeouts.set(room.roomCode, advance);
  }

  finishAuction(room) {
    // A forced finish resolves the open lot first (sold to the highest bidder, else unsold)
    // instead of abandoning a live bid and leaving the player "in auction" forever.
    if (room.currentLot && isLotOpen(room.currentLot)) this.closeCurrentLot(room);
    this.clearRoomTimer(room.roomCode);
    this.clearAdvanceTimeout(room.roomCode);
    room.status = 'completed';
    room.currentLot = null;

    // Post-auction Cricket Mastermind evaluation snapshot (deterministic, saved once, never recomputed)
    room.analysis = evaluateAuction(room);

    // Backward-compatible evaluationResults aligned with Cricket Mastermind
    const activeFranchises = Object.values(room.franchises).filter(f => f.isClaimed);
    const initialPurse = activeFranchises[0]?.initialPurse || room.config.basePurse;

    const evaluations = activeFranchises.map(f =>
      evaluateFranchiseSquad(f, room.config, initialPurse)
    );

    const rankingResult = rankFranchises(evaluations);
    if (room.analysis?.rankings?.length) {
      rankingResult.podium = room.analysis.rankings.slice(0, 3).map(r => ({
        franchiseId: r.franchiseId,
        franchiseName: r.franchiseName,
        rank: r.rank
      }));
    }
    room.evaluationResults = rankingResult;

    const winnerAnnounced = room.analysis?.verdict?.winnerFranchiseName || rankingResult.podium[0]?.franchiseName || 'No eligible team';
    this.addAuditLog(
      room,
      'AUCTION_FINISHED',
      `Auction complete! Winner: ${winnerAnnounced}`
    );
    this.scheduleSave(room); // persist: auction completed

    this.broadcastRoomState(room, 'auction_completed');
  }

  skipOrAdvanceLot({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room || room.hostToken !== hostToken) return { success: false, error: 'Unauthorized' };

    if (room.currentLot && room.status === 'active') {
      if (isLotOpen(room.currentLot)) {
        this.closeCurrentLot(room);
      } else {
        // Hammer already fell: "advance" means present the next player now
        this.nextPlayer(room);
      }
      return { success: true };
    }
    return { success: false, error: 'Cannot advance lot right now' };
  }

  skipCurrentSet({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };
    if (room.hostToken !== hostToken) return { success: false, error: 'Only the auction host can skip player sets' };
    if (room.status !== 'active') return { success: false, error: 'Auction is not currently active' };

    if (room.isSkippingSet) {
      return { success: false, error: 'Set skip is already in progress' };
    }
    room.isSkippingSet = true;

    try {
      const currentLot = room.currentLot;
      if (!currentLot || !currentLot.player) {
        room.isSkippingSet = false;
        return { success: false, error: 'No active player set to skip' };
      }

      // Stop current timer immediately
      this.clearRoomTimer(room.roomCode);

      const currentSetKey = currentLot.player.categorySet || currentLot.player.setName;
      const currentSetName = currentLot.player.setName || currentSetKey;

      let skippedCount = 0;
      const skippedPlayers = [];

      // Mark current player and all remaining unauctioned players in this set as SKIPPED
      for (let i = room.currentPlayerIndex; i < room.playersCatalog.length; i++) {
        const p = room.playersCatalog[i];
        const pSetKey = p.categorySet || p.setName;
        if (pSetKey === currentSetKey || p.setName === currentSetName) {
          if (p.status !== 'sold' && p.status !== 'unsold' && p.status !== 'SKIPPED') {
            p.status = 'SKIPPED';
            skippedCount++;
            skippedPlayers.push(p);

            const historyEntry = {
              lotNumber: p.overallLot || (i + 1),
              player: p,
              status: 'SKIPPED',
              winningFranchiseId: null,
              winningFranchiseName: null,
              finalBid: 0,
              bidsCount: 0,
              timestamp: new Date().toISOString()
            };
            room.history.unshift(historyEntry);
          }
        }
      }

      this.addAuditLog(
        room,
        'SET_SKIPPED',
        `Host skipped remaining players in set "${currentSetName}". (${skippedCount} player(s) marked as SKIPPED)`
      );
      this.scheduleSave(room); // persist: set skipped

      // Find next player index with a different set that is still available
      let nextIdx = -1;
      for (let i = room.currentPlayerIndex; i < room.playersCatalog.length; i++) {
        const p = room.playersCatalog[i];
        if (p.status !== 'sold' && p.status !== 'unsold' && p.status !== 'SKIPPED') {
          nextIdx = i;
          break;
        }
      }

      this.saveToStorage(room);

      // Emit set_skipped event to all clients so UI updates immediately
      this.emitToRoom(room, 'set_skipped', {
        skippedSetName: currentSetName,
        skippedCount,
        playersCatalog: room.playersCatalog,
        history: room.history
      });

      if (nextIdx === -1) {
        room.isSkippingSet = false;
        this.finishAuction(room);
        return {
          success: true,
          skippedSet: currentSetKey,
          skippedSetName: currentSetName,
          skippedCount,
          message: 'All sets completed. Auction concluded.'
        };
      } else {
        room.currentPlayerIndex = nextIdx - 1;
        room.isSkippingSet = false;
        this.nextPlayer(room);
        return {
          success: true,
          skippedSet: currentSetKey,
          skippedSetName: currentSetName,
          skippedCount
        };
      }
    } catch (err) {
      room.isSkippingSet = false;
      return { success: false, error: err.message };
    }
  }

  addAuditLog(room, type, message) {
    appendAuditEntry(room, type, message);
    if (this.store) this.store.noteAudit(room.roomCode, room.auditLog[0]);
  }

  broadcastRoomState(room, event = 'state_updated') {
    const publicState = this.getPublicRoomState(room);
    this.emitToRoom(room, event, publicState);
  }

  getPublicRoomState(room) {
    return {
      roomCode: room.roomCode,
      status: room.status,
      hostName: room.hostName,
      config: room.config,
      franchises: toPublicFranchises(room.franchises),
      playingXIConfigurations: room.playingXIConfigurations || {},
      currentLot: room.currentLot,
      lotNumber: room.currentLot?.lotNumber || 0,
      totalLots: room.playersCatalog.length,
      currentPlayerIndex: room.currentPlayerIndex,
      playersCatalog: room.playersCatalog,
      history: room.history,
      recentBids: room.allBids.slice(-15),
      auditLog: room.auditLog.slice(0, 30),
      evaluationResults: room.evaluationResults,
      ...(room.status === 'completed' ? { analysis: room.analysis || null, aiAnalysis: this.publicAiAnalysis(room) } : {})
    };
  }

  // ── post-auction AI analysis ────────────────────────────────────────────
  publicAiAnalysis(room) {
    const a = room.aiAnalysis;
    const cfg = aiConfig(this.aiEnv || process.env);
    return {
      available: cfg.enabled,
      generating: this.aiInFlight.has(room.roomCode),
      status: a?.status || 'none',
      model: a?.model || null,
      completedAt: a?.completedAt || null,
      attempts: a?.attempts || 0,
      result: a?.result || null,
      problems: a?.problems || [],
      lastError: a?.lastError ? { code: a.lastError.code, message: a.lastError.message } : null
    };
  }

  /**
   * Ask for AI reports for a completed auction. Never runs during an auction. Deduplicated:
   * a ready report is returned from storage, a running generation is joined (single flight per
   * room), regeneration is host-only with a cooldown and a per-room attempt cap, and at most
   * AI_MAX_CONCURRENT generations run server-wide. The deterministic snapshot is never changed.
   */
  requestAiAnalysis({ roomCode, participantToken, force = false }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };
    if (!room.participants.has(participantToken)) return { success: false, error: 'You are not a participant of this room' };
    if (room.status !== 'completed') return { success: false, error: 'AI analysis is available only after the auction has finished' };
    if (ensureAnalysisSnapshot(room)) this.scheduleSave(room);
    const cfg = aiConfig(this.aiEnv || process.env);
    if (!cfg.enabled) return { success: true, status: 'unavailable', message: 'AI analysis is not configured on this server. The rule-based analysis is shown instead.' };
    const code = room.roomCode;
    if (this.aiInFlight.has(code)) return { success: true, status: 'generating' };
    const prev = room.aiAnalysis;
    const fresh = prev?.status === 'ready' && prev.evaluationChecksum === room.analysis.inputChecksum;
    if (fresh && !force) return { success: true, status: 'ready', cached: true };
    if (force && room.hostToken !== participantToken) return { success: false, error: 'Only the host can regenerate the AI analysis' };
    const env = this.aiEnv || process.env;
    const cooldownMs = Number.parseInt(env.AI_REGENERATE_COOLDOWN_MS ?? '60000', 10);
    const maxAttempts = Number.parseInt(env.AI_MAX_ATTEMPTS_PER_ROOM ?? '5', 10);
    const maxConcurrent = Number.parseInt(env.AI_MAX_CONCURRENT ?? '2', 10);
    if (prev?.lastAttemptAt && Date.now() - Date.parse(prev.lastAttemptAt) < cooldownMs) {
      const retryAfterSec = Math.ceil((cooldownMs - (Date.now() - Date.parse(prev.lastAttemptAt))) / 1000);
      return { success: false, code: 'RATE_LIMITED', retryAfterSec, error: `Please wait ${retryAfterSec}s before requesting the AI analysis again` };
    }
    if ((prev?.attempts || 0) >= maxAttempts) return { success: false, code: 'LIMIT_REACHED', error: `The AI analysis limit for this room (${maxAttempts} attempts) has been reached` };
    if (this.aiActive >= maxConcurrent) return { success: false, code: 'RATE_LIMITED', retryAfterSec: 10, error: 'The AI service is busy. Please retry in a few seconds.' };

    const analysis = room.analysis;
    const attempts = (prev?.attempts || 0) + 1;
    const lastAttemptAt = new Date().toISOString();
    this.aiActive++;
    const job = generateAiAnalysis(room, analysis, cfg, this.aiDeps || {})
      .then(({ result, problems }) => {
        room.aiAnalysis = { status: 'ready', model: cfg.model, evaluationChecksum: analysis.inputChecksum, attempts, lastAttemptAt, completedAt: new Date().toISOString(), result, problems, lastError: null };
        this.addAuditLog(room, 'AI_ANALYSIS_READY', `AI reports generated (${cfg.model}).`);
      })
      .catch(err => {
        const lastError = { code: err.code || 'ERROR', message: String(err.message || err).slice(0, 300), at: new Date().toISOString() };
        console.error(`[analysis] AI generation failed for room ${code}: ${lastError.code}`);
        // A failed regeneration keeps the previous good report
        room.aiAnalysis = prev?.status === 'ready'
          ? { ...prev, attempts, lastAttemptAt, lastError }
          : { status: 'failed', model: cfg.model, evaluationChecksum: analysis.inputChecksum, attempts, lastAttemptAt, completedAt: null, result: null, problems: [], lastError };
        this.addAuditLog(room, 'AI_ANALYSIS_FAILED', `AI reports could not be generated (${lastError.code}); rule-based analysis remains available.`);
      })
      .finally(() => {
        this.aiActive--;
        this.aiInFlight.delete(code);
        this.scheduleSave(room);
        this.broadcastRoomState(room, 'analysis_updated');
      });
    this.aiInFlight.set(code, job);
    this.broadcastRoomState(room, 'analysis_updated');
    return { success: true, status: 'generating' };
  }
}
