// Server-authoritative IPL Auction Engine & Mathematical Rules

// Defaults and validation rules live in ./config.js (single source of truth)
import { DEFAULT_CONFIG } from './config.js';
import { toLakh, fromLakh, nextBidLakh, isWholeLakh } from './money.js';
export { DEFAULT_CONFIG };

/**
 * Returns initial auction purse per franchise (Flat ₹120.0 Crore across all 10 franchises)
 * Total budget across all 10 franchises = ₹1,200 Crore
 */
export function calculateDynamicPurse(basePurse = 120.0) {
  return Math.round((basePurse || 120.0) * 100) / 100;
}

/**
 * Next valid bid (₹ Cr), computed exactly in integer lakhs (see money.js):
 *   first bid = base price; then below ₹10 Cr +0.25, ₹10–<15 Cr +0.50, ₹15 Cr+ +1.00.
 */
export function calculateNextBid(currentBid, basePrice = 2.0) {
  const current = (currentBid === null || currentBid === undefined || currentBid <= 0) ? 0 : toLakh(currentBid);
  return fromLakh(nextBidLakh(current, toLakh(basePrice ?? 2.0)));
}

/**
 * Per-slot reserve used for squad-completion feasibility, in lakhs: the configured floor, but
 * never below the cheapest base price in the room's catalogue (a slot cannot be filled for less
 * than any player costs; the default floor ₹0.20 Cr is below the catalogue minimum ₹0.30 Cr).
 */
export function reserveFloorLakh(room) {
  const configured = toLakh(room?.config?.minPlayerPrice ?? DEFAULT_CONFIG.minPlayerPrice);
  let cheapest = Infinity;
  for (const p of room?.playersCatalog || []) {
    if (p && typeof p.basePrice === 'number' && Number.isFinite(p.basePrice)) cheapest = Math.min(cheapest, toLakh(p.basePrice));
  }
  return Number.isFinite(cheapest) ? Math.max(configured, cheapest) : configured;
}

const wkCountOf = franchise => (franchise.squad || []).filter(p => p?.category === 'WK').length;

/**
 * A lot accepts bids only until the hammer falls.
 */
export function isLotOpen(lot) {
  return !!lot && lot.hammerStatus !== "SOLD" && lot.hammerStatus !== "UNSOLD" && !lot.closed;
}

/**
 * Validates whether a franchise is eligible to place the next bid
 */
export function validateBid({
  room,
  franchiseId,
  bidAmount,
  expectedVersion
}) {
  const franchise = room.franchises[franchiseId];
  if (!franchise) {
    return { valid: false, error: "Franchise not found" };
  }

  // Real rooms always set isClaimed to a boolean (see RoomManager.createRoom)
  if (franchise.isClaimed === false) {
    return { valid: false, error: "Franchise is not active in this auction" };
  }

  if (franchise.isEliminated) {
    return { valid: false, error: "Franchise has been financially eliminated and cannot bid" };
  }

  if (room.status !== "active") {
    return { valid: false, error: "Auction is not actively accepting bids" };
  }

  const currentLot = room.currentLot;
  if (!currentLot || !currentLot.player) {
    return { valid: false, error: "No player currently being auctioned" };
  }

  // The hammer has fallen (SOLD/UNSOLD) and the next lot has not been presented yet
  if (!isLotOpen(currentLot)) {
    return { valid: false, error: "Bidding on this player has closed" };
  }

  // bidAmount is optional (server computes it), but if supplied it must be a real number
  if (bidAmount !== undefined && bidAmount !== null &&
      (typeof bidAmount !== "number" || !Number.isFinite(bidAmount))) {
    return { valid: false, error: "Invalid bid amount" };
  }

  // Version check for atomic concurrency protection
  if (expectedVersion !== undefined && expectedVersion !== currentLot.stateVersion) {
    return { valid: false, error: "Stale bid request: another bid was accepted first" };
  }

  // Self-bidding prevention: Can't outbid yourself if you are already the highest bidder
  if (currentLot.highestBidderFranchiseId === franchiseId) {
    return { valid: false, error: "Your franchise already holds the highest bid" };
  }

  // Required next bid, exactly (integer lakhs). The server always decides the amount.
  const validNextLakh = nextBidLakh(currentLot.highestBid > 0 ? toLakh(currentLot.highestBid) : 0, toLakh(currentLot.player.basePrice));
  const validNextAmount = fromLakh(validNextLakh);

  // Strict Rule: Disallow custom amounts. If the client echoes an amount it must be exactly it.
  if (bidAmount !== undefined && bidAmount !== null) {
    if (!isWholeLakh(bidAmount) || toLakh(bidAmount) !== validNextLakh) {
      return {
        valid: false,
        error: `Custom bids are disabled. You must place the exact next increment bid of ₹${validNextAmount.toFixed(2)} Cr`
      };
    }
  }

  const validNextAmountToAccept = validNextAmount;

  // Max squad size check
  if (franchise.squad.length >= room.config.maxSquadSize) {
    return { valid: false, error: `Squad capacity reached (Max ${room.config.maxSquadSize} players)` };
  }

  // Overseas player limit check
  if (currentLot.player.isOverseas && franchise.overseasCount >= room.config.maxOverseas) {
    return {
      valid: false,
      error: `Overseas player limit reached (Max ${room.config.maxOverseas} overseas players allowed)`
    };
  }

  // Wicketkeeper requirement: never let a franchise fill the slots it still needs for keepers
  const projectedSquadCount = franchise.squad.length + 1;
  const keepersStillNeeded = Math.max(0, (room.config.minWKs ?? 1) - wkCountOf(franchise) - (currentLot.player.category === 'WK' ? 1 : 0));
  const slotsLeftAfter = room.config.maxSquadSize - projectedSquadCount;
  if (keepersStillNeeded > slotsLeftAfter) {
    return {
      valid: false,
      error: `Squad rule: keep ${keepersStillNeeded === 1 ? 'a slot' : `${keepersStillNeeded} slots`} for a wicketkeeper (min ${room.config.minWKs} WK; max squad ${room.config.maxSquadSize})`
    };
  }

  // Financial feasibility protection (exact, integer lakhs):
  // Team must be able to complete minimum squad size with remaining purse.
  // Always use the server-computed amount, never the client-supplied value.
  const projectedPurseLakh = toLakh(franchise.remainingPurse) - validNextLakh;
  if (projectedPurseLakh < 0) {
    return { valid: false, error: "Insufficient purse balance" };
  }

  const remainingSlotsToMin = Math.max(0, room.config.minSquadSize - projectedSquadCount);
  const minRequiredReserveLakh = remainingSlotsToMin * reserveFloorLakh(room);

  if (projectedPurseLakh < minRequiredReserveLakh) {
    return {
      valid: false,
      error: `Financial Feasibility: Must reserve at least ₹${fromLakh(minRequiredReserveLakh).toFixed(2)} Cr for ${remainingSlotsToMin} remaining mandatory slots to meet minimum squad (${room.config.minSquadSize}).`
    };
  }

  return { valid: true, validNextAmount: validNextAmountToAccept };
}

/**
 * Checks and updates financial elimination status of a franchise
 */
export function checkFinancialElimination(franchise, config, floorLakh = toLakh(config.minPlayerPrice)) {
  if (franchise.squad.length >= config.minSquadSize) {
    return { isEliminated: false };
  }

  const remainingNeeded = config.minSquadSize - franchise.squad.length;
  const minReserveNeededLakh = remainingNeeded * floorLakh;

  if (toLakh(franchise.remainingPurse) < minReserveNeededLakh) {
    return {
      isEliminated: true,
      reason: `Purse exhausted (₹${franchise.remainingPurse.toFixed(2)} Cr remaining). Requires ₹${fromLakh(minReserveNeededLakh).toFixed(2)} Cr to complete ${remainingNeeded} more mandatory squad slots.`
    };
  }

  return { isEliminated: false };
}

/**
 * Deterministic Transparent Team Evaluation & Ranking
 * 30% Verified Player Quality
 * 20% Batting Strength
 * 20% Bowling Strength
 * 10% All-Rounder Balance
 * 10% Squad Role Composition
 * 5% Overseas / Domestic Ratio
 * 5% Budget Efficiency
 */
export function evaluateFranchiseSquad(franchise, config, initialPurse) {
  const squad = franchise.squad || [];

  // Check eligibility:
  // Must have met minSquadSize, min 1 WK, and not be eliminated
  const hasMinSquad = squad.length >= config.minSquadSize;
  const wkCount = squad.filter(p => p.category === "WK").length;
  const hasMinWK = wkCount >= config.minWKs;
  const isEliminated = franchise.isEliminated || !hasMinSquad || !hasMinWK;

  const batters = squad.filter(p => p.category === "BAT");
  const fastBowlers = squad.filter(p => p.category === "BOWL" || p.category === "FAST");
  const spinBowlers = squad.filter(p => p.category === "SP" || p.category === "SPIN");
  const allRounders = squad.filter(p => p.category === "AR");
  const wicketKeepers = squad.filter(p => p.category === "WK");
  const overseas = squad.filter(p => p.isOverseas);

  if (squad.length === 0) {
    return {
      franchiseId: franchise.id,
      totalScore: 0,
      isEligible: false,
      ineligibilityReason: "No players purchased",
      breakdown: {
        playerQuality: 0,
        battingStrength: 0,
        bowlingStrength: 0,
        allRounderBalance: 0,
        squadComposition: 0,
        overseasBalance: 0,
        budgetEfficiency: 0
      }
    };
  }

  // 1. Player Quality (30%): Average rating normalized to 100
  const avgRating = squad.reduce((sum, p) => sum + (p.rating || 80), 0) / squad.length;
  // Map rating [80..100] to [0..100]
  const qualityScore = Math.min(100, Math.max(0, (avgRating - 75) * 4));

  // 2. Batting Strength (20%): Depth of batters & WKs
  const battingPool = [...batters, ...wicketKeepers];
  const topBatters = battingPool.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 5);
  const avgBatRating = topBatters.length > 0
    ? topBatters.reduce((s, p) => s + (p.rating || 80), 0) / topBatters.length
    : 70;
  const battingDepthBonus = Math.min(20, battingPool.length * 3);
  const battingStrength = Math.min(100, ((avgBatRating - 75) * 3) + battingDepthBonus);

  // 3. Bowling Strength (20%): Depth of fast & spin bowlers
  const bowlersPool = [...fastBowlers, ...spinBowlers];
  const topBowlers = bowlersPool.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 5);
  const avgBowlRating = topBowlers.length > 0
    ? topBowlers.reduce((s, p) => s + (p.rating || 80), 0) / topBowlers.length
    : 70;
  const varietyBonus = (fastBowlers.length >= 2 && spinBowlers.length >= 2) ? 15 : 5;
  const bowlingStrength = Math.min(100, ((avgBowlRating - 75) * 3) + varietyBonus);

  // 4. All-Rounder Balance (10%)
  const arCount = allRounders.length;
  let arScore = 0;
  if (arCount >= 2 && arCount <= 5) arScore = 95;
  else if (arCount === 1) arScore = 70;
  else if (arCount > 5) arScore = 80;
  else arScore = 30;

  // 5. Squad Composition & Role Balance (10%)
  let roleCompScore = 100;
  if (batters.length < 3) roleCompScore -= 20;
  if (fastBowlers.length < 3) roleCompScore -= 20;
  if (spinBowlers.length < 2) roleCompScore -= 20;
  if (wicketKeepers.length < 1) roleCompScore -= 30;
  if (allRounders.length < 1) roleCompScore -= 10;
  roleCompScore = Math.max(0, roleCompScore);

  // 6. Overseas / Domestic Balance (5%)
  // Ideal: 4 to 8 overseas players
  let overseasScore = 50;
  if (overseas.length >= 4 && overseas.length <= config.maxOverseas) {
    overseasScore = 100;
  } else if (overseas.length > 0 && overseas.length < 4) {
    overseasScore = 75;
  } else if (overseas.length > config.maxOverseas) {
    overseasScore = 20;
  }

  // 7. Budget Efficiency (5%)
  // Rewarding strategic utilization without keeping excessively unspent purse
  const totalSpent = franchise.totalSpent || (initialPurse - franchise.remainingPurse);
  const spentPct = (totalSpent / initialPurse) * 100;
  let budgetScore = 70;
  if (spentPct >= 80 && spentPct <= 98) {
    budgetScore = 100; // Optimal spending sweet spot
  } else if (spentPct > 98) {
    budgetScore = 85; // Cutting it very close
  } else {
    budgetScore = Math.max(40, spentPct);
  }

  // Weighted total:
  const weightedScore = (
    qualityScore * 0.30 +
    battingStrength * 0.20 +
    bowlingStrength * 0.20 +
    arScore * 0.10 +
    roleCompScore * 0.10 +
    overseasScore * 0.05 +
    budgetScore * 0.05
  );

  const roundedTotal = Math.round(weightedScore * 10) / 10;

  let ineligibilityReason = null;
  if (franchise.isEliminated) {
    ineligibilityReason = franchise.eliminationReason || "Financially eliminated";
  } else if (!hasMinSquad) {
    ineligibilityReason = `Failed minimum squad size requirement (Has ${squad.length}/${config.minSquadSize} players)`;
  } else if (!hasMinWK) {
    ineligibilityReason = `Failed mandatory wicketkeeper requirement (Has 0 WKs)`;
  }

  return {
    franchiseId: franchise.id,
    franchiseName: franchise.name,
    totalScore: roundedTotal,
    isEligible: !ineligibilityReason,
    ineligibilityReason,
    squadSize: squad.length,
    overseasCount: overseas.length,
    remainingPurse: franchise.remainingPurse,
    totalSpent,
    counts: {
      batters: batters.length,
      fastBowlers: fastBowlers.length,
      spinBowlers: spinBowlers.length,
      allRounders: allRounders.length,
      wicketKeepers: wicketKeepers.length
    },
    breakdown: {
      playerQuality: Math.round(qualityScore),
      battingStrength: Math.round(battingStrength),
      bowlingStrength: Math.round(bowlingStrength),
      allRounderBalance: Math.round(arScore),
      squadComposition: Math.round(roleCompScore),
      overseasBalance: Math.round(overseasScore),
      budgetEfficiency: Math.round(budgetScore)
    }
  };
}

/**
 * Ranks all eligible franchises deterministically with transparent tie-breakers
 */
export function rankFranchises(evaluations) {
  // Sort with tie-breakers:
  // 1. isEligible (eligible first)
  // 2. Higher totalScore
  // 3. Squad size compliance
  // 4. Role composition score
  // 5. Budget efficiency
  const sorted = [...evaluations].sort((a, b) => {
    if (a.isEligible !== b.isEligible) {
      return a.isEligible ? -1 : 1;
    }
    if (Math.abs(b.totalScore - a.totalScore) > 0.1) {
      return b.totalScore - a.totalScore;
    }
    if (b.squadSize !== a.squadSize) {
      return b.squadSize - a.squadSize;
    }
    if (b.breakdown.squadComposition !== a.breakdown.squadComposition) {
      return b.breakdown.squadComposition - a.breakdown.squadComposition;
    }
    return b.breakdown.budgetEfficiency - a.breakdown.budgetEfficiency;
  });

  const eligibleList = sorted.filter(e => e.isEligible);
  const eliminatedList = sorted.filter(e => !e.isEligible);

  const podium = [];
  if (eligibleList[0]) podium.push({ rank: 1, title: "Champion", ...eligibleList[0] });
  if (eligibleList[1]) podium.push({ rank: 2, title: "Runner-Up", ...eligibleList[1] });
  if (eligibleList[2]) podium.push({ rank: 3, title: "Third Place", ...eligibleList[2] });

  return {
    podium,
    rankings: sorted.map((team, idx) => ({
      position: idx + 1,
      ...team
    })),
    eligibleCount: eligibleList.length,
    eliminatedCount: eliminatedList.length
  };
}
