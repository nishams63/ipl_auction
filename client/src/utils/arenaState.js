// Maps the public room object the client already holds into the small, display-only
// snapshot the Unity arena understands (protocol v1). Pure function: no side effects,
// no private fields (tokens, socket ids, owner ids) and nothing Unity could act on.

export const ARENA_PROTOCOL_VERSION = 1;

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : '');

export function toArenaState(room) {
  if (!room || typeof room !== 'object') return null;
  const lot = room.currentLot;
  const p = lot?.player;
  const franchises = Object.values(room.franchises || {}).map(f => ({
    id: str(f.id, 8),
    code: str(f.code || f.id, 8),
    name: str(f.name, 60),
    color: str(f.primaryColor, 9),
    color2: str(f.secondaryColor, 9),
    purse: num(f.remainingPurse),
    squad: Array.isArray(f.squad) ? f.squad.length : 0,
    claimed: !!f.isClaimed
  }));
  const state = {
    v: ARENA_PROTOCOL_VERSION,
    status: str(room.status, 16),
    hasLot: !!p,
    lot: {
      number: num(lot?.lotNumber), total: num(lot?.totalLots),
      playerId: str(p?.id, 40), name: str(p?.name, 60), role: str(p?.role, 60),
      category: str(p?.category, 12), country: str(p?.country, 40), overseas: !!p?.isOverseas,
      basePrice: num(p?.basePrice), highestBid: num(lot?.highestBid),
      bidder: str(lot?.highestBidderFranchiseId, 8), bidCount: Array.isArray(lot?.bidHistory) ? lot.bidHistory.length : 0,
      version: num(lot?.stateVersion), countdown: Math.max(0, Math.round(num(lot?.countdown))),
      timerDuration: Math.max(1, Math.round(num(room.config?.timerDuration, 15))),
      hammer: str(lot?.hammerStatus, 16)
    },
    franchises
  };
  return state;
}
