// Pure reducers that apply server events to the client's copy of the room.
// The server is authoritative: full snapshots replace local state; partial events are applied
// only when they belong to the lot currently on screen and are not older than what we have.

const lotNo = (lot) => (lot ? (lot.lotNumber || lot.number || 0) : 0);

export function applyStateSnapshot(prev, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.roomCode) return prev;
  if (prev && prev.roomCode && prev.roomCode !== snapshot.roomCode) return prev; // never cross rooms
  return snapshot;
}

// LOT_PRESENTED: Cloudflare sends a lean payload ({partial:true, currentLot, ...}); the legacy
// Node server sends a full snapshot.
export function applyLotPresented(prev, data) {
  if (!data || typeof data !== 'object') return prev;
  if (!data.partial) return applyStateSnapshot(prev, data);
  if (!prev || (data.roomCode && prev.roomCode !== data.roomCode)) return prev;
  const cur = prev.currentLot;
  if (cur && data.currentLot && lotNo(data.currentLot) < lotNo(cur)) return prev; // out of order
  const pid = data.currentLot?.player?.id;
  return {
    ...prev,
    status: data.status || prev.status,
    currentPlayerIndex: data.currentPlayerIndex ?? prev.currentPlayerIndex,
    lotNumber: data.lotNumber ?? prev.lotNumber,
    totalLots: data.totalLots ?? prev.totalLots,
    currentLot: data.currentLot || null,
    playersCatalog: pid
      ? (prev.playersCatalog || []).map(p => (p.id === pid ? { ...p, status: 'in_auction' } : p))
      : prev.playersCatalog
  };
}

export function applyBidAccepted(prev, data) {
  if (!prev || !data?.currentLot) return prev;
  const cur = prev.currentLot;
  if (cur && lotNo(cur) !== lotNo(data.currentLot)) return prev; // bid for a lot we are not showing
  if (cur && (data.currentLot.stateVersion || 0) < (cur.stateVersion || 0)) return prev; // out of order
  const recent = [...(prev.recentBids || []), data.bid].filter(Boolean).slice(-15);
  return {
    ...prev,
    currentLot: { ...data.currentLot, countdown: cur?.countdown ?? data.currentLot.countdown },
    franchises: data.franchises || prev.franchises,
    recentBids: recent
  };
}

export function applyLotCompleted(prev, data) {
  if (!prev || !data) return prev;
  const { result, lot, historyEntry, franchises, franchiseUpdates, playersCatalog, playerUpdate } = data;
  const pid = playerUpdate?.id || lot?.player?.id;
  const catalog = playersCatalog || (prev.playersCatalog || []).map(p => {
    if (p.id !== pid) return p;
    return {
      ...p,
      status: playerUpdate?.status || (result === 'SOLD' ? 'sold' : 'unsold'),
      soldTo: result === 'SOLD' ? (playerUpdate?.soldTo || lot?.highestBidderFranchiseId || historyEntry?.winningFranchiseId) : null,
      soldPrice: result === 'SOLD' ? (playerUpdate?.soldPrice || lot?.highestBid || 0) : 0
    };
  });
  const nextFranchises = franchises
    || (franchiseUpdates ? { ...(prev.franchises || {}), ...franchiseUpdates } : prev.franchises);
  const history = historyEntry
    ? [historyEntry, ...(prev.history || []).filter(h => !(h.lotNumber === historyEntry.lotNumber && h.player?.id === historyEntry.player?.id))]
    : (prev.history || []);
  return {
    ...prev,
    currentLot: lot ? { ...lot, countdown: 0 } : prev.currentLot,
    franchises: nextFranchises,
    playersCatalog: catalog,
    history
  };
}

export function applySetSkipped(prev, data) {
  if (!prev || !data) return prev;
  return {
    ...prev,
    playersCatalog: data.playersCatalog || prev.playersCatalog,
    history: data.history || prev.history
  };
}

export function applyTimerTick(prev, tick) {
  if (!prev?.currentLot || !tick) return prev;
  if (tick.lotNumber && tick.lotNumber !== lotNo(prev.currentLot)) return prev;
  if (prev.status !== 'active') return prev;
  const lot = prev.currentLot;
  if (lot.hammerStatus === 'SOLD' || lot.hammerStatus === 'UNSOLD' || lot.closed) return prev;
  if (lot.countdown === tick.countdown && lot.displayHammer === tick.hammerStatus) return prev;
  return { ...prev, currentLot: { ...lot, countdown: tick.countdown, displayHammer: tick.hammerStatus } };
}

// Which franchise (if any) this participant owns, from the server snapshot
export function findMyFranchiseId(room, participant) {
  if (!room || !participant?.publicId) return null;
  const f = Object.values(room.franchises || {}).find(x => x.ownerId === participant.publicId);
  return f ? f.id : null;
}

// ── Activity feed ────────────────────────────────────────────
const money = (v) => `₹${Number(v || 0).toFixed(2)} Cr`;
let seq = 0;
export function activityItem(kind, text, at = Date.now()) {
  seq += 1;
  return { id: `${at}-${seq}`, kind, text, at };
}

const AUDIT_KINDS = {
  BID_ACCEPTED: 'bid',
  PLAYER_SOLD: 'sold',
  PLAYER_UNSOLD: 'unsold',
  SALE_INVARIANT_BLOCKED: 'unsold',
  AUCTION_PAUSED: 'paused',
  AUCTION_RESUMED: 'resumed',
  SET_SKIPPED: 'skipped',
  AUCTION_FINISHED: 'completed',
  AUCTION_STARTED: 'info',
  PARTICIPANT_JOINED: 'info',
  FRANCHISE_SELECTED: 'info'
};

export function activityFromAudit(auditLog = []) {
  return (Array.isArray(auditLog) ? auditLog : [])
    .filter(e => e && AUDIT_KINDS[e.type])
    .slice(0, 30)
    .map(e => activityItem(AUDIT_KINDS[e.type], String(e.message || ''), Date.parse(e.timestamp || e.at) || Date.now()));
}

export function activityForEvent(event, data, prevRoom) {
  switch (event) {
    case 'bid_accepted': {
      const b = data?.bid;
      if (!b) return null;
      return activityItem('bid', `${b.franchiseCode} bid ${money(b.amount ?? b.bidAmount)} for ${b.playerName}`);
    }
    case 'lot_completed': {
      const h = data?.historyEntry;
      if (!h) return null;
      return h.status === 'SOLD'
        ? activityItem('sold', `SOLD: ${h.player?.name} to ${h.winningFranchiseCode} for ${money(h.finalBid)}`)
        : activityItem('unsold', `UNSOLD: ${h.player?.name}`);
    }
    case 'set_skipped':
      return activityItem('skipped', `Set skipped: ${data?.skippedSetName || 'current set'} (${data?.skippedCount ?? 0} players)`);
    case 'state_updated': {
      if (!prevRoom || !data) return null;
      if (prevRoom.status === 'active' && data.status === 'paused') return activityItem('paused', 'Auction paused by the host');
      if (prevRoom.status === 'paused' && data.status === 'active') return activityItem('resumed', 'Auction resumed');
      if (prevRoom.status === 'lobby' && data.status === 'active') return activityItem('info', 'Auction started');
      return null;
    }
    case 'auction_completed':
      return activityItem('completed', 'Auction completed');
    default:
      return null;
  }
}
