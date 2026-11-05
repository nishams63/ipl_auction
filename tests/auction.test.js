// Comprehensive Automated Test Suite for IPL Auction Simulator
import assert from 'assert';
import {
  calculateDynamicPurse,
  calculateNextBid,
  validateBid,
  checkFinancialElimination,
  evaluateFranchiseSquad,
  rankFranchises,
  DEFAULT_CONFIG
} from '../server/auctionEngine.js';

console.log('🧪 Starting IPL Auction Engine Test Suite...\n');

let passedTests = 0;

function it(description, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${description}`);
    console.error(err);
    process.exit(1);
  }
}

// 1. Dynamic Purse Tests
it('Calculates correct dynamic purse according to formula: Base × (Active / 10)', () => {
  assert.strictEqual(calculateDynamicPurse(120, 10), 120.0);
  assert.strictEqual(calculateDynamicPurse(120, 9), 108.0);
  assert.strictEqual(calculateDynamicPurse(120, 8), 96.0);
  assert.strictEqual(calculateDynamicPurse(120, 7), 84.0);
  assert.strictEqual(calculateDynamicPurse(120, 6), 72.0);
  assert.strictEqual(calculateDynamicPurse(120, 5), 60.0);
  assert.strictEqual(calculateDynamicPurse(120, 4), 48.0);
  assert.strictEqual(calculateDynamicPurse(120, 3), 36.0);
  assert.strictEqual(calculateDynamicPurse(120, 2), 24.0);
});

// 2. Automatic Bid Increment Tests
it('Opening bid equals player base price', () => {
  assert.strictEqual(calculateNextBid(0, 2.0), 2.0);
  assert.strictEqual(calculateNextBid(null, 1.5), 1.5);
});

it('Increments correctly by ₹0.25 Cr from ₹0 to ₹5 Cr', () => {
  assert.strictEqual(calculateNextBid(1.0), 1.25);
  assert.strictEqual(calculateNextBid(4.75), 5.00);
});

it('Increments correctly by ₹0.25 Cr from ₹5 Cr to ₹10 Cr', () => {
  assert.strictEqual(calculateNextBid(5.0), 5.25);
  assert.strictEqual(calculateNextBid(9.75), 10.00);
});

it('Increments correctly by ₹0.50 Cr from ₹10 Cr to ₹15 Cr', () => {
  assert.strictEqual(calculateNextBid(10.0), 10.50);
  assert.strictEqual(calculateNextBid(14.50), 15.00);
});

it('Increments correctly by ₹1.00 Cr above ₹15 Cr', () => {
  assert.strictEqual(calculateNextBid(15.0), 16.00);
  assert.strictEqual(calculateNextBid(20.0), 21.00);
});

// 3. Bid Validation & Concurrency Tests
it('Rejects bids that do not match the automatic next increment', () => {
  const fakeRoom = {
    status: 'active',
    config: DEFAULT_CONFIG,
    currentLot: {
      player: { id: 'PL_001', basePrice: 2.0, isOverseas: false },
      highestBid: 2.0,
      highestBidderFranchiseId: 'MI',
      stateVersion: 1
    },
    franchises: {
      CSK: {
        id: 'CSK',
        remainingPurse: 100.0,
        squad: [],
        overseasCount: 0
      }
    }
  };

  // Attempting manual jump to ₹5.0 Cr instead of valid next ₹2.25 Cr
  const result = validateBid({
    room: fakeRoom,
    franchiseId: 'CSK',
    bidAmount: 5.0,
    expectedVersion: 1
  });

  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('does not match required increment'));
});

it('Rejects stale bids against an older stateVersion (simultaneous bidding protection)', () => {
  const fakeRoom = {
    status: 'active',
    config: DEFAULT_CONFIG,
    currentLot: {
      player: { id: 'PL_001', basePrice: 2.0, isOverseas: false },
      highestBid: 2.25,
      highestBidderFranchiseId: 'MI',
      stateVersion: 2 // current version on server is 2
    },
    franchises: {
      CSK: { id: 'CSK', remainingPurse: 100.0, squad: [], overseasCount: 0 }
    }
  };

  // Bid submitted with stale expectedVersion 1
  const result = validateBid({
    room: fakeRoom,
    franchiseId: 'CSK',
    bidAmount: 2.50,
    expectedVersion: 1
  });

  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('Stale bid request'));
});

it('Prevents self-bidding if franchise already holds the highest bid', () => {
  const fakeRoom = {
    status: 'active',
    config: DEFAULT_CONFIG,
    currentLot: {
      player: { id: 'PL_001', basePrice: 2.0, isOverseas: false },
      highestBid: 2.0,
      highestBidderFranchiseId: 'CSK',
      stateVersion: 1
    },
    franchises: {
      CSK: { id: 'CSK', remainingPurse: 100.0, squad: [], overseasCount: 0 }
    }
  };

  const result = validateBid({
    room: fakeRoom,
    franchiseId: 'CSK',
    bidAmount: 2.25,
    expectedVersion: 1
  });

  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('already holds the highest bid'));
});

// 4. Feasibility & Squad Reserve Tests
it('Enforces minimum squad feasibility reserve to prevent mathematical elimination', () => {
  const fakeRoom = {
    status: 'active',
    config: {
      minSquadSize: 15,
      maxSquadSize: 25,
      minPlayerPrice: 0.20,
      maxOverseas: 8
    },
    currentLot: {
      player: { id: 'PL_001', basePrice: 2.0, isOverseas: false },
      highestBid: 0,
      highestBidderFranchiseId: null,
      stateVersion: 1
    },
    franchises: {
      RCB: {
        id: 'RCB',
        // Team has 3 players, needs 12 more. If they buy this player, they have 4 players,
        // and need 11 more at ₹0.20 Cr each = ₹2.20 Cr reserve needed.
        // If remaining purse is only ₹3.0 Cr, bidding ₹2.0 leaves only ₹1.0 Cr (< ₹2.20 Cr).
        remainingPurse: 3.0,
        squad: [{}, {}, {}],
        overseasCount: 0
      }
    }
  };

  const result = validateBid({
    room: fakeRoom,
    franchiseId: 'RCB',
    bidAmount: 2.0,
    expectedVersion: 1
  });

  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('Financial Feasibility'));
});

it('Enforces overseas player limit (Max 8)', () => {
  const fakeRoom = {
    status: 'active',
    config: DEFAULT_CONFIG,
    currentLot: {
      player: { id: 'PL_OS', basePrice: 2.0, isOverseas: true },
      highestBid: 0,
      highestBidderFranchiseId: null,
      stateVersion: 1
    },
    franchises: {
      SRH: {
        id: 'SRH',
        remainingPurse: 80.0,
        squad: new Array(10).fill({}),
        overseasCount: 8 // already at limit
      }
    }
  };

  const result = validateBid({
    room: fakeRoom,
    franchiseId: 'SRH',
    bidAmount: 2.0,
    expectedVersion: 1
  });

  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('Overseas player limit reached'));
});

// 5. Financial Elimination Tests
it('Correctly identifies financially eliminated franchise', () => {
  const config = { minSquadSize: 15, minPlayerPrice: 0.20 };
  const team = {
    squad: new Array(10).fill({}), // needs 5 more players (5 * 0.20 = 1.0 Cr)
    remainingPurse: 0.50 // only 0.50 Cr left
  };

  const elim = checkFinancialElimination(team, config);
  assert.strictEqual(elim.isEliminated, true);
  assert.ok(elim.reason.includes('Purse exhausted'));
});

// 6. Deterministic Team Evaluation & Ranking Tests
it('Deterministically evaluates squads and ranks top three eligible teams with tie-breakers', () => {
  const config = DEFAULT_CONFIG;
  const initialPurse = 120.0;

  const cskSquad = [
    { category: 'WK', rating: 97, isOverseas: false },
    { category: 'BAT', rating: 98, isOverseas: false },
    { category: 'BAT', rating: 95, isOverseas: false },
    { category: 'BAT', rating: 94, isOverseas: false },
    { category: 'FAST', rating: 99, isOverseas: false },
    { category: 'FAST', rating: 92, isOverseas: false },
    { category: 'FAST', rating: 91, isOverseas: false },
    { category: 'SPIN', rating: 95, isOverseas: false },
    { category: 'SPIN', rating: 94, isOverseas: false },
    { category: 'AR', rating: 96, isOverseas: false },
    { category: 'AR', rating: 92, isOverseas: false },
    { category: 'BAT', rating: 90, isOverseas: true },
    { category: 'FAST', rating: 95, isOverseas: true },
    { category: 'SPIN', rating: 98, isOverseas: true },
    { category: 'AR', rating: 96, isOverseas: true }
  ];

  const miSquad = [
    { category: 'WK', rating: 93, isOverseas: false },
    { category: 'BAT', rating: 96, isOverseas: false },
    { category: 'BAT', rating: 95, isOverseas: false },
    { category: 'BAT', rating: 92, isOverseas: false },
    { category: 'FAST', rating: 95, isOverseas: false },
    { category: 'FAST', rating: 90, isOverseas: false },
    { category: 'FAST', rating: 88, isOverseas: false },
    { category: 'SPIN', rating: 91, isOverseas: false },
    { category: 'SPIN', rating: 88, isOverseas: false },
    { category: 'AR', rating: 96, isOverseas: false },
    { category: 'AR', rating: 90, isOverseas: false },
    { category: 'BAT', rating: 88, isOverseas: true },
    { category: 'FAST', rating: 93, isOverseas: true },
    { category: 'WK', rating: 92, isOverseas: true },
    { category: 'AR', rating: 92, isOverseas: true }
  ];

  const rcbIncompleteSquad = [
    { category: 'BAT', rating: 98, isOverseas: false },
    { category: 'FAST', rating: 92, isOverseas: false }
    // Only 2 players, fails minSquadSize 15
  ];

  const cskEval = evaluateFranchiseSquad({
    id: 'CSK',
    name: 'Chennai Super Kings',
    squad: cskSquad,
    remainingPurse: 10.0,
    totalSpent: 110.0,
    isEliminated: false
  }, config, initialPurse);

  const miEval = evaluateFranchiseSquad({
    id: 'MI',
    name: 'Mumbai Indians',
    squad: miSquad,
    remainingPurse: 15.0,
    totalSpent: 105.0,
    isEliminated: false
  }, config, initialPurse);

  const rcbEval = evaluateFranchiseSquad({
    id: 'RCB',
    name: 'Royal Challengers Bengaluru',
    squad: rcbIncompleteSquad,
    remainingPurse: 80.0,
    totalSpent: 40.0,
    isEliminated: false
  }, config, initialPurse);

  assert.strictEqual(cskEval.isEligible, true);
  assert.strictEqual(miEval.isEligible, true);
  assert.strictEqual(rcbEval.isEligible, false); // Incomplete squad!

  const rankingResult = rankFranchises([rcbEval, cskEval, miEval]);

  assert.strictEqual(rankingResult.podium.length, 2);
  assert.strictEqual(rankingResult.podium[0].title, 'Champion');
  assert.strictEqual(rankingResult.podium[1].title, 'Runner-Up');
  assert.strictEqual(rankingResult.eligibleCount, 2);
  assert.strictEqual(rankingResult.eliminatedCount, 1);
});

console.log(`\n🎉 All ${passedTests} test scenarios passed successfully!\n`);
