// Shared pure auction room rules & helpers used by both Node RoomManager and Cloudflare AuctionRoomDO.
// Contains zero filesystem (node:fs) dependencies so it bundles cleanly for Cloudflare Workers.
import crypto from 'node:crypto';
import { FIXED_RULES } from './config.js';

export const PLAYING_XI_FORBIDDEN = 'Only the owner of this franchise can update its Playing XI';
export const FINAL_PLAYER_STATUSES = ['sold', 'unsold', 'SKIPPED'];

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Players a franchise has PURCHASED, from authoritative server state (shared by live lineup
 * validation and legacy cleanup so the two can never disagree).
 * Source of truth: franchise.squad (written only when a lot is SOLD).
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

/**
 * Validates and builds a clean Playing XI update without mutating room state.
 * Mirrors RoomManager.updatePlayingXI rules identically.
 */
export function validateAndBuildPlayingXI(room, franchiseId, {
  playingXI = [],
  captainId = null,
  viceCaptainId = null,
  wicketKeeperId = null,
  impactPlayerId = null,
  isConfirmed = true
} = {}) {
  const franchise = room?.franchises?.[franchiseId];
  if (!franchise) {
    return { success: false, error: 'Franchise not found', code: 'FORBIDDEN' };
  }

  const reject = (error, code = 'INVALID_LINEUP') => ({ success: false, error, code });

  if (!Array.isArray(playingXI) || !playingXI.every(id => typeof id === 'string')) {
    return reject('Playing XI must be a list of player ids');
  }
  for (const [label, id] of [
    ['Captain', captainId],
    ['Vice-Captain', viceCaptainId],
    ['Wicketkeeper', wicketKeeperId],
    ['Impact player', impactPlayerId]
  ]) {
    if (id !== null && id !== undefined && typeof id !== 'string') {
      return reject(`${label} must be a player id`);
    }
  }

  if (playingXI.length > 11) {
    return reject('Playing XI cannot have more than 11 players');
  }

  if (new Set(playingXI).size !== playingXI.length) {
    return reject('Duplicate player: the same player cannot appear twice in the Playing XI', 'DUPLICATE_PLAYER');
  }

  const owned = getOwnedPlayers(room, franchiseId);
  const notOwned = id => {
    const p = (room.playersCatalog || []).find(c => c.id === id);
    return reject(`${p ? p.name : 'Selected player'} is not in ${franchise.name}'s purchased squad`, 'PLAYER_NOT_IN_SQUAD');
  };
  for (const pid of playingXI) {
    if (!owned.has(pid)) return notOwned(pid);
  }

  const overseasInXI = playingXI.filter(pid => owned.get(pid).isOverseas).length;
  if (overseasInXI > 4) {
    return reject(`Maximum 4 overseas players allowed in Playing XI (Current: ${overseasInXI})`);
  }

  if (impactPlayerId) {
    if (!owned.has(impactPlayerId)) return notOwned(impactPlayerId);
    if (playingXI.includes(impactPlayerId)) {
      return reject('Impact player cannot also be in the starting Playing XI');
    }
  }

  // Ensure a player never appears in two franchises' lineups concurrently
  const chosen = new Set([...playingXI, ...(impactPlayerId ? [impactPlayerId] : [])]);
  for (const [otherId, other] of Object.entries(room.franchises || {})) {
    if (otherId === franchiseId) continue;
    const cfg = room.playingXIConfigurations?.[otherId];
    const theirSquad = new Set((other.squad || []).map(p => p.id));
    const theirs = [
      ...(other.playingXI || []),
      ...(cfg?.playingXI || []),
      other.impactPlayerId,
      cfg?.impactPlayerId
    ].filter(id => id && theirSquad.has(id));
    const clash = theirs.find(id => chosen.has(id));
    if (clash) {
      return reject(`${owned.get(clash)?.name || 'A selected player'} is already in ${other.name}'s Playing XI`, 'PLAYER_IN_OTHER_LINEUP');
    }
  }

  if (captainId && !playingXI.includes(captainId)) {
    return reject('Captain must be selected from the Playing XI');
  }
  if (viceCaptainId && !playingXI.includes(viceCaptainId)) {
    return reject('Vice-Captain must be selected from the Playing XI');
  }
  if (captainId && viceCaptainId && captainId === viceCaptainId) {
    return reject('Captain and Vice-Captain must be two distinct players');
  }

  if (wicketKeeperId && (!playingXI.includes(wicketKeeperId) || owned.get(wicketKeeperId)?.category !== 'WK')) {
    return reject('Designated wicketkeeper must be a wicketkeeper in the Playing XI');
  }

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

  const resolvedWicketKeeperId = wicketKeeperId || (playingXI.find(pid => owned.get(pid).category === 'WK') || null);

  return {
    success: true,
    cleaned: {
      playingXI: [...playingXI],
      captainId: captainId ?? null,
      viceCaptainId: viceCaptainId ?? null,
      wicketKeeperId: resolvedWicketKeeperId,
      impactPlayerId: impactPlayerId ?? null,
      isConfirmed: !!isConfirmed
    }
  };
}

/**
 * Append one audit entry (newest first). seq is a per-room, never-reused sequence number;
 * memory keeps the newest 200.
 */
export function appendAuditEntry(room, type, message) {
  if (!Array.isArray(room.auditLog)) room.auditLog = [];
  const seq = (Number.isInteger(room.auditSeq) ? room.auditSeq : 0) + 1;
  room.auditSeq = seq;
  room.auditLog.unshift({ seq, timestamp: new Date().toISOString(), type, message });
  if (room.auditLog.length > 200) room.auditLog.pop();
}

/**
 * Shuffle the room's catalogue copy WITHIN each player set (contiguous runs of the same
 * categorySet), keeping the set order, then renumber overallLot and lotInSet.
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
 * Bring a lobby room to FIXED_RULES before starting. Active/completed rooms are untouched.
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
  if (changed.some(c => c.startsWith('basePurse'))) {
    for (const f of Object.values(room.franchises || {})) {
      if (isPlainObject(f) && Array.isArray(f.squad) && f.squad.length === 0) {
        f.initialPurse = FIXED_RULES.basePurse;
        f.remainingPurse = FIXED_RULES.basePurse;
        f.totalSpent = 0;
      }
    }
  }
  if (changed.length) {
    appendAuditEntry(room, 'RULES_NORMALIZED', `Room brought to the fixed IPL auction rules before the auction: ${changed.join(', ')}`);
  }
  return changed;
}
