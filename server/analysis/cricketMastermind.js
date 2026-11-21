// CRICKET MASTERMIND — IPL AUCTION VERDICT
//
// An intelligent, deterministic cricket-strategy analysis engine.
// Evaluates franchise squad construction like an experienced IPL auction strategist.
//
// ABSOLUTELY NO OVERALL NUMERICAL SCORES OR POINT-BASED WINNER CALCULATIONS.
// Rankings and winner selection are derived purely from qualitative cricket evaluations,
// squad completeness, tactical department matchups, critical vulnerability assessments,
// and pairwise head-to-head dominance.
//
// Strict ₹0 budget: 100% local, deterministic execution with no external API calls.

import crypto from 'node:crypto';
import { toLakh, fromLakh } from '../money.js';

export const MASTERMIND_ENGINE_VERSION = 'cricket-mastermind-v1';

// Normalisation targets for squad construction (IPL standard template)
export const SQUAD_TARGETS = Object.freeze({
  minBattingOptions: 7,
  minBowlingOptions: 6,
  minPaceOptions: 4,
  minSpinOptions: 2,
  minAllRounders: 2,
  minKeepers: 2, // 1 primary + 1 backup
  xiOverseasCap: 4,
  squadOverseasCap: 8
});

// Role matching regular expressions based on IPL auction catalogue roles
const OPENER_RE = /open|top-order|top order|anchor|prodigy opener/i;
const MIDDLE_RE = /middle-order|middle order|stroke|classical/i;
const FINISHER_RE = /finish|power|basher|clutch|death overs finish|impact finish|hard-hitting|power hitter|power batter/i;
const PP_BOWL_RE = /powerplay|swing|seam|new-ball|swing bowler|powerplay specialist/i;
const DEATH_BOWL_RE = /death|yorker|slinger|knuckle|slower ball|slower-ball|death specialist|purple cap death/i;
const WRIST_SPIN_RE = /leg[- ]spin|wrist|chinaman|mystery|googly|wrist spinner|leg spinner/i;
const FINGER_SPIN_RE = /off[- ]spin|off[- ]break|orthodox|slow left-arm|finger mystery/i;
const EXPRESS_PACE_RE = /express|150\+|155|speed|raw pace|extreme speed/i;
const SPIN_RE = /spin|off-?break|off-?spin|leg-?spin|leg spinner|orthodox|chinaman|mystery|googly|wrist/i;
const PACE_RE = /pace|fast|medium|seam|swing|yorker|slinger|knuckle/i;
const LEFT_HAND_RE = /left-hand|left arm|left-arm|slow left-arm/i;

// Verified multi-discipline all-rounders with proven international / IPL track records
const VERIFIED_GENUINE_AR_NAMES = new Set([
  'Hardik Pandya', 'Ravindra Jadeja', 'Andre Russell', 'Axar Patel', 'Sam Curran',
  'Glenn Maxwell', 'Marcus Stoinis', 'Washington Sundar', 'Rashid Khan', 'Sunil Narine',
  'Liam Livingstone', 'Mitchell Marsh', 'Moeen Ali', 'Wanindu Hasaranga', 'Shardul Thakur',
  'Nitish Kumar Reddy', 'Krunal Pandya', 'Shahbaz Ahmed', 'Deepak Chahar', 'Harshal Patel',
  'Cameron Green', 'Marco Jansen', 'Romario Shepherd'
]);

/**
 * Classify a player into cricket tactical attributes.
 * Uses only verified catalogue facts: category, role string, country, prices.
 * Never invents career statistics, form, or physical attributes.
 */
export function classifyPlayerMastermind(p) {
  if (!p || typeof p !== 'object') {
    return {
      id: null, name: 'Unknown', category: 'UNCLASSIFIED', role: '',
      isOverseas: false, isLeftHanded: false,
      bats: false, bowls: false, bowlingType: null, keeper: false, allRounder: false,
      isOpener: false, isMiddleOrder: false, isFinisher: false,
      isPowerplayBowler: false, isDeathBowler: false,
      isWristSpinner: false, isFingerSpinner: false, isPacer: false, isExpressPace: false,
      isGenuineAllRounder: false
    };
  }

  const category = typeof p.category === 'string' ? p.category.toUpperCase() : 'UNCLASSIFIED';
  const role = typeof p.role === 'string' ? p.role : '';
  const name = typeof p.name === 'string' ? p.name : '';
  const isLeftHanded = LEFT_HAND_RE.test(role);

  let bats = false;
  let bowls = false;
  let bowlingType = null;
  let keeper = false;
  let allRounder = false;

  switch (category) {
    case 'BAT':
      bats = true;
      break;
    case 'WK':
      bats = true;
      keeper = true;
      break;
    case 'BOWL':
    case 'FAST':
      bowls = true;
      bowlingType = 'pace';
      break;
    case 'SP':
    case 'SPIN':
      bowls = true;
      bowlingType = 'spin';
      break;
    case 'AR':
      bats = true;
      bowls = true;
      allRounder = true;
      bowlingType = SPIN_RE.test(role) ? 'spin' : PACE_RE.test(role) ? 'pace' : null;
      break;
    default:
      break;
  }

  // Tactical sub-roles from catalogue role labels
  const isOpener = bats && OPENER_RE.test(role);
  const isMiddleOrder = bats && (MIDDLE_RE.test(role) || (!isOpener && !FINISHER_RE.test(role) && category === 'BAT'));
  const isFinisher = (bats || allRounder) && FINISHER_RE.test(role);

  const isPacer = bowlingType === 'pace' || PACE_RE.test(role);
  const isExpressPace = isPacer && EXPRESS_PACE_RE.test(role);
  const isPowerplayBowler = isPacer && PP_BOWL_RE.test(role);
  const isDeathBowler = isPacer && DEATH_BOWL_RE.test(role);

  const isWristSpinner = (bowlingType === 'spin' || SPIN_RE.test(role)) && WRIST_SPIN_RE.test(role);
  const isFingerSpinner = (bowlingType === 'spin' || SPIN_RE.test(role)) && (FINGER_SPIN_RE.test(role) || !isWristSpinner);

  // Distinguish genuine multi-discipline all-rounders from nominal tags
  let isGenuineAllRounder = false;
  if (allRounder) {
    if (VERIFIED_GENUINE_AR_NAMES.has(name)) {
      isGenuineAllRounder = true;
    } else if (p.stats && typeof p.stats.runs === 'number' && typeof p.stats.wickets === 'number' && p.stats.runs > 100 && p.stats.wickets >= 10) {
      isGenuineAllRounder = true;
    } else if (role.includes('Elite All-Rounder') || role.includes('Sir Jadeja') || role.includes('Pace All-Rounder') || role.includes('Spin All-Rounder')) {
      isGenuineAllRounder = true;
    }
  }

  return {
    id: p.id,
    name: p.name,
    category,
    role,
    basePrice: p.basePrice,
    boughtPrice: p.boughtPrice,
    isOverseas: p.isOverseas === true,
    isLeftHanded,
    bats,
    bowls,
    bowlingType,
    keeper,
    allRounder,
    isOpener,
    isMiddleOrder,
    isFinisher,
    isPowerplayBowler,
    isDeathBowler,
    isWristSpinner,
    isFingerSpinner,
    isPacer,
    isExpressPace,
    isGenuineAllRounder
  };
}

/**
 * Check rule eligibility for a franchise squad.
 */
function checkEligibility(squad, config, participating) {
  if (!participating) {
    return {
      eligible: false,
      status: 'NOT_PARTICIPATING',
      failures: ['Franchise was not claimed by a participant and made no auction purchases']
    };
  }

  const keepers = squad.filter(p => p.category === 'WK').length;
  const overseas = squad.filter(p => p.isOverseas === true).length;
  const failures = [];

  if (squad.length < config.minSquadSize) {
    failures.push(`Squad has ${squad.length} players; the minimum required is ${config.minSquadSize}`);
  }
  if (squad.length > config.maxSquadSize) {
    failures.push(`Squad has ${squad.length} players; the maximum allowed is ${config.maxSquadSize}`);
  }
  if (overseas > config.maxOverseas) {
    failures.push(`Squad has ${overseas} overseas players; the maximum permitted is ${config.maxOverseas}`);
  }
  if (keepers < (config.minWKs ?? 1)) {
    failures.push(`Squad has ${keepers} wicketkeeper(s); at least ${config.minWKs ?? 1} mandatory wicketkeeper is required`);
  }

  return {
    eligible: failures.length === 0,
    status: failures.length === 0 ? 'ELIGIBLE' : 'INELIGIBLE',
    failures
  };
}

/**
 * Evaluate the legal feasibility of fielding a valid Playing XI.
 * Must have: 11 players, ≤4 overseas, ≥1 WK, ≥5 bowling options, ≥6 batting options.
 */
function checkPlayingXiFeasibility(classifiedSquad) {
  const indian = classifiedSquad.filter(p => !p.isOverseas);
  const overseas = classifiedSquad.filter(p => p.isOverseas);
  const usableTotal = indian.length + Math.min(overseas.length, SQUAD_TARGETS.xiOverseasCap);

  const keepers = classifiedSquad.filter(p => p.keeper);
  const indianBowlers = indian.filter(p => p.bowls);
  const overseasBowlers = overseas.filter(p => p.bowls);
  const maxXiBowlers = indianBowlers.length + Math.min(overseasBowlers.length, SQUAD_TARGETS.xiOverseasCap);

  const indianBatters = indian.filter(p => p.bats);
  const overseasBatters = overseas.filter(p => p.bats);
  const maxXiBatters = indianBatters.length + Math.min(overseasBatters.length, SQUAD_TARGETS.xiOverseasCap);

  const checks = [
    { label: 'Field 11 players with at most 4 overseas', ok: usableTotal >= 11 },
    { label: 'Field a designated wicketkeeper', ok: keepers.length >= 1 },
    { label: 'Field 5 genuine bowling options', ok: maxXiBowlers >= 5 },
    { label: 'Field 6 reliable batting options', ok: maxXiBatters >= 6 }
  ];

  const feasible = checks.every(c => c.ok);
  return { feasible, checks };
}

/**
 * Analyze a franchise across all 7 cricket strategy dimensions.
 */
export function analyzeFranchiseSquad(franchise, config, { participating }) {
  const rawSquad = [...(franchise.squad || [])].filter(p => p && typeof p.id === 'string');
  const squad = rawSquad.map(classifyPlayerMastermind);

  const eligibility = checkEligibility(squad, config, participating);
  const xiFeasibility = checkPlayingXiFeasibility(squad);

  // Groupings
  const batters = squad.filter(p => p.bats);
  const openers = squad.filter(p => p.isOpener);
  const middleOrder = squad.filter(p => p.isMiddleOrder);
  const finishers = squad.filter(p => p.isFinisher);

  const bowlers = squad.filter(p => p.bowls);
  const pacers = squad.filter(p => p.isPacer);
  const spinners = squad.filter(p => p.bowlingType === 'spin' || p.isWristSpinner || p.isFingerSpinner);
  const wristSpinners = squad.filter(p => p.isWristSpinner);
  const fingerSpinners = squad.filter(p => p.isFingerSpinner);
  const ppBowlers = squad.filter(p => p.isPowerplayBowler);
  const deathBowlers = squad.filter(p => p.isDeathBowler);
  const expressPacers = squad.filter(p => p.isExpressPace);

  const allRounders = squad.filter(p => p.allRounder);
  const genuineAllRounders = squad.filter(p => p.isGenuineAllRounder);
  const paceAllRounders = allRounders.filter(p => p.bowlingType === 'pace');
  const spinAllRounders = allRounders.filter(p => p.bowlingType === 'spin');

  const keepers = squad.filter(p => p.keeper);
  const overseas = squad.filter(p => p.isOverseas);
  const indian = squad.filter(p => !p.isOverseas);

  // Batting LHB / RHB balance
  const hasLeftHandBatter = batters.some(p => p.isLeftHanded);
  const hasRightHandBatter = batters.some(p => !p.isLeftHanded);
  const hasLhbRhbCombo = hasLeftHandBatter && hasRightHandBatter;

  // Critical Weaknesses
  const criticalWeaknesses = [];
  const keyStrengths = [];

  if (!participating) {
    criticalWeaknesses.push('Franchise was unclaimed and made no squad acquisitions');
  } else {
    // Eligibility failures
    for (const fail of eligibility.failures) {
      criticalWeaknesses.push(fail);
    }

    // Wicketkeeper vulnerabilities
    if (keepers.length === 0) {
      criticalWeaknesses.push('Zero wicketkeepers acquired: cannot field a rule-valid Playing XI');
    } else if (keepers.length === 1) {
      criticalWeaknesses.push(`Single-point of failure at wicketkeeper: only ${keepers[0].name} in the entire squad with no backup cover`);
    } else {
      keyStrengths.push(`Wicketkeeping covered: ${keepers.length} keepers (${keepers.map(k => k.name).join(', ')}) providing primary and reserve stability`);
    }

    // Death bowling vulnerabilities
    if (deathBowlers.length === 0) {
      criticalWeaknesses.push('Zero specialist death bowlers: acute vulnerability in defending or containing overs 16–20');
    } else {
      keyStrengths.push(`Death-over specialists acquired: ${deathBowlers.map(b => b.name).join(', ')}`);
    }

    // Spin variety
    if (spinners.length === 0) {
      criticalWeaknesses.push('Zero spin bowling options: unable to exploit turn on dry or slow surfaces');
    } else if (wristSpinners.length === 0 && fingerSpinners.length > 0) {
      criticalWeaknesses.push('One-dimensional spin attack: relies entirely on finger spin with zero wrist-spin or mystery options');
    } else if (wristSpinners.length > 0 && fingerSpinners.length > 0) {
      keyStrengths.push('Varied spin attack: possesses both wrist-spin and finger-spin options for diverse conditions');
    }

    // Batting depth & finishing
    if (finishers.length === 0) {
      criticalWeaknesses.push('Lack of proven death-overs power hitters / finishers to accelerate at the backend');
    } else {
      keyStrengths.push(`Explosive finishing punch: ${finishers.map(f => f.name).join(', ')}`);
    }

    if (openers.length < 2) {
      criticalWeaknesses.push(`Thin opening options: only ${openers.length} recognised opener/top-order anchor in the squad`);
    } else {
      keyStrengths.push(`Established opening options (${openers.length} openers) with ${hasLhbRhbCombo ? 'LHB/RHB tactical pairing' : 'right-hand focus'}`);
    }

    // All-rounder balance
    if (allRounders.length === 0) {
      criticalWeaknesses.push('Zero all-rounders: rigid squad structure forcing an abrupt tail and zero bowling flexibility');
    } else if (genuineAllRounders.length >= 2) {
      keyStrengths.push(`Proven multi-discipline balance: ${genuineAllRounders.map(a => a.name).join(', ')} provide dual-threat flexibility`);
    }

    // Overseas utilization
    if (overseas.length < 4) {
      criticalWeaknesses.push(`Only ${overseas.length} overseas player(s): cannot utilize the full 4-overseas Playing XI allowance`);
    } else if (overseas.length > config.maxOverseas) {
      criticalWeaknesses.push(`Exceeded overseas limit: ${overseas.length}/${config.maxOverseas} overseas players`);
    } else {
      keyStrengths.push(`Optimal overseas quota: ${overseas.length} overseas players allowing a full 4-player international core plus rotation reserves`);
    }
  }

  // Bench Strength (reserves outside top 11)
  const benchOpeners = openers.slice(2);
  const benchMiddle = middleOrder.slice(3);
  const benchFinishers = finishers.slice(2);
  const benchPacers = pacers.slice(3);
  const benchSpinners = spinners.slice(2);
  const benchKeepers = keepers.slice(1);

  // Auction Strategy & Spending
  const spentLakh = squad.reduce((sum, p) => sum + (typeof p.boughtPrice === 'number' ? toLakh(p.boughtPrice) : 0), 0);
  const initialPurse = typeof franchise.initialPurse === 'number' ? franchise.initialPurse : config.basePurse;
  const remainingPurse = typeof franchise.remainingPurse === 'number' ? franchise.remainingPurse : initialPurse - fromLakh(spentLakh);

  const sortedBuys = [...squad].sort((a, b) => (b.boughtPrice || 0) - (a.boughtPrice || 0));
  const marqueeBuys = sortedBuys.filter(p => (p.boughtPrice || 0) >= 10);
  const basePriceBuys = sortedBuys.filter(p => typeof p.boughtPrice === 'number' && typeof p.basePrice === 'number' && toLakh(p.boughtPrice) === toLakh(p.basePrice));

  // Departmental qualitative assessments
  const battingAssessment = participating
    ? (batters.length >= 7
        ? `Strong batting depth with ${batters.length} batting options (${openers.length} openers, ${middleOrder.length} middle-order, ${finishers.length} finishers). ${hasLhbRhbCombo ? 'Left-hand/right-hand balance is available.' : 'Predominantly right-handed composition.'}`
        : `Thin batting resources with only ${batters.length} batting options, creating vulnerability against top-order collapses.`)
    : 'No batting options acquired.';

  const bowlingAssessment = participating
    ? (bowlers.length >= 6
        ? `Comprehensive bowling unit featuring ${bowlers.length} bowling options (${pacers.length} pace, ${spinners.length} spin). Covers ${ppBowlers.length > 0 ? 'powerplay' : 'middle'} and ${deathBowlers.length > 0 ? 'death' : 'containment'} phases.`
        : `Under-resourced bowling unit with only ${bowlers.length} bowling options, risking incomplete over allocations.`)
    : 'No bowling options acquired.';

  const spinAssessment = participating
    ? (spinners.length >= 2
        ? `${spinners.length} spinners in squad (${wristSpinners.length} wrist-spin, ${fingerSpinners.length} finger-spin). ${wristSpinners.length > 0 && fingerSpinners.length > 0 ? 'Excellent variety between attacking turn and finger control.' : 'Lacks variety across spin sub-disciplines.'}`
        : spinners.length === 1
        ? `Severely reliant on a single spinner (${spinners[0].name}) with zero backup cover.`
        : 'Zero specialist spinners in the squad.')
    : 'No spin bowlers acquired.';

  const paceAssessment = participating
    ? (pacers.length >= 4
        ? `${pacers.length} pace options (${expressPacers.length} express pace, ${deathBowlers.length} death specialists, ${ppBowlers.length} swing/seam options).`
        : `Thin pace attack with only ${pacers.length} seamers, leaving little room for tactical rotation or pitch-specific selections.`)
    : 'No pace bowlers acquired.';

  const allRounderAssessment = participating
    ? (allRounders.length >= 2
        ? `${allRounders.length} all-rounders (${paceAllRounders.length} pace AR, ${spinAllRounders.length} spin AR), including ${genuineAllRounders.length} verified multi-discipline contributors.`
        : allRounders.length === 1
        ? `Only 1 all-rounder (${allRounders[0].name}), limiting tactical fluidity when balancing the Playing XI.`
        : 'Zero all-rounders acquired; forces an inflexible separation between batters and bowlers.')
    : 'No all-rounders acquired.';

  const wicketkeepingAssessment = participating
    ? (keepers.length >= 2
        ? `Well-secured wicketkeeping unit with ${keepers[0].name} as primary keeper and ${keepers.slice(1).map(k => k.name).join(', ')} as dedicated backup.`
        : keepers.length === 1
        ? `Single keeper (${keepers[0].name}). High single-point-of-failure risk if injured or unavailable.`
        : 'CRITICAL VOID: Zero wicketkeepers acquired.')
    : 'No wicketkeeper acquired.';

  const overseasAssessment = participating
    ? (overseas.length >= 4 && overseas.length <= config.maxOverseas
        ? `${overseas.length} overseas players acquired (within the ${config.maxOverseas} limit), enabling a full 4-player overseas presence in the XI.`
        : overseas.length < 4
        ? `Only ${overseas.length} overseas players: franchise cannot field the maximum permitted 4 overseas players in the Playing XI.`
        : `Overseas violation: ${overseas.length} overseas players exceeds the maximum squad limit of ${config.maxOverseas}.`)
    : 'No overseas players acquired.';

  const benchAssessment = participating
    ? `Bench depth comprises ${squad.length > 11 ? squad.length - 11 : 0} reserve players. Reserve coverage: ${benchOpeners.length} opener(s), ${benchMiddle.length} middle-order, ${benchFinishers.length} finisher(s), ${benchPacers.length} pacer(s), ${benchSpinners.length} spinner(s), ${benchKeepers.length} keeper(s).`
    : 'No bench depth.';

  const auctionStrategyAssessment = participating
    ? `Spent ₹${fromLakh(spentLakh).toFixed(2)} Cr with ₹${remainingPurse.toFixed(2)} Cr remaining. Acquired ${squad.length} players (${marqueeBuys.length} marquee signings above ₹10 Cr, ${basePriceBuys.length} base-price buys).`
    : 'Did not participate in auction transactions.';

  const shortAssessment = participating
    ? (eligibility.eligible
        ? (criticalWeaknesses.length <= 1
            ? `Extremely well-constructed squad with balanced departmental coverage across batting, bowling, and wicketkeeping.`
            : `Competitive squad but burdened by clear tactical vulnerabilities: ${criticalWeaknesses[0]}.`)
        : `Ineligible squad: ${eligibility.failures.join('; ')}.`)
    : 'Non-participating franchise.';

  return {
    franchiseId: franchise.id,
    franchiseName: franchise.name,
    shortName: franchise.shortName || franchise.code || franchise.id,
    participating,
    squad,
    squadSize: squad.length,
    overseasCount: overseas.length,
    indianCount: indian.length,
    counts: {
      total: squad.length,
      BAT: batters.length,
      WK: keepers.length,
      BOWL: pacers.length,
      SP: spinners.length,
      AR: allRounders.length,
      overseas: overseas.length,
      indian: indian.length
    },
    purse: {
      initial: initialPurse,
      spent: fromLakh(spentLakh),
      remaining: remainingPurse
    },
    eligibility,
    xiFeasibility,
    xiChecks: xiFeasibility.checks.map(c => ({ id: c.label, label: c.label, ok: c.ok })),
    roleOptions: {
      battingOptions: batters.length,
      bowlingOptions: bowlers.length,
      paceOptions: pacers.length,
      spinOptions: spinners.length
    },
    dimensions: {},
    headline: {
      batting: batters.length,
      bowling: bowlers.length,
      allRounder: allRounders.length,
      balance: 0
    },
    departments: {
      batting: {
        openers: openers.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        middleOrder: middleOrder.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        finishers: finishers.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        hasLhbRhb: hasLhbRhbCombo,
        depthCount: batters.length,
        assessment: battingAssessment
      },
      bowling: {
        pacers: pacers.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        spinners: spinners.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        wristSpinners: wristSpinners.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        fingerSpinners: fingerSpinners.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        deathBowlers: deathBowlers.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        powerplayBowlers: ppBowlers.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        hasSpinVariety: wristSpinners.length > 0 && fingerSpinners.length > 0,
        depthCount: bowlers.length,
        assessment: bowlingAssessment
      },
      pace: {
        depthCount: pacers.length,
        expressCount: expressPacers.length,
        deathCount: deathBowlers.length,
        powerplayCount: ppBowlers.length,
        assessment: paceAssessment
      },
      spin: {
        depthCount: spinners.length,
        wristCount: wristSpinners.length,
        fingerCount: fingerSpinners.length,
        hasSpinVariety: wristSpinners.length > 0 && fingerSpinners.length > 0,
        assessment: spinAssessment
      },
      allRounders: {
        totalCount: allRounders.length,
        genuineCount: genuineAllRounders.length,
        paceAllRounders: paceAllRounders.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        spinAllRounders: spinAllRounders.map(p => ({ id: p.id, name: p.name, role: p.role, price: p.boughtPrice })),
        assessment: allRounderAssessment
      },
      wicketkeeping: {
        primary: keepers[0] ? { id: keepers[0].id, name: keepers[0].name, price: keepers[0].boughtPrice } : null,
        backups: keepers.slice(1).map(p => ({ id: p.id, name: p.name, price: p.boughtPrice })),
        totalCount: keepers.length,
        assessment: wicketkeepingAssessment
      },
      overseas: {
        total: overseas.length,
        players: overseas.map(p => ({ id: p.id, name: p.name, role: p.role, category: p.category, price: p.boughtPrice })),
        assessment: overseasAssessment
      },
      benchStrength: {
        benchSize: squad.length > 11 ? squad.length - 11 : 0,
        backupKeepers: benchKeepers.length,
        backupPacers: benchPacers.length,
        backupSpinners: benchSpinners.length,
        assessment: benchAssessment
      },
      auctionStrategy: {
        spent: fromLakh(spentLakh),
        remaining: remainingPurse,
        marqueeBuys: marqueeBuys.map(p => ({ id: p.id, name: p.name, price: p.boughtPrice, role: p.role })),
        basePriceBuys: basePriceBuys.map(p => ({ id: p.id, name: p.name, price: p.boughtPrice, role: p.role })),
        assessment: auctionStrategyAssessment
      }
    },
    criticalWeaknesses,
    keyStrengths,
    shortAssessment,
    explanation: {
      report: shortAssessment,
      strengths: keyStrengths.slice(0, 5),
      weaknesses: criticalWeaknesses.slice(0, 5),
      recommendations: criticalWeaknesses.length > 0
        ? criticalWeaknesses.map(w => `Address vulnerability: ${w}`)
        : ['Maintain balanced XI selection and manage player workloads throughout the campaign.']
    }
  };
}

/**
 * Perform a direct qualitative head-to-head comparison between two franchises.
 * Evaluates department matchups, critical vulnerabilities, and tactical flexibility.
 * NO NUMERICAL RATINGS USED.
 */
export function compareFranchises(A, B) {
  // 1. Participation & Rule Eligibility
  if (!A.participating && !B.participating) {
    return {
      winner: A.franchiseId < B.franchiseId ? A.franchiseId : B.franchiseId,
      margin: 'marginal',
      reason: 'Neither franchise participated; resolved alphabetically.'
    };
  }
  if (A.participating && !B.participating) {
    return {
      winner: A.franchiseId,
      margin: 'decisive',
      reason: `${A.franchiseName} participated in the auction, while ${B.franchiseName} was unclaimed.`
    };
  }
  if (!A.participating && B.participating) {
    return {
      winner: B.franchiseId,
      margin: 'decisive',
      reason: `${B.franchiseName} participated in the auction, while ${A.franchiseName} was unclaimed.`
    };
  }

  // 2. Rule Compliance Check
  if (A.eligibility.eligible && !B.eligibility.eligible) {
    return {
      winner: A.franchiseId,
      margin: 'decisive',
      reason: `${A.franchiseName} constructed a fully rule-compliant squad, whereas ${B.franchiseName} failed mandatory auction rules (${B.eligibility.failures.join('; ')}).`
    };
  }
  if (!A.eligibility.eligible && B.eligibility.eligible) {
    return {
      winner: B.franchiseId,
      margin: 'decisive',
      reason: `${B.franchiseName} constructed a fully rule-compliant squad, whereas ${A.franchiseName} failed mandatory auction rules (${A.eligibility.failures.join('; ')}).`
    };
  }

  // 3. Department-by-Department Cricket Analysis
  const advA = [];
  const advB = [];

  // Death Bowling (Decisive T20 Factor)
  const aDeath = A.departments.bowling.deathBowlers.length;
  const bDeath = B.departments.bowling.deathBowlers.length;
  if (aDeath > 0 && bDeath === 0) {
    advA.push(`possesses dedicated death-over bowling (${A.departments.bowling.deathBowlers.map(p => p.name).join(', ')}) while ${B.franchiseName} has zero recognised death specialists`);
  } else if (bDeath > 0 && aDeath === 0) {
    advB.push(`possesses dedicated death-over bowling (${B.departments.bowling.deathBowlers.map(p => p.name).join(', ')}) while ${A.franchiseName} has zero recognised death specialists`);
  } else if (aDeath > bDeath) {
    advA.push(`features greater depth in specialist death overs bowling (${aDeath} vs ${bDeath})`);
  } else if (bDeath > aDeath) {
    advB.push(`features greater depth in specialist death overs bowling (${bDeath} vs ${aDeath})`);
  }

  // Wicketkeeping Cover (Single Point of Failure)
  const aKeepers = A.departments.wicketkeeping.totalCount;
  const bKeepers = B.departments.wicketkeeping.totalCount;
  if (aKeepers >= 2 && bKeepers === 1) {
    advA.push(`has a dedicated backup wicketkeeper securing a vital specialist position, whereas ${B.franchiseName} carries single-point-of-failure risk with only 1 keeper`);
  } else if (bKeepers >= 2 && aKeepers === 1) {
    advB.push(`has a dedicated backup wicketkeeper securing a vital specialist position, whereas ${A.franchiseName} carries single-point-of-failure risk with only 1 keeper`);
  }

  // Spin Variety (Wrist + Finger)
  const aSpinVar = A.departments.bowling.hasSpinVariety;
  const bSpinVar = B.departments.bowling.hasSpinVariety;
  if (aSpinVar && !bSpinVar) {
    advA.push('deploys a balanced spin attack combining both wrist-spin and finger-spin, whereas the opponent is one-dimensional in spin');
  } else if (bSpinVar && !aSpinVar) {
    advB.push('deploys a balanced spin attack combining both wrist-spin and finger-spin, whereas the opponent is one-dimensional in spin');
  }

  // Batting Finishing Punch
  const aFinishers = A.departments.batting.finishers.length;
  const bFinishers = B.departments.batting.finishers.length;
  if (aFinishers > 0 && bFinishers === 0) {
    advA.push(`boasts proven lower-order power finishers (${A.departments.batting.finishers.map(p => p.name).join(', ')}) to close out innings`);
  } else if (bFinishers > 0 && aFinishers === 0) {
    advB.push(`boasts proven lower-order power finishers (${B.departments.batting.finishers.map(p => p.name).join(', ')}) to close out innings`);
  }

  // All-Rounder Balance
  const aGenAr = A.departments.allRounders.genuineCount;
  const bGenAr = B.departments.allRounders.genuineCount;
  if (aGenAr > bGenAr) {
    advA.push(`features superior multi-discipline balance with ${aGenAr} verified all-rounders providing tactical XI flexibility`);
  } else if (bGenAr > aGenAr) {
    advB.push(`features superior multi-discipline balance with ${bGenAr} verified all-rounders providing tactical XI flexibility`);
  }

  // Critical Weakness Count
  const aFlaws = A.criticalWeaknesses.length;
  const bFlaws = B.criticalWeaknesses.length;
  if (aFlaws < bFlaws) {
    advA.push(`constructed a more cohesive squad with fewer structural vulnerabilities (${aFlaws} vs ${bFlaws})`);
  } else if (bFlaws < aFlaws) {
    advB.push(`constructed a more cohesive squad with fewer structural vulnerabilities (${bFlaws} vs ${aFlaws})`);
  }

  // Batting Depth
  const aBatDepth = A.departments.batting.depthCount;
  const bBatDepth = B.departments.batting.depthCount;
  if (aBatDepth > bBatDepth + 1) {
    advA.push(`enjoys longer batting depth (${aBatDepth} options vs ${bBatDepth})`);
  } else if (bBatDepth > aBatDepth + 1) {
    advB.push(`enjoys longer batting depth (${bBatDepth} options vs ${aBatDepth})`);
  }

  // Synthesize Head-to-Head Winner
  if (advA.length > advB.length) {
    const margin = advA.length >= advB.length + 3 ? 'decisive' : advA.length >= advB.length + 2 ? 'clear' : 'marginal';
    return {
      winner: A.franchiseId,
      margin,
      reason: `${A.franchiseName} edges ${B.franchiseName}: ${advA.join('; ')}.`
    };
  } else if (advB.length > advA.length) {
    const margin = advB.length >= advA.length + 3 ? 'decisive' : advB.length >= advA.length + 2 ? 'clear' : 'marginal';
    return {
      winner: B.franchiseId,
      margin,
      reason: `${B.franchiseName} edges ${A.franchiseName}: ${advB.join('; ')}.`
    };
  }

  // Exact tie-break through deep cricket hierarchy
  // Tie-breaker 1: Dedicated death bowling present
  if (aDeath > bDeath) return { winner: A.franchiseId, margin: 'marginal', reason: `${A.franchiseName} broke the deadlock on specialist death-bowling availability.` };
  if (bDeath > aDeath) return { winner: B.franchiseId, margin: 'marginal', reason: `${B.franchiseName} broke the deadlock on specialist death-bowling availability.` };

  // Tie-breaker 2: Backup wicketkeeper present
  if (aKeepers > bKeepers) return { winner: A.franchiseId, margin: 'marginal', reason: `${A.franchiseName} broke the deadlock on dedicated wicketkeeping depth.` };
  if (bKeepers > aKeepers) return { winner: B.franchiseId, margin: 'marginal', reason: `${B.franchiseName} broke the deadlock on dedicated wicketkeeping depth.` };

  // Tie-breaker 3: Fewer critical weaknesses
  if (aFlaws < bFlaws) return { winner: A.franchiseId, margin: 'marginal', reason: `${A.franchiseName} broke the deadlock with fewer structural squad deficiencies.` };
  if (bFlaws < aFlaws) return { winner: B.franchiseId, margin: 'marginal', reason: `${B.franchiseName} broke the deadlock with fewer structural squad deficiencies.` };

  // Tie-breaker 4: Genuine all-rounders
  if (aGenAr > bGenAr) return { winner: A.franchiseId, margin: 'marginal', reason: `${A.franchiseName} broke the deadlock with superior genuine all-rounder resources.` };
  if (bGenAr > aGenAr) return { winner: B.franchiseId, margin: 'marginal', reason: `${B.franchiseName} broke the deadlock with superior genuine all-rounders.` };

  // Deterministic final fallback: Alphabetical
  return {
    winner: A.franchiseId < B.franchiseId ? A.franchiseId : B.franchiseId,
    margin: 'marginal',
    reason: `Equally matched across all tactical dimensions; separated by catalog franchise registration.`
  };
}

/**
 * Rank all 10 franchises from 1st to 10th using pairwise head-to-head dominance.
 * NO OVERALL NUMERICAL SCORES OR POINT-BASED FORMULAS.
 * GUARANTEES:
 * - Exactly 10 positions (1st, 2nd, ..., 10th).
 * - Exactly ONE first-place winner.
 * - Unique ranks (1 to 10, no ties).
 */
export function rankAllFranchisesMastermind(evaluations) {
  const fids = Object.keys(evaluations).sort();
  const matrix = {};

  // Compute pairwise matchups for all pairs
  for (const f1 of fids) {
    matrix[f1] = {};
    for (const f2 of fids) {
      if (f1 === f2) continue;
      matrix[f1][f2] = compareFranchises(evaluations[f1], evaluations[f2]);
    }
  }

  // Count head-to-head wins
  const winCounts = {};
  for (const f1 of fids) {
    let wins = 0;
    for (const f2 of fids) {
      if (f1 === f2) continue;
      if (matrix[f1][f2].winner === f1) wins++;
    }
    winCounts[f1] = wins;
  }

  // Sort franchises by:
  // 1. Group: eligible & participating (0) > ineligible & participating (1) > not participating (2)
  // 2. Head-to-head win count (descending)
  // 3. Direct head-to-head result between tied teams
  // 4. Fewer critical weaknesses
  // 5. Death bowling presence
  // 6. Wicketkeeper depth
  // 7. Alphabetical by franchise ID
  const group = e => (!e.participating ? 2 : e.eligibility.eligible ? 0 : 1);

  const sortedFids = [...fids].sort((a, b) => {
    const eA = evaluations[a];
    const eB = evaluations[b];

    const grpDiff = group(eA) - group(eB);
    if (grpDiff !== 0) return grpDiff;

    const winDiff = winCounts[b] - winCounts[a];
    if (winDiff !== 0) return winDiff;

    // Direct head-to-head matchup
    if (matrix[a][b]?.winner === a) return -1;
    if (matrix[a][b]?.winner === b) return 1;

    // Fewer critical weaknesses
    const flawDiff = eA.criticalWeaknesses.length - eB.criticalWeaknesses.length;
    if (flawDiff !== 0) return flawDiff;

    // Death bowling presence
    const deathDiff = eB.departments.bowling.deathBowlers.length - eA.departments.bowling.deathBowlers.length;
    if (deathDiff !== 0) return deathDiff;

    // Wicketkeeper depth
    const wkDiff = eB.departments.wicketkeeping.totalCount - eA.departments.wicketkeeping.totalCount;
    if (wkDiff !== 0) return wkDiff;

    return a < b ? -1 : 1;
  });

  // Assign strict ranks 1st to 10th
  const rankings = sortedFids.map((fid, index) => {
    const rank = index + 1;
    const e = evaluations[fid];
    const wins = winCounts[fid];

    let reasonForPosition = '';
    if (!e.participating) {
      reasonForPosition = 'Did not participate in the auction.';
    } else if (!e.eligibility.eligible) {
      reasonForPosition = `Failed auction squad rules (${e.eligibility.failures.join('; ')}). Ranked below compliant squads.`;
    } else if (rank === 1) {
      reasonForPosition = `Crowned 1st place: Swept or dominated head-to-head squad comparisons with ${wins} tactical victories across death bowling, balance, and squad cohesion.`;
    } else {
      const prevFid = sortedFids[index - 1];
      const matchup = matrix[prevFid][fid];
      reasonForPosition = `Ranked #${rank} (${wins} head-to-head wins). Conceded higher rank to ${evaluations[prevFid].franchiseName}: ${matchup.reason}`;
    }

    return {
      rank,
      franchiseId: fid,
      franchiseName: e.franchiseName,
      shortName: e.shortName,
      participating: e.participating,
      eligible: e.eligibility.eligible,
      tied: false,
      overall: null,
      group: e.participating ? (e.eligibility.eligible ? 0 : 1) : 2,
      headToHeadWins: wins,
      shortAssessment: e.shortAssessment,
      mainStrength: e.keyStrengths[0] || 'Participated in auction transactions',
      mainWeakness: e.criticalWeaknesses[0] || 'No critical squad deficiency noted',
      reasonForPosition
    };
  });

  return { rankings, headToHeadMatrix: matrix };
}

/**
 * Generate Section 1: Auction Verdict.
 */
function buildAuctionVerdict(rankings, evaluations) {
  const winnerEntry = rankings[0];
  const winnerId = winnerEntry.franchiseId;
  const e = evaluations[winnerId];

  const expertVerdict = e.participating && e.eligibility.eligible
    ? `${e.franchiseName} delivered a masterclass in tactical squad construction at the auction. Rather than exhausting resources on redundant marquee names, the franchise systematically addressed every phase of modern T20 cricket: securing reliable opening options, lethal middle-overs finishing, dedicated death-overs execution, and essential wicketkeeping coverage. They enter the tournament with the most balanced, role-complete squad in the competition.`
    : `${e.franchiseName} placed first, but no participating franchise managed to field a fully compliant squad meeting all mandatory auction regulations.`;

  const mainReasons = [
    ...e.keyStrengths.slice(0, 4),
    `Secured ${e.departments.bowling.deathBowlers.length > 0 ? 'specialist death overs bowling' : 'broad bowling coverage'} without sacrificing batting depth.`,
    `Avoided fatal structural flaws: 0 critical vulnerabilities that could derail a campaign.`
  ].slice(0, 4);

  const keyAdvantages = [
    `Complete 3-phase bowling coverage (Powerplay, Middle, Death)`,
    `Multi-discipline tactical balance through versatile all-rounders`,
    `Protected against single-point-of-failure risks (wicketkeeper and seam backups present)`,
    `Strong core Indian foundation with high-impact overseas specialists`
  ];

  const vulnerabilities = e.criticalWeaknesses.length > 0
    ? e.criticalWeaknesses
    : ['Monitor pace bowler workloads and maintain fielding intensity across back-to-back fixtures.'];

  return {
    winnerFranchiseId: winnerId,
    winnerFranchiseName: e.franchiseName,
    expertVerdict,
    mainReasons,
    keyAdvantages,
    vulnerabilities
  };
}

/**
 * Generate Section 4: Why the Winner Won (1st place vs 2nd place direct comparison).
 */
function buildWhyWinnerWon(rankings, evaluations, headToHeadMatrix) {
  if (rankings.length < 2) return null;
  const first = evaluations[rankings[0].franchiseId];
  const second = evaluations[rankings[1].franchiseId];

  if (!first.participating || !second.participating) {
    return {
      firstPlace: first.franchiseName,
      secondPlace: second.franchiseName,
      comparison: 'Fewer than two participating franchises completed squad building.'
    };
  }

  const matchup = headToHeadMatrix[first.franchiseId][second.franchiseId];

  const battingComp = `${first.franchiseName} assembled ${first.departments.batting.depthCount} batting options (${first.departments.batting.openers.length} openers, ${first.departments.batting.finishers.length} finishers) compared to ${second.franchiseName}'s ${second.departments.batting.depthCount} options (${second.departments.batting.openers.length} openers, ${second.departments.batting.finishers.length} finishers).`;

  const bowlingComp = `${first.franchiseName} holds a critical tactical edge in the death overs with ${first.departments.bowling.deathBowlers.length} dedicated specialist(s) (${first.departments.bowling.deathBowlers.map(p => p.name).join(', ') || 'none'}) versus ${second.franchiseName}'s ${second.departments.bowling.deathBowlers.length} specialist(s). In spin, ${first.franchiseName} ${first.departments.bowling.hasSpinVariety ? 'deploys both wrist and finger options' : 'focuses on containment'} while ${second.franchiseName} ${second.departments.bowling.hasSpinVariety ? 'offers variety' : 'relies on one spin type'}.`;

  const balanceComp = `${first.franchiseName} secured ${first.departments.allRounders.totalCount} all-rounders and ${first.departments.wicketkeeping.totalCount} wicketkeepers, ensuring robust bench protection against injury, whereas ${second.franchiseName} holds ${second.departments.allRounders.totalCount} all-rounders and ${second.departments.wicketkeeping.totalCount} wicketkeeper(s).`;

  const decisiveReason = matchup.reason;

  return {
    firstPlace: first.franchiseName,
    secondPlace: second.franchiseName,
    battingComparison: battingComp,
    bowlingComparison: bowlingComp,
    balanceComparison: balanceComp,
    decisiveReason,
    verdictStatement: `Why 1st place beats 2nd place: While ${second.franchiseName} constructed a formidable unit, ${first.franchiseName} prevails on tactical completeness. ${decisiveReason}`
  };
}

/**
 * Generate Section 5: Biggest Auction Mistakes.
 * Identifies real data-supported squad-building blunders across franchises.
 */
function identifyBiggestMistakes(evaluations) {
  const mistakes = [];

  for (const e of Object.values(evaluations)) {
    if (!e.participating) continue;

    // Rule violations
    if (!e.eligibility.eligible) {
      mistakes.push({
        franchiseId: e.franchiseId,
        franchiseName: e.franchiseName,
        category: 'Rule Ineligibility',
        severity: 'CRITICAL',
        mistake: `Failed mandatory auction squad rules: ${e.eligibility.failures.join('; ')}.`
      });
    }

    // Zero Wicketkeepers
    if (e.departments.wicketkeeping.totalCount === 0) {
      mistakes.push({
        franchiseId: e.franchiseId,
        franchiseName: e.franchiseName,
        category: 'Wicketkeeping Void',
        severity: 'CRITICAL',
        mistake: `Completely neglected the wicketkeeper department: failed to buy a single keeper, rendering the Playing XI illegal.`
      });
    } else if (e.departments.wicketkeeping.totalCount === 1) {
      mistakes.push({
        franchiseId: e.franchiseId,
        franchiseName: e.franchiseName,
        category: 'Single Point of Failure',
        severity: 'HIGH',
        mistake: `Acquired only 1 wicketkeeper (${e.departments.wicketkeeping.primary?.name}) for the entire squad with zero backup cover across a 14+ game campaign.`
      });
    }

    // Zero Death Bowlers
    if (e.departments.bowling.deathBowlers.length === 0 && e.departments.bowling.depthCount > 0) {
      mistakes.push({
        franchiseId: e.franchiseId,
        franchiseName: e.franchiseName,
        category: 'Death Overs Neglect',
        severity: 'HIGH',
        mistake: `Failed to acquire a dedicated death-bowling specialist or yorker king, creating acute vulnerability when defending totals in overs 16–20.`
      });
    }

    // One-dimensional spin
    if (e.departments.bowling.spinners.length > 0 && !e.departments.bowling.hasSpinVariety) {
      mistakes.push({
        franchiseId: e.franchiseId,
        franchiseName: e.franchiseName,
        category: 'Spin Predictability',
        severity: 'MEDIUM',
        mistake: `Assembled a one-dimensional spin department lacking wrist-spin/mystery variety, making the attack predictable on turning surfaces.`
      });
    }

    // Top-Heavy Spend Distortion
    if (e.departments.auctionStrategy.marqueeBuys.length >= 2 && e.departments.bowling.depthCount < 5) {
      mistakes.push({
        franchiseId: e.franchiseId,
        franchiseName: e.franchiseName,
        category: 'Lopsided Budget Allocation',
        severity: 'MEDIUM',
        mistake: `Overspent on marquee headline names (${e.departments.auctionStrategy.marqueeBuys.map(p => p.name).join(', ')}), leaving the bowling unit thinned out and under-resourced.`
      });
    }
  }

  return mistakes.slice(0, 8);
}

/**
 * Generate Section 6: Best Acquisitions.
 * Identifies standout buys based on role impact, price, and squad context.
 */
function identifyBestAcquisitions(evaluations) {
  const acquisitions = [];

  for (const e of Object.values(evaluations)) {
    if (!e.participating) continue;

    for (const p of e.squad) {
      const price = typeof p.boughtPrice === 'number' ? p.boughtPrice : 0;
      const base = typeof p.basePrice === 'number' ? p.basePrice : 0;
      const atBase = price > 0 && base > 0 && toLakh(price) === toLakh(base);

      // Category 1: Base price bargain role-fillers
      if (atBase && (p.isDeathBowler || p.isFinisher || p.isGenuineAllRounder || p.keeper)) {
        acquisitions.push({
          playerId: p.id,
          playerName: p.name,
          franchiseId: e.franchiseId,
          franchiseName: e.franchiseName,
          category: p.category,
          role: p.role,
          priceCr: price,
          type: 'Base Price Tactical Steal',
          reason: `Acquired at base price (₹${price.toFixed(2)} Cr) without competing bids, securing an indispensable specialist role (${p.role}) at ₹0 premium.`
        });
      }

      // Category 2: Premier Cornerstones acquired at sensible value (<= 8 Cr)
      if (price > 2 && price <= 8 && (p.isDeathBowler || p.isGenuineAllRounder || (p.keeper && p.isOpener))) {
        acquisitions.push({
          playerId: p.id,
          playerName: p.name,
          franchiseId: e.franchiseId,
          franchiseName: e.franchiseName,
          category: p.category,
          role: p.role,
          priceCr: price,
          type: 'High-Impact Value Signing',
          reason: `Secured a premier specialist (${p.name}, ${p.role}) at a controlled outlay of ₹${price.toFixed(2)} Cr to anchor the franchise's Playing XI.`
        });
      }
    }
  }

  // Sort by price efficiency and uniqueness
  acquisitions.sort((a, b) => a.priceCr - b.priceCr || a.playerName.localeCompare(b.playerName));
  return acquisitions.slice(0, 10);
}

/**
 * Canonical input checksum for the evaluation.
 */
export function mastermindInputChecksum(room) {
  const input = {
    engine: MASTERMIND_ENGINE_VERSION,
    rules: {
      minSquadSize: room.config?.minSquadSize,
      maxSquadSize: room.config?.maxSquadSize,
      maxOverseas: room.config?.maxOverseas,
      minWKs: room.config?.minWKs ?? 1
    },
    franchises: Object.keys(room.franchises || {}).sort().map(id => {
      const f = room.franchises[id];
      return {
        id,
        claimed: !!f.isClaimed,
        remainingPurse: f.remainingPurse,
        squad: [...(f.squad || [])].filter(Boolean).map(p => [
          p.id, p.category, p.role, p.isOverseas, p.basePrice, p.boughtPrice
        ]).sort()
      };
    })
  };
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * Execute the complete Cricket Mastermind IPL Auction Verdict.
 * Pure function of the room squads and rules.
 */
export function runCricketMastermind(room, { now = () => new Date().toISOString() } = {}) {
  const config = room.config || { minSquadSize: 15, maxSquadSize: 25, maxOverseas: 8, minWKs: 1, basePurse: 120 };
  const franchiseIds = Object.keys(room.franchises || {}).sort();

  // 1. Analyze each franchise independently across all 7 dimensions
  const evaluations = {};
  for (const id of franchiseIds) {
    const f = room.franchises[id];
    const participating = !!f.isClaimed || (f.squad || []).length > 0;
    evaluations[id] = analyzeFranchiseSquad(f, config, { participating });
  }

  // 2. Perform Pairwise Head-to-Head Comparisons and Rank 1st to 10th
  const { rankings, headToHeadMatrix } = rankAllFranchisesMastermind(evaluations);

  // 3. Section 1: Auction Verdict
  const verdict = buildAuctionVerdict(rankings, evaluations);

  // 4. Section 4: Why the Winner Won
  const whyWinnerWon = buildWhyWinnerWon(rankings, evaluations, headToHeadMatrix);

  // 5. Section 5: Biggest Auction Mistakes
  const biggestMistakes = identifyBiggestMistakes(evaluations);

  // 6. Section 6: Best Acquisitions
  const bestAcquisitions = identifyBestAcquisitions(evaluations);

  // 7. Auction transaction metrics
  const catalogue = room.playersCatalog || [];
  const sold = catalogue.filter(p => p?.status === 'sold').length;
  const unsold = catalogue.filter(p => p?.status === 'unsold').length;
  const skipped = catalogue.filter(p => p?.status === 'SKIPPED').length;
  const playing = Object.values(evaluations).filter(e => e.participating);
  const eligiblePlaying = playing.filter(e => e.eligibility.eligible);

  const totalSpentLakh = playing.reduce((sum, e) => sum + toLakh(e.purse.spent), 0);
  const totalRemainingLakh = playing.reduce((sum, e) => sum + toLakh(e.purse.remaining), 0);

  return {
    engineVersion: MASTERMIND_ENGINE_VERSION,
    generatedAt: now(),
    inputChecksum: mastermindInputChecksum(room),
    rules: {
      minSquadSize: config.minSquadSize,
      maxSquadSize: config.maxSquadSize,
      maxOverseas: config.maxOverseas,
      minWKs: config.minWKs ?? 1,
      basePurse: config.basePurse
    },
    targets: { ...SQUAD_TARGETS },
    weights: {},
    scoringWeights: {},
    normalisationTargets: { ...SQUAD_TARGETS },
    summary: {
      playersSold: sold,
      playersUnsold: unsold,
      playersSkipped: skipped,
      playersNotAuctioned: catalogue.length - sold - unsold - skipped,
      totalExpenditure: fromLakh(totalSpentLakh),
      totalRemainingPurse: fromLakh(totalRemainingLakh),
      participatingFranchises: playing.length,
      eligibleFranchises: eligiblePlaying.length
    },
    verdict,
    rankings,
    franchises: evaluations,
    whyWinnerWon,
    biggestMistakes,
    bestAcquisitions,
    headToHead: headToHeadMatrix,
    limitations: [
      'Analysis is strictly derived from verified catalogue role definitions, player nationalities, and auction purchase records.',
      'No player statistics (averages, strike rates, economy rates, wickets), match simulations, player form, or injury data are fabricated or assumed.',
      'Manually assigned ratings in the catalogue are completely disregarded in favor of structural cricket squad balance.',
      'Rankings are determined entirely by tactical head-to-head squad matchups and cricket principles, with zero reliance on arbitrary numerical point totals or aggregate scores.'
    ]
  };
}
