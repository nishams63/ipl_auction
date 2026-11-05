// Server-authoritative IPL Auction Engine & Mathematical Rules

export const DEFAULT_CONFIG = {
  basePurse: 120.0, // ₹120 Cr flat across all 10 franchises
  maxFranchises: 10,
  minParticipants: 2,
  minSquadSize: 11,
  maxSquadSize: 15,
  maxOverseas: 8,
  minWKs: 1,
  minPlayerPrice: 0.20, // ₹0.20 Cr floor for uncapped candidate
  timerDuration: 30, // seconds
  autoAdvanceDelay: 4, // seconds between players
};

/**
 * Returns initial auction purse per franchise (Flat ₹120.0 Crore across all 10 franchises)
 * Total budget across all 10 franchises = ₹1,200 Crore
 */
export function calculateDynamicPurse(basePurse = 120.0) {
  return Math.round((basePurse || 120.0) * 100) / 100;
}

/**
 * Calculates automatic next valid bid based on mandatory IPL rules
 * ₹0 to ₹5 Cr: +₹0.25 Cr
 * Above ₹5 Cr to ₹10 Cr: +₹0.25 Cr
 * Above ₹10 Cr to ₹15 Cr: +₹0.50 Cr
 * Above ₹15 Cr: +₹1.00 Cr
 */
export function calculateNextBid(currentBid, basePrice = 2.0) {
  if (currentBid === null || currentBid === undefined || currentBid <= 0) {
    return Math.round(basePrice * 100) / 100;
  }

  let increment = 0.25;
  if (currentBid < 5.0) {
    increment = 0.25;
  } else if (currentBid < 10.0) {
    increment = 0.25;
  } else if (currentBid < 15.0) {
    increment = 0.50;
  } else {
    increment = 1.00;
  }

  const nextBid = currentBid + increment;
  return Math.round(nextBid * 100) / 100;
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

  if (room.status !== "active") {
    return { valid: false, error: "Auction is not actively accepting bids" };
  }

  const currentLot = room.currentLot;
  if (!currentLot || !currentLot.player) {
    return { valid: false, error: "No player currently being auctioned" };
  }

  // Version check for atomic concurrency protection
  if (expectedVersion !== undefined && expectedVersion !== currentLot.stateVersion) {
    return { valid: false, error: "Stale bid request: another bid was accepted first" };
  }

  // Self-bidding prevention: Can't outbid yourself if you are already the highest bidder
  if (currentLot.highestBidderFranchiseId === franchiseId) {
    return { valid: false, error: "Your franchise already holds the highest bid" };
  }

  // Calculate required next bid amount
  const validNextAmount = currentLot.highestBid === 0
    ? currentLot.player.basePrice
    : calculateNextBid(currentLot.highestBid, currentLot.player.basePrice);

  if (bidAmount < validNextAmount - 0.001) {
    return {
      valid: false,
      error: `Bid amount must be at least the next minimum valid bid of ₹${validNextAmount.toFixed(2)} Cr`
    };
  }

  // Must be in valid auction increment steps (multiples of 0.25 Cr)
  const cents = Math.round(bidAmount * 100);
  if (cents % 25 !== 0) {
    return {
      valid: false,
      error: `Bid amount must be in valid IPL auction steps (multiples of ₹0.25 Cr)`
    };
  }

  const validNextAmountToAccept = Math.round(bidAmount * 100) / 100;

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

  // Financial feasibility protection:
  // Team must be able to complete minimum squad size with remaining purse
  const projectedPurse = franchise.remainingPurse - bidAmount;
  if (projectedPurse < 0) {
    return { valid: false, error: "Insufficient purse balance" };
  }

  const projectedSquadCount = franchise.squad.length + 1;
  const remainingSlotsToMin = Math.max(0, room.config.minSquadSize - projectedSquadCount);
  const minRequiredReserve = remainingSlotsToMin * room.config.minPlayerPrice;

  if (projectedPurse < minRequiredReserve) {
    return {
      valid: false,
      error: `Financial Feasibility: Must reserve at least ₹${minRequiredReserve.toFixed(2)} Cr for ${remainingSlotsToMin} remaining mandatory slots to meet minimum squad (${room.config.minSquadSize}).`
    };
  }

  return { valid: true, validNextAmount: validNextAmountToAccept };
}

/**
 * Checks and updates financial elimination status of a franchise
 */
export function checkFinancialElimination(franchise, config) {
  if (franchise.squad.length >= config.minSquadSize) {
    return { isEliminated: false };
  }

  const remainingNeeded = config.minSquadSize - franchise.squad.length;
  const minReserveNeeded = remainingNeeded * config.minPlayerPrice;

  if (franchise.remainingPurse < minReserveNeeded) {
    return {
      isEliminated: true,
      reason: `Purse exhausted (₹${franchise.remainingPurse.toFixed(2)} Cr remaining). Requires ₹${minReserveNeeded.toFixed(2)} Cr to complete ${remainingNeeded} more mandatory squad slots.`
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
