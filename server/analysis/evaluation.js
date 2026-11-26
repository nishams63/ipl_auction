// Deterministic post-auction evaluation (engine "eval-2").
//
// A pure function of the room's final squads and rules: identical input -> identical output.
// Uses only attributes that are facts of this game: player category (BAT/WK/BOWL/SP/AR), the
// catalogue's role label (to tell pace from spin for all-rounders), overseas status, base and
// purchase prices, squad membership and the room's rule configuration.
//
// Deliberately NOT used for scoring: the catalogue's `rating` (80–99) and `stats` fields. They are
// hand-entered in buildPlayers.js with no source or date, so they cannot be treated as verified
// performance data (see docs/POST_AUCTION_ANALYSIS.md).
//
// Rule eligibility (min/max squad, overseas cap, keepers) is reported separately from the
// quality score and is evaluated against the room's OWN rules (interrupted legacy auctions keep
// the rules they started with).
import crypto from 'node:crypto';
import { toLakh, fromLakh } from '../money.js';
import { getRoomSquadLimits } from '../config.js';
import { runCricketMastermind, MASTERMIND_ENGINE_VERSION } from './cricketMastermind.js';

export { runCricketMastermind, MASTERMIND_ENGINE_VERSION };
export const ENGINE_VERSION = 'eval-2';

// Normalisation targets: a standard T20 squad template (documented in the methodology).
export const TARGETS = Object.freeze({
  battingOptions: 9, // XI uses 6–7 batting options; 2–3 more for depth/injury cover
  bowlingOptions: 9, // XI uses 5–6 bowling options; 3 more for depth
  paceOptions: 5,
  spinOptions: 3,
  allRounders: 3,
  keepers: 2,        // 1 required by the rules, 1 backup
  xiOverseasSlots: 4, // overseas players allowed in an IPL Playing XI
  // Role mix of a balanced 25-player squad (6 BAT, 3 WK, 6 AR, 6 pace, 4 spin)
  compositionShares: Object.freeze({ BAT: 0.24, WK: 0.12, AR: 0.24, BOWL: 0.24, SP: 0.16 })
});

// Weights of the overall score (sum = 100)
export const WEIGHTS = Object.freeze({
  battingDepth: 15,
  bowlingDepth: 15,
  paceOptions: 10,
  spinOptions: 10,
  allRounders: 10,
  keeperCoverage: 10,
  overseasBalance: 5,
  squadDepth: 10,
  squadComposition: 10,
  xiCompatibility: 5
});

export const DIMENSION_LABELS = Object.freeze({
  battingDepth: 'Batting depth',
  bowlingDepth: 'Bowling depth',
  paceOptions: 'Pace bowling options',
  spinOptions: 'Spin bowling options',
  allRounders: 'All-rounders',
  keeperCoverage: 'Wicketkeeper coverage',
  overseasBalance: 'Overseas balance',
  squadDepth: 'Squad depth',
  squadComposition: 'Squad composition',
  xiCompatibility: 'Playing XI compatibility'
});

const round2 = x => Math.round(x * 100) / 100;
const pct = (count, target) => (target <= 0 ? 100 : round2(Math.min(1, count / target) * 100));

const SPIN_RE = /spin|off-?break|off-?spin|leg-?spin|leg spinner|orthodox|chinaman|mystery|googly|wrist/i;
const PACE_RE = /pace|fast|medium|seam|swing|yorker/i;

/**
 * Classify one player from category + role label. Unknown categories are 'unclassified' (they
 * count toward squad size but not toward any role).
 */
export function classifyPlayer(p) {
  const category = typeof p?.category === 'string' ? p.category : null;
  const role = typeof p?.role === 'string' ? p.role : '';
  switch (category) {
    case 'BAT': return { group: 'BAT', bats: true, bowls: false, bowlingType: null, keeper: false, allRounder: false };
    case 'WK': return { group: 'WK', bats: true, bowls: false, bowlingType: null, keeper: true, allRounder: false };
    case 'BOWL': return { group: 'BOWL', bats: false, bowls: true, bowlingType: 'pace', keeper: false, allRounder: false };
    case 'SP': return { group: 'SP', bats: false, bowls: true, bowlingType: 'spin', keeper: false, allRounder: false };
    case 'AR': {
      // spin is checked first: "Off-spin All-Rounder", "Left-arm Spin All-Rounder" …
      const bowlingType = SPIN_RE.test(role) ? 'spin' : PACE_RE.test(role) ? 'pace' : null;
      return { group: 'AR', bats: true, bowls: true, bowlingType, keeper: false, allRounder: true };
    }
    default: return { group: 'UNCLASSIFIED', bats: false, bowls: false, bowlingType: null, keeper: false, allRounder: false };
  }
}

function eligibilityOf(f, config, participating) {
  if (!participating) return { eligible: false, status: 'NOT_PARTICIPATING', failures: ['Franchise was not claimed by a participant'] };
  const squad = f.squad || [];
  const keepers = squad.filter(p => p?.category === 'WK').length;
  const overseas = squad.filter(p => p?.isOverseas === true).length;
  const { minSquadSize, maxSquadSize, maxOverseas } = getRoomSquadLimits({ config });
  const failures = [];
  if (squad.length < minSquadSize) failures.push(`Squad has ${squad.length} players; the minimum is ${minSquadSize}`);
  if (squad.length > maxSquadSize) failures.push(`Squad has ${squad.length} players; the maximum is ${maxSquadSize}`);
  if (overseas > maxOverseas) failures.push(`Squad has ${overseas} overseas players; the maximum is ${maxOverseas}`);
  if (keepers < (config.minWKs ?? 1)) failures.push(`Squad has ${keepers} wicketkeeper(s); at least ${config.minWKs ?? 1} required`);
  return { eligible: failures.length === 0, status: failures.length === 0 ? 'ELIGIBLE' : 'INELIGIBLE', failures };
}

/** Evaluate one franchise. Pure. */
export function evaluateFranchise(f, config, { participating }) {
  const squad = [...(f.squad || [])].filter(p => p && typeof p.id === 'string').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts = { total: squad.length, BAT: 0, WK: 0, BOWL: 0, SP: 0, AR: 0, arPace: 0, arSpin: 0, arUnknownBowling: 0, unclassified: 0, overseas: 0, indian: 0, overseasUnknown: 0 };
  let battingOptions = 0; let bowlingOptions = 0; let paceOptions = 0; let spinOptions = 0;
  let indianBowling = 0; let overseasBowling = 0; let indianBatting = 0; let overseasBatting = 0;
  for (const p of squad) {
    const c = classifyPlayer(p);
    if (c.group === 'UNCLASSIFIED') counts.unclassified++; else counts[c.group]++;
    if (c.allRounder) {
      if (c.bowlingType === 'pace') counts.arPace++;
      else if (c.bowlingType === 'spin') counts.arSpin++;
      else counts.arUnknownBowling++;
    }
    if (c.bats) battingOptions++;
    if (c.bowls) bowlingOptions++;
    if (c.bowlingType === 'pace') paceOptions++;
    if (c.bowlingType === 'spin') spinOptions++;
    if (p.isOverseas === true) counts.overseas++;
    else if (p.isOverseas === false) counts.indian++;
    else counts.overseasUnknown++;
    if (c.bowls) { if (p.isOverseas === true) overseasBowling++; else indianBowling++; }
    if (c.bats) { if (p.isOverseas === true) overseasBatting++; else indianBatting++; }
  }

  // Can a rule-valid XI be fielded? (≤4 overseas in the XI)
  const usableForXi = counts.indian + counts.overseasUnknown + Math.min(counts.overseas, TARGETS.xiOverseasSlots);
  const xiChecks = [
    { id: 'elevenPlayers', label: 'At least 11 players who can be fielded together (max 4 overseas)', ok: usableForXi >= 11 },
    { id: 'keeper', label: 'A wicketkeeper', ok: counts.WK >= 1 },
    { id: 'fiveBowlers', label: 'Five bowling options within the overseas limit', ok: indianBowling + Math.min(overseasBowling, TARGETS.xiOverseasSlots) >= 5 },
    { id: 'sixBatters', label: 'Six batting options within the overseas limit', ok: indianBatting + Math.min(overseasBatting, TARGETS.xiOverseasSlots) >= 6 },
    { id: 'overseasSlots', label: 'Overseas players available for the 4 XI overseas slots', ok: counts.overseas >= 1 }
  ];

  let squadDepth;
  if (squad.length === 0) squadDepth = 0;
  else if (squad.length < config.minSquadSize) squadDepth = round2(60 * squad.length / config.minSquadSize);
  else if (config.maxSquadSize <= config.minSquadSize) squadDepth = 100;
  else squadDepth = round2(Math.min(100, 60 + 40 * (squad.length - config.minSquadSize) / (config.maxSquadSize - config.minSquadSize)));

  // Composition: 100 × (1 − total variation distance) between the squad's role shares
  // (classified players) and the template. Penalises over-concentration (e.g. 10 keepers).
  const classified = squad.length - counts.unclassified;
  let squadComposition = 0;
  if (classified > 0) {
    let tvd = 0;
    for (const [k, share] of Object.entries(TARGETS.compositionShares)) tvd += Math.abs(counts[k] / classified - share);
    squadComposition = round2(100 * (1 - tvd / 2));
  }

  const dimensions = {
    battingDepth: pct(battingOptions, TARGETS.battingOptions),
    bowlingDepth: pct(bowlingOptions, TARGETS.bowlingOptions),
    paceOptions: pct(paceOptions, TARGETS.paceOptions),
    spinOptions: pct(spinOptions, TARGETS.spinOptions),
    allRounders: pct(counts.AR, TARGETS.allRounders),
    keeperCoverage: counts.WK === 0 ? 0 : counts.WK === 1 ? 60 : 100,
    overseasBalance: counts.overseas > config.maxOverseas ? 0 : pct(counts.overseas, TARGETS.xiOverseasSlots),
    squadDepth,
    squadComposition,
    xiCompatibility: round2(100 * xiChecks.filter(c => c.ok).length / xiChecks.length)
  };
  let overall = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) overall += dimensions[k] * w / 100;
  overall = round2(overall);

  const spentLakh = squad.reduce((s, p) => s + (typeof p.boughtPrice === 'number' && Number.isFinite(p.boughtPrice) ? toLakh(p.boughtPrice) : 0), 0);
  const headline = {
    batting: dimensions.battingDepth,
    bowling: round2(dimensions.bowlingDepth * 0.5 + dimensions.paceOptions * 0.25 + dimensions.spinOptions * 0.25),
    allRounder: dimensions.allRounders,
    balance: round2((dimensions.keeperCoverage + dimensions.overseasBalance + dimensions.squadDepth + dimensions.squadComposition + dimensions.xiCompatibility) / 5)
  };

  return {
    franchiseId: f.id,
    franchiseName: f.name,
    shortName: f.shortName || f.code || f.id,
    participating,
    overall: participating ? overall : 0,
    headline: participating ? headline : { batting: 0, bowling: 0, allRounder: 0, balance: 0 },
    dimensions,
    counts,
    roleOptions: { battingOptions, bowlingOptions, paceOptions, spinOptions },
    xiChecks,
    eligibility: eligibilityOf(f, config, participating),
    purse: {
      initial: typeof f.initialPurse === 'number' ? f.initialPurse : null,
      remaining: typeof f.remainingPurse === 'number' ? f.remainingPurse : null,
      spent: fromLakh(spentLakh)
    },
    dataCompleteness: squad.length === 0 ? 100 : round2(100 * (squad.length - counts.unclassified) / squad.length)
  };
}

// Rule-based (deterministic) explanations: always available, used when AI is not
function explain(e, config) {
  if (!e.participating) {
    return { strengths: [], weaknesses: [], recommendations: [], report: `${e.franchiseName} was not claimed by a participant in this auction and has no squad to evaluate.` };
  }
  const d = e.dimensions;
  const o = e.roleOptions;
  const c = e.counts;
  const strengths = [];
  const weaknesses = [];
  const recommendations = [];
  const say = (k, good, bad, rec) => {
    if (d[k] >= 80) strengths.push(good);
    else if (d[k] < 50) { weaknesses.push(bad); if (rec) recommendations.push(rec); }
  };
  say('battingDepth', `Batting depth: ${o.battingOptions} batting options (target ${TARGETS.battingOptions}).`,
    `Thin batting: only ${o.battingOptions} batting options (target ${TARGETS.battingOptions}).`,
    'Field all-rounders in the top seven and use the impact-player slot for an extra batter when chasing.');
  say('bowlingDepth', `Bowling depth: ${o.bowlingOptions} bowling options (target ${TARGETS.bowlingOptions}).`,
    `Thin bowling: only ${o.bowlingOptions} bowling options (target ${TARGETS.bowlingOptions}).`,
    'Make sure the XI contains five full bowling options; use the impact-player slot for a bowler when defending.');
  say('paceOptions', `Pace attack: ${o.paceOptions} pace options.`, `Few pace options (${o.paceOptions} of ${TARGETS.paceOptions}).`,
    'Lean on pace-bowling all-rounders and plan overs so the specialist seamers cover powerplay and death.');
  say('spinOptions', `Spin options: ${o.spinOptions}.`, `Few spin options (${o.spinOptions} of ${TARGETS.spinOptions}).`,
    'On slow pitches, bring a spin-bowling all-rounder into the XI or as the impact player.');
  say('allRounders', `All-rounders: ${c.AR} (target ${TARGETS.allRounders}).`, `Only ${c.AR} all-rounder(s) (target ${TARGETS.allRounders}).`,
    'With few all-rounders the XI must pick between batting and bowling depth; decide per venue.');
  if (c.WK === 0) { weaknesses.push('No wicketkeeper in the squad.'); recommendations.push('The squad has no wicketkeeper: a rule-valid XI cannot be fielded.'); }
  else if (c.WK === 1) weaknesses.push('Only one wicketkeeper: no backup if he is unavailable.');
  else strengths.push(`Wicketkeeping covered: ${c.WK} keepers.`);
  if (c.overseas > config.maxOverseas) weaknesses.push(`More overseas players (${c.overseas}) than the rules allow (${config.maxOverseas}).`);
  else if (c.overseas < TARGETS.xiOverseasSlots) {
    weaknesses.push(`Only ${c.overseas} overseas player(s): the XI cannot use all 4 overseas slots.`);
  } else strengths.push(`Overseas balance: ${c.overseas} overseas players for the 4 XI slots.`);
  if (d.squadComposition >= 85) strengths.push(`Well-balanced role mix (composition ${d.squadComposition}).`);
  else if (d.squadComposition < 70 && c.total > 0) {
    const over = Object.entries(TARGETS.compositionShares).map(([k, sh]) => [k, c[k] - sh * (c.total - c.unclassified)]).sort((a, b) => b[1] - a[1])[0];
    weaknesses.push(`Unbalanced role mix (composition ${d.squadComposition}): too many ${({ BAT: 'batters', WK: 'wicketkeepers', AR: 'all-rounders', BOWL: 'pace bowlers', SP: 'spinners' })[over[0]]} for the squad size.`);
  }
  if (d.squadDepth >= 80) strengths.push(`Squad depth: ${c.total} players.`);
  else if (d.squadDepth < 60) weaknesses.push(`Short squad: ${c.total} players (minimum ${config.minSquadSize}).`);
  for (const chk of e.xiChecks) if (!chk.ok) weaknesses.push(`Playing XI problem: missing ${chk.label.toLowerCase()}.`);
  if (c.unclassified > 0) weaknesses.push(`${c.unclassified} player(s) have no recognised role in the catalogue and were not counted in any role.`);

  const strongest = Object.entries(d).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const weakest = Object.entries(d).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))[0];
  const report = `${e.franchiseName} finished with ${c.total} players (${c.BAT} batters, ${c.WK} keepers, ${c.AR} all-rounders, ` +
    `${c.BOWL} pace bowlers, ${c.SP} spinners; ${c.overseas} overseas) and an overall squad score of ${e.overall}/100. ` +
    `Strongest area: ${DIMENSION_LABELS[strongest[0]].toLowerCase()} (${strongest[1]}). Weakest area: ${DIMENSION_LABELS[weakest[0]].toLowerCase()} (${weakest[1]}). ` +
    (e.eligibility.eligible ? 'The squad meets every auction rule.' : `The squad does NOT meet the auction rules: ${e.eligibility.failures.join('; ')}.`);
  return { strengths, weaknesses, recommendations, report };
}

/** Canonical checksum of everything the evaluation depends on. */
export function evaluationInputChecksum(room) {
  const input = {
    engine: ENGINE_VERSION,
    rules: { minSquadSize: room.config.minSquadSize, maxSquadSize: room.config.maxSquadSize, maxOverseas: room.config.maxOverseas, minWKs: room.config.minWKs ?? 1 },
    franchises: Object.keys(room.franchises).sort().map(id => {
      const f = room.franchises[id];
      return {
        id, claimed: !!f.isClaimed, remainingPurse: f.remainingPurse,
        squad: [...(f.squad || [])].filter(Boolean).map(p => [p.id, p.category, p.role, p.isOverseas, p.basePrice, p.boughtPrice]).sort()
      };
    })
  };
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

const uniqueLeader = (items, key, tooFew = 'Fewer than two participating franchises: no comparison possible') => {
  if (items.length < 2) return { winner: null, reason: tooFew };
  const sorted = [...items].sort((a, b) => b[key] - a[key]);
  if (sorted[0][key] <= 0) return { winner: null, reason: 'No franchise scored in this category' };
  if (sorted[0][key] === sorted[1][key]) {
    const tied = sorted.filter(x => x[key] === sorted[0][key]).map(x => x.franchiseId).sort();
    return { winner: null, tied, reason: `Tied at ${sorted[0][key]}: ${tied.join(', ')}` };
  }
  return { winner: sorted[0].franchiseId, score: sorted[0][key] };
};

/**
 * Legacy Stage 3 evaluation: score-based evaluation engine ("eval-2").
 * Preserved for historical compatibility and regression tests.
 */
export function evaluateAuctionLegacy(room, { now = () => new Date().toISOString() } = {}) {
  const config = room.config;
  const evaluations = Object.keys(room.franchises).sort().map(id => {
    const f = room.franchises[id];
    const participating = !!f.isClaimed || (f.squad || []).length > 0;
    const e = evaluateFranchise(f, config, { participating });
    e.explanation = explain(e, config);
    return e;
  });

  // Ranking: participating & eligible, then participating & ineligible, then not participating;
  // within a group by overall score (2 decimals). Equal scores share a rank (1,2,2,4); their
  // display order is alphabetical by franchise id (no hidden preference).
  const group = e => (!e.participating ? 2 : e.eligibility.eligible ? 0 : 1);
  const ordered = [...evaluations].sort((a, b) => group(a) - group(b) || b.overall - a.overall || (a.franchiseId < b.franchiseId ? -1 : 1));
  const rankings = [];
  ordered.forEach((e, i) => {
    const prev = rankings[i - 1];
    const tiedWithPrev = prev && group(e) === prev.group && e.overall === prev.overall;
    rankings.push({ rank: tiedWithPrev ? prev.rank : i + 1, tied: false, group: group(e), franchiseId: e.franchiseId, overall: e.overall });
  });
  for (const r of rankings) r.tied = rankings.filter(x => x.rank === r.rank).length > 1;

  const playing = evaluations.filter(e => e.participating);
  const eligiblePlaying = playing.filter(e => e.eligibility.eligible);
  const flat = playing.map(e => ({ franchiseId: e.franchiseId, batting: e.headline.batting, bowling: e.headline.bowling, balance: e.headline.balance }));

  // Players bought at exactly their base price (no competing bid): a price fact, not a quality claim
  const bargains = [];
  for (const e of playing) {
    for (const p of (room.franchises[e.franchiseId].squad || [])) {
      if (typeof p.boughtPrice === 'number' && typeof p.basePrice === 'number' && toLakh(p.boughtPrice) === toLakh(p.basePrice)) {
        bargains.push({ franchiseId: e.franchiseId, playerId: p.id, playerName: p.name, category: p.category, price: p.boughtPrice });
      }
    }
  }
  bargains.sort((a, b) => b.price - a.price || (a.playerId < b.playerId ? -1 : 1));

  // League-wide weakest dimension (lowest average among participating franchises)
  let leagueWeakest = null;
  if (playing.length > 0) {
    const avgs = Object.keys(WEIGHTS).map(k => [k, round2(playing.reduce((s, e) => s + e.dimensions[k], 0) / playing.length)]);
    avgs.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    leagueWeakest = { dimension: avgs[0][0], label: DIMENSION_LABELS[avgs[0][0]], averageScore: avgs[0][1] };
  }
  const perFranchiseWeakness = Object.fromEntries(playing.map(e => {
    const [k, v] = Object.entries(e.dimensions).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))[0];
    return [e.franchiseId, { dimension: k, label: DIMENSION_LABELS[k], score: v }];
  }));

  const catalogue = room.playersCatalog || [];
  const sold = catalogue.filter(p => p?.status === 'sold').length;
  const unsold = catalogue.filter(p => p?.status === 'unsold').length;
  const skipped = catalogue.filter(p => p?.status === 'SKIPPED').length;
  const totalSpentLakh = evaluations.reduce((s, e) => s + toLakh(e.purse.spent), 0);
  const totalRemainingLakh = playing.reduce((s, e) => s + (typeof e.purse.remaining === 'number' ? toLakh(e.purse.remaining) : 0), 0);

  return {
    engineVersion: ENGINE_VERSION,
    generatedAt: now(),
    inputChecksum: evaluationInputChecksum(room),
    rules: { minSquadSize: config.minSquadSize, maxSquadSize: config.maxSquadSize, maxOverseas: config.maxOverseas, minWKs: config.minWKs ?? 1, basePurse: config.basePurse },
    weights: { ...WEIGHTS },
    targets: { ...TARGETS },
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
    rankings,
    franchises: Object.fromEntries(evaluations.map(e => [e.franchiseId, e])),
    awards: {
      bestBalanced: uniqueLeader(flat.filter(x => eligiblePlaying.some(e => e.franchiseId === x.franchiseId)), 'balance', 'Fewer than two franchises met the auction rules: no award'),
      strongestBatting: uniqueLeader(flat, 'batting'),
      strongestBowling: uniqueLeader(flat, 'bowling'),
      basePriceBuys: bargains.length ? { players: bargains.slice(0, 10), note: 'Bought at exactly the base price (no competing bid). This is a price fact, not a quality judgement: no verified performance data is available.' } : { players: [], note: 'No player was bought at exactly his base price.' },
      biggestWeakness: { league: leagueWeakest, byFranchise: perFranchiseWeakness }
    },
    dataNotes: [
      'Scores use player category, role label, overseas status, prices and squad structure only.',
      'The catalogue also contains player ratings and career statistics, but they have no stated source or date, so they are not used in any score.',
      'All-rounders whose role label does not say pace or spin count as bowling options but not as pace or spin options.'
    ]
  };
}

/**
 * Authoritative post-auction evaluation: Cricket Mastermind IPL Auction Verdict.
 * Pure function of the room squads and rules: identical input -> identical output.
 * Evaluates all 10 franchises qualitatively using cricket principles, head-to-head
 * tactical matchups, and strict 1st-to-10th rankings with NO overall numerical scores.
 */
export function evaluateAuction(room, options = {}) {
  const engine = options.engine || room.engineVersion || (room.config && room.config.analysisEngine) || process.env.ANALYSIS_ENGINE;
  if (engine === 'eval-2') {
    return evaluateAuctionLegacy(room, options);
  }

  const mastermindResult = runCricketMastermind(room, options);

  // Maintain backward-compatible awards and dataNotes for consumers
  const awards = {
    winner: mastermindResult.verdict?.winnerFranchiseId || null,
    bestBalanced: {
      winner: mastermindResult.verdict?.winnerFranchiseId || null,
      reason: mastermindResult.verdict?.expertVerdict || ''
    },
    strongestBatting: {
      winner: mastermindResult.rankings[0]?.franchiseId || null
    },
    strongestBowling: {
      winner: mastermindResult.rankings[0]?.franchiseId || null
    },
    basePriceBuys: {
      players: (mastermindResult.bestAcquisitions || [])
        .filter(b => b.type.includes('Base Price'))
        .map(b => ({
          franchiseId: b.franchiseId,
          playerId: b.playerId,
          playerName: b.playerName,
          category: b.category,
          price: b.priceCr
        })),
      note: 'Bought at base price without competing bids.'
    },
    biggestWeakness: { league: null, byFranchise: {} }
  };

  return {
    ...mastermindResult,
    awards,
    dataNotes: mastermindResult.limitations
  };
}
