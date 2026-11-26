// Display helpers for the live auction screen. They reuse the server's own validateBid so the
// "can bid" indicators match exactly what the server will accept. The server still decides.
import { validateBid, isLotOpen } from '../../../server/auctionEngine.js';

export function franchiseBidStatus(room, franchise) {
  if (!franchise) return { state: 'unclaimed', label: '—', reason: 'Unknown franchise' };
  if (!franchise.isClaimed) return { state: 'unclaimed', label: 'Not in auction', reason: 'No owner claimed this franchise' };
  if (franchise.isEliminated) return { state: 'eliminated', label: 'Out', reason: franchise.eliminationReason || 'Financially eliminated' };
  const lot = room?.currentLot;
  if (lot && lot.highestBidderFranchiseId === franchise.id && isLotOpen(lot)) {
    return { state: 'leading', label: 'Highest bid', reason: 'Holds the current highest bid' };
  }
  if (room?.status !== 'active' || !lot || !isLotOpen(lot)) {
    return { state: 'idle', label: 'Waiting', reason: room?.status === 'paused' ? 'Auction paused' : 'No open lot' };
  }
  let check;
  try {
    check = validateBid({ room, franchiseId: franchise.id });
  } catch {
    return { state: 'idle', label: 'Waiting', reason: 'Updating…' };
  }
  return check.valid
    ? { state: 'eligible', label: 'Can bid', reason: 'Eligible for the next bid' }
    : { state: 'blocked', label: 'Cannot bid', reason: check.error };
}

// Hammer status shown on the stage: SOLD/UNSOLD from the server, GOING ONCE/TWICE derived from
// the authoritative deadline (display only).
export function hammerLabel(room, lot) {
  if (!lot) return { key: 'none', text: '' };
  if (lot.hammerStatus === 'SOLD') return { key: 'sold', text: 'SOLD' };
  if (lot.hammerStatus === 'UNSOLD') return { key: 'unsold', text: 'UNSOLD' };
  if (room?.status === 'paused') return { key: 'paused', text: 'PAUSED' };
  const c = Number(lot.countdown);
  if (Number.isFinite(c) && c <= 0) return { key: 'closing', text: 'HAMMER FALLING' };
  if (Number.isFinite(c) && c <= 1) return { key: 'twice', text: 'GOING TWICE' };
  if (Number.isFinite(c) && c <= 3) return { key: 'once', text: 'GOING ONCE' };
  return { key: 'open', text: lot.highestBid > 0 ? 'BIDDING OPEN' : 'AWAITING OPENING BID' };
}
