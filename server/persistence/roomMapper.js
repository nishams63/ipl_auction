// Room object  <->  normalized PostgreSQL rows.
//
// Pure functions (no database access) so they can be unit-tested and reused by the live store
// and the JSON importer.
//
// Lossless by design:
//  * fields without a dedicated column (including unknown legacy fields) go to the row's jsonb
//    column (extra / profile / snapshot / details / overrides);
//  * a field that was ABSENT is recorded in "$absent" so it is not re-created as null;
//  * a timestamp that is not a canonical ISO string, or an optional value of an unexpected
//    type, is kept verbatim in jsonb instead of being coerced.
// Deliberate normalizations (documented, tested):
//  * raw session tokens are replaced by a one-way hash; in memory they become "hash:<hex>"
//    until the owner reconnects (see RoomManager.claimHashedSession);
//  * socket ids (participant.socketId, franchise.ownerSocketId) are connection-scoped and are
//    restored as null;
//  * memory keeps the newest 200 audit entries; the database keeps all of them;
//  * isSkippingSet is a transient in-process flag and is not stored.
// A value that cannot be stored faithfully in a REQUIRED column raises MappingError; callers
// quarantine the room instead of guessing.
import { tokenHashOf, HASH_PREFIX } from './tokenHash.js';

export const AUDIT_MEMORY_LIMIT = 200;
const ABSENT = '$absent';

export class MappingError extends Error {
  constructor(where, message) {
    super(`${where}: ${message}`);
    this.name = 'MappingError';
    this.where = where;
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

// Deterministic JSON (sorted keys) for comparisons and change fingerprints
export function stableStringify(v) {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (v instanceof Map) return stableStringify([...v.entries()]);
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
const sameValue = (a, b) => a === b || stableStringify(a) === stableStringify(b);

export function isCanonicalIso(s) {
  if (typeof s !== 'string') return false;
  const t = Date.parse(s);
  return !Number.isNaN(t) && new Date(t).toISOString() === s;
}

function kindOk(v, kind) {
  switch (kind) {
    case 'text': return typeof v === 'string' && !v.includes('\u0000');
    case 'int': return Number.isInteger(v) && Math.abs(v) <= 2147483647;
    case 'num': return typeof v === 'number' && Number.isFinite(v);
    case 'bool': return typeof v === 'boolean';
    case 'json': return true;
    default: throw new Error(`unknown kind ${kind}`);
  }
}

/**
 * Split obj into column values and a jsonb remainder.
 * spec: [[key, kind, required]]; kind: text|int|num|bool|json|ts.
 * exclude: keys handled elsewhere (not copied into the remainder).
 */
function split(obj, spec, where, exclude = []) {
  const values = {};
  const rest = {};
  const absent = [];
  const specKeys = new Set(spec.map(s => s[0]));
  for (const [key, kind, required] of spec) {
    if (!has(obj, key)) {
      if (required) throw new MappingError(`${where}.${key}`, 'required field is missing');
      values[key] = null;
      absent.push(key);
      continue;
    }
    const v = obj[key];
    if (v === null) {
      if (required) throw new MappingError(`${where}.${key}`, 'required field is null');
      values[key] = null;
      continue;
    }
    if (kind === 'ts') {
      if (isCanonicalIso(v)) values[key] = v;
      else { values[key] = null; rest[key] = v; } // kept verbatim
      continue;
    }
    if (!kindOk(v, kind)) {
      if (required) throw new MappingError(`${where}.${key}`, `expected ${kind}, got ${String(JSON.stringify(v)).slice(0, 80)}`);
      values[key] = null;
      rest[key] = v; // optional value of an unexpected type: kept verbatim
      continue;
    }
    values[key] = v;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (specKeys.has(k) || exclude.includes(k) || v === undefined) continue;
    rest[k] = v;
  }
  if (absent.length) rest[ABSENT] = absent;
  return { values, rest };
}

function addAbsent(rest, key) {
  (rest[ABSENT] ||= []).push(key);
}

// Inverse of split: column values, then the jsonb remainder on top, then remove absent keys
function merge(values, rest) {
  const out = { ...values };
  const r = { ...(rest || {}) };
  const absent = Array.isArray(r[ABSENT]) ? r[ABSENT] : [];
  delete r[ABSENT];
  Object.assign(out, r);
  for (const k of absent) delete out[k];
  return out;
}

// Fields of a squad entry that differ from what the sale would have produced
function diffOverrides(actual, expected) {
  const set = {};
  const unset = [];
  for (const [k, v] of Object.entries(actual)) {
    if (v === undefined) continue;
    if (!has(expected, k) || !sameValue(v, expected[k])) set[k] = v;
  }
  for (const k of Object.keys(expected)) if (!has(actual, k)) unset.push(k);
  const o = {};
  if (Object.keys(set).length) o.set = set;
  if (unset.length) o.unset = unset;
  return o;
}
function applyOverrides(expected, o) {
  const out = { ...expected, ...(o?.set || {}) };
  for (const k of o?.unset || []) delete out[k];
  return out;
}

const PLAYER_LIVE_FIELDS = ['status', 'soldTo', 'soldPrice'];
function staticPart(p) {
  const s = { ...p };
  for (const k of PLAYER_LIVE_FIELDS) delete s[k];
  return s;
}
// What closeCurrentLot pushes into franchise.squad for a sale
function expectedSquadEntry(catalogueEntry, franchiseId, boughtPrice) {
  return { ...staticPart(catalogueEntry), status: 'sold', soldTo: franchiseId, soldPrice: boughtPrice, boughtPrice };
}

const ROOM_SPEC = [
  ['status', 'text', true], ['hostName', 'text'], ['config', 'json', true],
  ['currentPlayerIndex', 'int', true], ['evaluationResults', 'json'], ['auditSeq', 'int'], ['createdAt', 'ts']
];
const ROOM_STRUCTURAL = ['roomCode', 'hostToken', 'playersCatalog', 'currentLot', 'franchises',
  'playingXIConfigurations', 'participants', 'history', 'allBids', 'auditLog', 'isSkippingSet', 'storageHold'];
const PLAYER_SPEC = [['status', 'text'], ['soldTo', 'text'], ['soldPrice', 'num']];
const PARTICIPANT_SPEC = [['publicId', 'text', true], ['name', 'text'], ['franchiseId', 'text'], ['isHost', 'bool']];
const FRANCHISE_SPEC = [
  ['isClaimed', 'bool'], ['ownerId', 'text'], ['ownerName', 'text'], ['initialPurse', 'num', true],
  ['remainingPurse', 'num', true], ['totalSpent', 'num'], ['overseasCount', 'int'],
  ['isEliminated', 'bool'], ['eliminationReason', 'text']
];
const FRANCHISE_LINEUP_FIELDS = ['playingXI', 'captainId', 'viceCaptainId', 'wicketKeeperId', 'impactPlayerId', 'isConfirmed'];
const LINEUP_SPEC = [
  ['captainId', 'text'], ['viceCaptainId', 'text'], ['wicketKeeperId', 'text'],
  ['impactPlayerId', 'text'], ['isConfirmed', 'bool'], ['confirmedAt', 'ts']
];
const BID_SPEC = [
  ['bidId', 'text', true], ['lotNumber', 'int'], ['playerId', 'text', true], ['franchiseId', 'text', true],
  ['bidAmount', 'num', true], ['stateVersion', 'int', true], ['timestamp', 'ts']
];
const RESULT_SPEC = [
  ['lotNumber', 'int'], ['status', 'text', true], ['winningFranchiseId', 'text'],
  ['finalBid', 'num'], ['bidsCount', 'int'], ['timestamp', 'ts']
];
const AUDIT_SPEC = [['seq', 'int', true], ['timestamp', 'ts'], ['type', 'text'], ['message', 'text']];

// Table layouts used by the store for INSERT/UPSERT (column order = parameter order)
export const TABLES = {
  rooms: {
    pk: ['room_code'],
    cols: ['room_code', 'status', 'host_name', 'host_token_hash', 'config', 'current_player_index', 'current_lot',
      'current_lot_player_id', 'evaluation_results', 'audit_seq', 'extra', 'created_at'],
    json: ['config', 'current_lot', 'evaluation_results', 'extra']
  },
  franchises: {
    pk: ['room_code', 'franchise_id'],
    cols: ['room_code', 'franchise_id', 'display_order', 'is_claimed', 'owner_token_hash', 'owner_public_id', 'owner_name',
      'initial_purse', 'remaining_purse', 'total_spent', 'overseas_count', 'is_eliminated', 'elimination_reason', 'profile'],
    json: ['profile']
  },
  participants: {
    pk: ['room_code', 'token_hash'],
    cols: ['room_code', 'token_hash', 'public_id', 'join_order', 'name', 'franchise_id', 'is_host', 'extra'],
    json: ['extra']
  },
  room_players: {
    pk: ['room_code', 'player_id'],
    cols: ['room_code', 'player_id', 'position', 'snapshot', 'status', 'sold_to', 'sold_price'],
    json: ['snapshot']
  },
  squad_entries: {
    pk: ['room_code', 'player_id'],
    cols: ['room_code', 'player_id', 'franchise_id', 'acquired_order', 'bought_price', 'overrides'],
    json: ['overrides']
  },
  lineups: {
    pk: ['room_code', 'franchise_id', 'kind'],
    cols: ['room_code', 'franchise_id', 'kind', 'captain_id', 'vice_captain_id', 'wicket_keeper_id', 'impact_player_id',
      'is_confirmed', 'confirmed_at', 'details'],
    json: ['details']
  },
  lineup_players: {
    pk: ['room_code', 'franchise_id', 'kind', 'slot'],
    cols: ['room_code', 'franchise_id', 'kind', 'slot', 'player_id'],
    json: []
  },
  bids: {
    pk: ['room_code', 'seq'],
    cols: ['room_code', 'seq', 'bid_id', 'lot_number', 'player_id', 'franchise_id', 'amount', 'state_version', 'placed_at', 'details'],
    json: ['details']
  },
  lot_results: {
    pk: ['room_code', 'player_id'],
    cols: ['room_code', 'player_id', 'seq', 'status', 'lot_number', 'winning_franchise_id', 'final_bid', 'bids_count',
      'completed_at', 'details'],
    json: ['details']
  },
  audit_logs: {
    pk: ['room_code', 'seq'],
    cols: ['room_code', 'seq', 'logged_at', 'type', 'message', 'details'],
    json: ['details']
  }
};

export const fingerprint = row => stableStringify(row);

function lineupRow(code, fid, kind, rec, where, xiIdsOut) {
  const { values, rest } = split(rec, LINEUP_SPEC, where, ['playingXI']);
  let xi = null;
  if (!has(rec, 'playingXI')) addAbsent(rest, 'playingXI');
  else {
    xi = rec.playingXI;
    if (!Array.isArray(xi) || xi.length > 11 || xi.some(id => typeof id !== 'string') || new Set(xi).size !== xi.length) {
      throw new MappingError(`${where}.playingXI`, 'must be a list of at most 11 distinct player ids');
    }
  }
  xiIdsOut.push(...(xi || []));
  return {
    row: {
      room_code: code, franchise_id: fid, kind,
      captain_id: values.captainId, vice_captain_id: values.viceCaptainId, wicket_keeper_id: values.wicketKeeperId,
      impact_player_id: values.impactPlayerId, is_confirmed: values.isConfirmed, confirmed_at: values.confirmedAt,
      details: rest
    },
    players: (xi || []).map((pid, i) => ({ room_code: code, franchise_id: fid, kind, slot: i + 1, player_id: pid }))
  };
}

/** One audit entry → audit_logs row (also used for entries already trimmed from memory). */
export function auditEntryToRow(code, entry, where = 'auditLog[]') {
  if (!isPlainObject(entry)) throw new MappingError(where, 'not an object');
  const { values, rest } = split(entry, AUDIT_SPEC, where);
  if (values.seq < 1) throw new MappingError(`${where}.seq`, `invalid audit seq ${values.seq}`);
  return { room_code: code, seq: values.seq, logged_at: values.timestamp, type: values.type, message: values.message, details: rest };
}

/**
 * Convert one in-memory room into rows for every table.
 * Throws MappingError if the room cannot be stored faithfully.
 */
export function roomToRows(room, { env = process.env } = {}) {
  if (!isPlainObject(room)) throw new MappingError('room', 'not an object');
  const code = room.roomCode;
  if (typeof code !== 'string' || !/^[A-Z0-9]{4,12}$/.test(code)) {
    throw new MappingError('roomCode', `invalid room code ${JSON.stringify(code)}`);
  }

  // ── catalogue ──
  if (!Array.isArray(room.playersCatalog)) throw new MappingError('playersCatalog', 'not a list');
  const byId = new Map();
  const players = room.playersCatalog.map((p, i) => {
    const where = `playersCatalog[${i}]`;
    if (!isPlainObject(p)) throw new MappingError(where, 'not an object');
    if (typeof p.id !== 'string' || !p.id || p.id.includes('\u0000')) throw new MappingError(`${where}.id`, 'missing or invalid player id');
    if (byId.has(p.id)) throw new MappingError(where, `duplicate player id ${p.id}`);
    byId.set(p.id, p);
    const { values, rest } = split(p, PLAYER_SPEC, where, ['id']);
    return { room_code: code, player_id: p.id, position: i, snapshot: rest, status: values.status, sold_to: values.soldTo, sold_price: values.soldPrice };
  });

  // ── franchises, squads, lineups ──
  if (!isPlainObject(room.franchises)) throw new MappingError('franchises', 'not an object');
  const franchises = [];
  const squad = [];
  const lineups = [];
  const squadOwner = new Map();
  Object.entries(room.franchises).forEach(([fid, f], order) => {
    const where = `franchises.${fid}`;
    if (!isPlainObject(f)) throw new MappingError(where, 'not an object');
    const { values, rest } = split(f, FRANCHISE_SPEC, where, ['ownerToken', 'ownerSocketId', 'squad', ...FRANCHISE_LINEUP_FIELDS]);
    if (!has(f, 'ownerToken')) addAbsent(rest, 'ownerToken');
    if (!has(f, 'ownerSocketId')) addAbsent(rest, 'ownerSocketId');
    if (has(f, 'ownerToken') && f.ownerToken !== null && typeof f.ownerToken !== 'string') {
      throw new MappingError(`${where}.ownerToken`, 'not a string');
    }
    franchises.push({
      room_code: code, franchise_id: fid, display_order: order,
      is_claimed: values.isClaimed,
      owner_token_hash: f.ownerToken ? tokenHashOf(f.ownerToken, env) : null,
      owner_public_id: values.ownerId, owner_name: values.ownerName,
      initial_purse: values.initialPurse, remaining_purse: values.remainingPurse, total_spent: values.totalSpent,
      overseas_count: values.overseasCount, is_eliminated: values.isEliminated, elimination_reason: values.eliminationReason,
      profile: rest
    });

    if (!Array.isArray(f.squad)) throw new MappingError(`${where}.squad`, 'not a list');
    f.squad.forEach((e, i) => {
      const w = `${where}.squad[${i}]`;
      if (!isPlainObject(e) || typeof e.id !== 'string') throw new MappingError(w, 'invalid squad entry');
      const cat = byId.get(e.id);
      if (!cat) throw new MappingError(w, `player ${e.id} is not in this room's catalogue`);
      if (squadOwner.has(e.id)) {
        throw new MappingError(w, `player ${e.id} is already in the squad of ${squadOwner.get(e.id)} (duplicate sale)`);
      }
      squadOwner.set(e.id, fid);
      const bp = has(e, 'boughtPrice') ? e.boughtPrice : null;
      if (bp !== null && !kindOk(bp, 'num')) throw new MappingError(`${w}.boughtPrice`, 'not a number');
      squad.push({
        room_code: code, player_id: e.id, franchise_id: fid, acquired_order: i, bought_price: bp,
        overrides: diffOverrides(e, expectedSquadEntry(cat, fid, bp))
      });
    });

    const lineupRec = {};
    for (const k of FRANCHISE_LINEUP_FIELDS) if (has(f, k)) lineupRec[k] = f[k];
    lineups.push(lineupRow(code, fid, 'franchise', lineupRec, `${where}(lineup)`, []));
  });

  if (has(room, 'playingXIConfigurations')) {
    if (!isPlainObject(room.playingXIConfigurations)) throw new MappingError('playingXIConfigurations', 'not an object');
    for (const [fid, rec] of Object.entries(room.playingXIConfigurations)) {
      if (!isPlainObject(rec)) throw new MappingError(`playingXIConfigurations.${fid}`, 'not an object');
      lineups.push(lineupRow(code, fid, 'saved', rec, `playingXIConfigurations.${fid}`, []));
    }
  }

  // ── participants ──
  let entries;
  if (room.participants instanceof Map) entries = [...room.participants.entries()];
  else if (Array.isArray(room.participants)) entries = room.participants;
  else if (!has(room, 'participants')) entries = [];
  else throw new MappingError('participants', 'not a Map or list');
  const seenHashes = new Set();
  const participants = entries.map((entry, i) => {
    const where = `participants[${i}]`;
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0] || !isPlainObject(entry[1])) {
      throw new MappingError(where, 'invalid entry');
    }
    const [key, p] = entry;
    if (has(p, 'token') && p.token !== key) throw new MappingError(where, 'token field does not match its key');
    const hash = tokenHashOf(key, env);
    if (seenHashes.has(hash)) throw new MappingError(where, 'duplicate participant token');
    seenHashes.add(hash);
    const { values, rest } = split(p, PARTICIPANT_SPEC, where, ['token', 'socketId']);
    if (!has(p, 'token')) addAbsent(rest, 'token');
    if (!has(p, 'socketId')) addAbsent(rest, 'socketId');
    return {
      room_code: code, token_hash: hash, public_id: values.publicId, join_order: i, name: values.name,
      franchise_id: values.franchiseId, is_host: values.isHost, extra: rest
    };
  });

  // ── bids ──
  const allBids = has(room, 'allBids') ? room.allBids : [];
  if (!Array.isArray(allBids)) throw new MappingError('allBids', 'not a list');
  const bids = allBids.map((b, i) => {
    const where = `allBids[${i}]`;
    if (!isPlainObject(b)) throw new MappingError(where, 'not an object');
    const { values, rest } = split(b, BID_SPEC, where);
    return {
      room_code: code, seq: i, bid_id: values.bidId, lot_number: values.lotNumber, player_id: values.playerId,
      franchise_id: values.franchiseId, amount: values.bidAmount, state_version: values.stateVersion,
      placed_at: values.timestamp, details: rest
    };
  });

  // ── results (history is newest-first in memory; seq is completion order) ──
  const history = has(room, 'history') ? room.history : [];
  if (!Array.isArray(history)) throw new MappingError('history', 'not a list');
  const seenResults = new Set();
  const results = history.map((h, i) => {
    const where = `history[${i}]`;
    if (!isPlainObject(h)) throw new MappingError(where, 'not an object');
    const p = h.player;
    if (!isPlainObject(p) || typeof p.id !== 'string') throw new MappingError(`${where}.player`, 'missing player');
    if (!byId.has(p.id)) throw new MappingError(`${where}.player`, `player ${p.id} is not in this room's catalogue`);
    if (seenResults.has(p.id)) throw new MappingError(where, `player ${p.id} has more than one result (duplicate sale record)`);
    seenResults.add(p.id);
    const { values, rest } = split(h, RESULT_SPEC, where, ['player']);
    // Normally the very catalogue object; a differing legacy copy is kept verbatim
    if (p !== byId.get(p.id) && !sameValue(p, byId.get(p.id))) rest.$player = p;
    return {
      room_code: code, player_id: p.id, seq: history.length - 1 - i, status: values.status, lot_number: values.lotNumber,
      winning_franchise_id: values.winningFranchiseId, final_bid: values.finalBid, bids_count: values.bidsCount,
      completed_at: values.timestamp, details: rest
    };
  });

  // ── audit ──
  const auditLog = has(room, 'auditLog') ? room.auditLog : [];
  if (!Array.isArray(auditLog)) throw new MappingError('auditLog', 'not a list');
  const seenSeq = new Set();
  const audit = auditLog.map((a, i) => {
    const row = auditEntryToRow(code, a, `auditLog[${i}]`);
    if (seenSeq.has(row.seq)) throw new MappingError(`auditLog[${i}].seq`, `duplicate audit seq ${row.seq}`);
    seenSeq.add(row.seq);
    return row;
  });

  // ── room row (current lot stored without the player object / bid history) ──
  const { values, rest } = split(room, ROOM_SPEC, 'room', ROOM_STRUCTURAL);
  for (const k of ['hostToken', 'currentLot', 'playingXIConfigurations', 'participants', 'history', 'allBids', 'auditLog']) {
    if (!has(room, k)) addAbsent(rest, k);
  }
  if (has(room, 'hostToken') && room.hostToken !== null && typeof room.hostToken !== 'string') {
    throw new MappingError('hostToken', 'not a string');
  }
  let currentLot = null;
  let currentLotPlayerId = null;
  if (has(room, 'currentLot') && room.currentLot !== null) {
    const lot = room.currentLot;
    if (!isPlainObject(lot)) throw new MappingError('currentLot', 'not an object');
    currentLot = { ...lot };
    delete currentLot.player;
    delete currentLot.bidHistory;
    if (!has(lot, 'player')) currentLot.$noPlayer = true;
    else if (isPlainObject(lot.player) && typeof lot.player.id === 'string' && byId.has(lot.player.id) &&
      (lot.player === byId.get(lot.player.id) || sameValue(lot.player, byId.get(lot.player.id)))) {
      currentLotPlayerId = lot.player.id;
    } else {
      currentLot.$player = lot.player; // not linkable to the catalogue: kept verbatim
    }
    if (has(lot, 'bidHistory')) {
      const derived = currentLotPlayerId
        ? allBids.filter(b => b && b.playerId === currentLotPlayerId && b.lotNumber === lot.lotNumber)
        : null;
      if (derived && sameValue(lot.bidHistory, derived)) currentLot.$bidHistoryFromBids = true;
      else currentLot.$bidHistory = lot.bidHistory;
    }
  }

  const roomRow = {
    room_code: code, status: values.status, host_name: values.hostName,
    host_token_hash: room.hostToken ? tokenHashOf(room.hostToken, env) : null,
    config: values.config, current_player_index: values.currentPlayerIndex,
    current_lot: currentLot, current_lot_player_id: currentLotPlayerId,
    evaluation_results: values.evaluationResults, audit_seq: values.auditSeq, extra: rest, created_at: values.createdAt
  };

  return {
    code,
    room: roomRow,
    franchises,
    participants,
    room_players: players,
    squad_entries: squad,
    lineups,
    bids,
    lot_results: results,
    audit_logs: audit
  };
}

// ── rows → room ─────────────────────────────────────────────────────────
const num = v => (v === null || v === undefined ? null : Number(v));
const ts = v => (v === null || v === undefined ? null : (v instanceof Date ? v : new Date(v)).toISOString());

/**
 * Rebuild an in-memory room from the rows of one room.
 * data: { room, franchises, participants, room_players, squad_entries, lineups, lineup_players, bids, lot_results, audit_logs }
 * (raw pg rows: numeric as strings, timestamptz as Date)
 */
export function rowsToRoom(data) {
  const r = data.room;
  const code = r.room_code;
  const sortBy = (arr, key) => [...(arr || [])].sort((a, b) => Number(a[key]) - Number(b[key]));

  const playersCatalog = sortBy(data.room_players, 'position').map(row =>
    merge({ id: row.player_id, status: row.status, soldTo: row.sold_to, soldPrice: num(row.sold_price) }, row.snapshot));
  const byId = new Map(playersCatalog.map(p => [p.id, p]));

  const allBids = sortBy(data.bids, 'seq').map(row => merge({
    bidId: row.bid_id, lotNumber: row.lot_number, playerId: row.player_id, franchiseId: row.franchise_id,
    bidAmount: num(row.amount), stateVersion: row.state_version, timestamp: ts(row.placed_at)
  }, row.details));

  // lineups with their ordered players
  const xiByKey = new Map();
  for (const lp of sortBy(data.lineup_players, 'slot')) {
    const k = `${lp.franchise_id}|${lp.kind}`;
    if (!xiByKey.has(k)) xiByKey.set(k, []);
    xiByKey.get(k).push(lp.player_id);
  }
  const lineupObj = row => merge({
    playingXI: xiByKey.get(`${row.franchise_id}|${row.kind}`) || [],
    captainId: row.captain_id, viceCaptainId: row.vice_captain_id, wicketKeeperId: row.wicket_keeper_id,
    impactPlayerId: row.impact_player_id, isConfirmed: row.is_confirmed, confirmedAt: ts(row.confirmed_at)
  }, row.details);
  const lineupsBy = new Map((data.lineups || []).map(l => [`${l.franchise_id}|${l.kind}`, l]));

  const squadBy = new Map();
  for (const s of sortBy(data.squad_entries, 'acquired_order')) {
    if (!squadBy.has(s.franchise_id)) squadBy.set(s.franchise_id, []);
    const cat = byId.get(s.player_id);
    const bp = num(s.bought_price);
    squadBy.get(s.franchise_id).push(applyOverrides(expectedSquadEntry(cat, s.franchise_id, bp), s.overrides));
  }

  const franchises = {};
  const franchiseOrder = sortBy(data.franchises, 'display_order');
  for (const f of franchiseOrder) {
    const fr = merge({
      isClaimed: f.is_claimed,
      ownerToken: f.owner_token_hash ? HASH_PREFIX + f.owner_token_hash : null,
      ownerId: f.owner_public_id, ownerName: f.owner_name, ownerSocketId: null,
      initialPurse: num(f.initial_purse), remainingPurse: num(f.remaining_purse), totalSpent: num(f.total_spent),
      overseasCount: f.overseas_count, isEliminated: f.is_eliminated, eliminationReason: f.elimination_reason,
      squad: squadBy.get(f.franchise_id) || []
    }, f.profile);
    const l = lineupsBy.get(`${f.franchise_id}|franchise`);
    // absent lineup fields (e.g. confirmedAt, which franchises normally lack) are removed by merge
    if (l) Object.assign(fr, lineupObj(l));
    franchises[f.franchise_id] = fr;
  }

  const playingXIConfigurations = {};
  for (const l of [...(data.lineups || [])].filter(x => x.kind === 'saved')
    .sort((a, b) => {
      const oa = franchiseOrder.findIndex(f => f.franchise_id === a.franchise_id);
      const ob = franchiseOrder.findIndex(f => f.franchise_id === b.franchise_id);
      return oa - ob || String(a.franchise_id).localeCompare(String(b.franchise_id));
    })) {
    playingXIConfigurations[l.franchise_id] = lineupObj(l);
  }

  const participants = new Map(sortBy(data.participants, 'join_order').map(p => {
    const key = HASH_PREFIX + p.token_hash;
    return [key, merge({
      token: key, publicId: p.public_id, name: p.name, socketId: null, franchiseId: p.franchise_id, isHost: p.is_host
    }, p.extra)];
  }));

  const history = sortBy(data.lot_results, 'seq').reverse().map(row => {
    const details = { ...(row.details || {}) };
    const hasVerbatim = has(details, '$player');
    const player = hasVerbatim ? details.$player : byId.get(row.player_id);
    delete details.$player;
    return merge({
      lotNumber: row.lot_number, player, status: row.status, winningFranchiseId: row.winning_franchise_id,
      finalBid: num(row.final_bid), bidsCount: row.bids_count, timestamp: ts(row.completed_at)
    }, details);
  });

  const auditLog = sortBy(data.audit_logs, 'seq').reverse().slice(0, AUDIT_MEMORY_LIMIT)
    .map(row => merge({ seq: row.seq, timestamp: ts(row.logged_at), type: row.type, message: row.message }, row.details));

  let currentLot = null;
  if (r.current_lot) {
    const lot = { ...r.current_lot };
    const pid = r.current_lot_player_id;
    if (lot.$noPlayer) delete lot.$noPlayer;
    else if (has(lot, '$player')) lot.player = lot.$player;
    else lot.player = byId.get(pid);
    delete lot.$player;
    if (lot.$bidHistoryFromBids) lot.bidHistory = allBids.filter(b => b && b.playerId === pid && b.lotNumber === lot.lotNumber);
    else if (has(lot, '$bidHistory')) lot.bidHistory = lot.$bidHistory;
    delete lot.$bidHistoryFromBids;
    delete lot.$bidHistory;
    currentLot = lot;
  }

  return merge({
    roomCode: code,
    createdAt: ts(r.created_at),
    hostToken: r.host_token_hash ? HASH_PREFIX + r.host_token_hash : null,
    hostName: r.host_name,
    status: r.status,
    config: r.config,
    playersCatalog,
    currentPlayerIndex: r.current_player_index,
    currentLot,
    franchises,
    playingXIConfigurations,
    participants,
    history,
    allBids,
    auditLog,
    evaluationResults: r.evaluation_results,
    auditSeq: r.audit_seq
  }, r.extra);
}
