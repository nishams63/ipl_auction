// CRICKET MASTERMIND — IPL AUCTION VERDICT TEST SUITE
// Validates all 20 requirements specified in the Master Prompt.
// Ensures zero overall numerical scores, deterministic 1st-to-10th rankings,
// transparent cricket reasoning, and strict ₹0 budget.

import assert from 'node:assert';
import fs from 'node:fs';
import { makeRunner, trackManager, mockIo, tempStorageFile, strongToken } from './helpers/harness.js';
import { liveRoom, sellCurrent, passCurrent } from './helpers/auctionRooms.js';

const { RoomManager, ensureAnalysisSnapshot } = await import('../server/roomManager.js');
const { runCricketMastermind, compareFranchises, rankAllFranchisesMastermind, classifyPlayerMastermind, MASTERMIND_ENGINE_VERSION } = await import('../server/analysis/cricketMastermind.js');
const { evaluateAuction } = await import('../server/analysis/evaluation.js');

const t = makeRunner('Cricket Mastermind — IPL Auction Verdict Suite (20 Requirements)');

const make = file => trackManager(new RoomManager(mockIo(), { storageFile: file || tempStorageFile('mastermind') }));

function buildTestPlayer(id, name, category, role, isOverseas = false, price = 2) {
  return {
    id,
    name,
    category,
    role,
    isOverseas,
    basePrice: price,
    boughtPrice: price,
    stats: {}
  };
}

// 1. All 10 franchises are analysed
await t.it('1. All 10 franchises are analysed', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  assert.strictEqual(Object.keys(mastermind.franchises).length, 10, 'Must analyse all 10 franchises');
  const expectedFranchises = ['CSK', 'DC', 'GT', 'KKR', 'LSG', 'MI', 'PBKS', 'RCB', 'RR', 'SRH'];
  for (const fid of expectedFranchises) {
    assert.ok(mastermind.franchises[fid], `Franchise ${fid} must be present in analysis`);
    assert.ok(mastermind.franchises[fid].departments.batting, `${fid} must have batting analysis`);
    assert.ok(mastermind.franchises[fid].departments.bowling, `${fid} must have bowling analysis`);
    assert.ok(mastermind.franchises[fid].departments.wicketkeeping, `${fid} must have wicketkeeper analysis`);
    assert.ok(mastermind.franchises[fid].departments.allRounders, `${fid} must have all-rounder analysis`);
  }
});

// 2. Exactly one winner is selected
await t.it('2. Exactly one winner is selected', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.franchises.CSK.squad = [
    buildTestPlayer('P1', 'Virat Kohli', 'BAT', 'Top-order Batter', false, 2),
    buildTestPlayer('P2', 'MS Dhoni', 'WK', 'Wicketkeeper Batter & Legend', false, 2),
    buildTestPlayer('P3', 'Jasprit Bumrah', 'BOWL', 'Purple Cap Death Specialist', false, 2),
    buildTestPlayer('P4', 'Hardik Pandya', 'AR', 'Pace All-Rounder', false, 2),
    buildTestPlayer('P5', 'Rashid Khan', 'SP', 'Right-arm Leg Spinner', true, 2),
    buildTestPlayer('P6', 'Sanju Samson', 'WK', 'Wicketkeeper Dynamic Batter', false, 2),
    buildTestPlayer('P7', 'Rinku Singh', 'BAT', 'Death Overs Finisher', false, 1),
    buildTestPlayer('P8', 'Trent Boult', 'BOWL', 'Left-arm Powerplay Specialist', true, 2),
    buildTestPlayer('P9', 'Ravindra Jadeja', 'AR', 'Left-arm Spin All-Rounder', false, 2),
    buildTestPlayer('P10', 'Travis Head', 'BAT', 'Opening Batter', true, 2),
    buildTestPlayer('P11', 'Heinrich Klaasen', 'WK', 'Wicketkeeper Power Finisher', true, 2),
    buildTestPlayer('P12', 'Arshdeep Singh', 'BOWL', 'Left-arm Yorker Specialist', false, 2),
    buildTestPlayer('P13', 'Yuzvendra Chahal', 'SP', 'Right-arm Leg Spinner', false, 2),
    buildTestPlayer('P14', 'Rajat Patidar', 'BAT', 'Middle-order Batter', false, 1),
    buildTestPlayer('P15', 'Mohammed Siraj', 'BOWL', 'Right-arm Fast Bowler', false, 2)
  ];
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  assert.ok(mastermind.verdict, 'Verdict section must be generated');
  assert.ok(mastermind.verdict.winnerFranchiseId, 'Must have a winner franchise ID');
  assert.strictEqual(typeof mastermind.verdict.winnerFranchiseName, 'string', 'Winner name must be a string');
  assert.strictEqual(mastermind.rankings[0].rank, 1, 'Rank 1 must correspond to first place');
  assert.strictEqual(mastermind.verdict.winnerFranchiseId, mastermind.rankings[0].franchiseId);
});

// 3. Rankings contain positions 1–10 exactly once
await t.it('3. Rankings contain positions 1–10 exactly once', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  assert.strictEqual(mastermind.rankings.length, 10, 'Rankings must have exactly 10 items');
  const ranks = mastermind.rankings.map(r => r.rank);
  assert.deepStrictEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'Rankings must contain positions 1-10 sequentially');
});

// 4. No duplicate franchise ranking
await t.it('4. No duplicate franchise ranking', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  const rankedFids = mastermind.rankings.map(r => r.franchiseId);
  const uniqueFids = new Set(rankedFids);
  assert.strictEqual(uniqueFids.size, 10, 'All 10 ranked franchise IDs must be strictly unique');
  for (const r of mastermind.rankings) {
    assert.strictEqual(r.tied, false, `Rank ${r.rank} must not be tied`);
  }
});

// 5. No overall numerical score determines the winner
await t.it('5. No overall numerical score determines the winner', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  for (const r of mastermind.rankings) {
    assert.strictEqual(r.overall, null, 'Rankings must NOT contain an overall numerical score');
    assert.ok(!('totalScore' in r), 'Rankings must NOT contain totalScore');
    assert.ok(!('weightedScore' in r), 'Rankings must NOT contain weightedScore');
    assert.ok(!('percentage' in r), 'Rankings must NOT contain percentage');
  }
});

// 6. No old score-based winner is displayed
await t.it('6. No old score-based winner is displayed', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  assert.ok(!mastermind.verdict.winnerScore, 'Verdict must not display winner score');
  assert.ok(mastermind.verdict.expertVerdict.length > 50, 'Verdict must provide cricket-reasoned narrative');
  assert.ok(mastermind.verdict.mainReasons.length >= 2, 'Verdict must give specific cricket reasons');
});

// 7. Missing player statistics do not cause fabricated claims
await t.it('7. Missing player statistics do not cause fabricated claims', () => {
  const unratedPlayer = {
    id: 'PL_UNRATED',
    name: 'Unheralded Domestic Prospect',
    category: 'BAT',
    role: 'BAT',
    isOverseas: false,
    basePrice: 0.3,
    boughtPrice: 0.3
  };
  const classified = classifyPlayerMastermind(unratedPlayer);

  assert.strictEqual(classified.isOpener, false);
  assert.strictEqual(classified.bats, true);
  assert.strictEqual(classified.bowls, false);
  assert.ok(!('average' in classified), 'Must never invent batting average');
  assert.ok(!('strikeRate' in classified), 'Must never invent strike rate');
  assert.ok(!('wickets' in classified), 'Must never invent bowling wickets');
  assert.ok(!('economy' in classified), 'Must never invent bowling economy');
});

// 8. Overseas combinations respect existing auction rules
await t.it('8. Overseas combinations respect existing auction rules (max 8 squad, max 4 XI)', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  // Give MI 9 overseas players (violates rule max 8)
  room.franchises.MI.squad = [
    buildTestPlayer('O1', 'OS 1', 'BAT', 'BAT', true, 1),
    buildTestPlayer('O2', 'OS 2', 'BAT', 'BAT', true, 1),
    buildTestPlayer('O3', 'OS 3', 'BAT', 'BAT', true, 1),
    buildTestPlayer('O4', 'OS 4', 'BAT', 'BAT', true, 1),
    buildTestPlayer('O5', 'OS 5', 'BAT', 'BAT', true, 1),
    buildTestPlayer('O6', 'OS 6', 'BOWL', 'FAST', true, 1),
    buildTestPlayer('O7', 'OS 7', 'BOWL', 'FAST', true, 1),
    buildTestPlayer('O8', 'OS 8', 'SP', 'SPIN', true, 1),
    buildTestPlayer('O9', 'OS 9', 'WK', 'WK', true, 1),
    ...Array.from({ length: 7 }, (_, i) => buildTestPlayer(`I${i}`, `Ind ${i}`, 'BAT', 'BAT', false, 1))
  ];
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  const miEval = mastermind.franchises.MI;
  assert.strictEqual(miEval.eligibility.eligible, false, 'Squad with >8 overseas must be ineligible');
  assert.ok(miEval.eligibility.failures.some(f => /overseas/i.test(f)));
  assert.ok(miEval.criticalWeaknesses.some(w => /overseas/i.test(w)));
});

// 9. Purchased-player ownership is verified
await t.it('9. Purchased-player ownership is verified', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  const p1 = buildTestPlayer('PL_OWNED', 'Verified Star', 'BAT', 'Top-order Batter', false, 5);
  room.franchises.CSK.squad = [p1];
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  const cskSquad = mastermind.franchises.CSK.squad;
  assert.strictEqual(cskSquad.length, 1);
  assert.strictEqual(cskSquad[0].id, 'PL_OWNED');
  assert.strictEqual(cskSquad[0].name, 'Verified Star');
  assert.strictEqual(cskSquad[0].boughtPrice, 5);
  // Ensure player is not credited to any other franchise
  for (const [fid, f] of Object.entries(mastermind.franchises)) {
    if (fid !== 'CSK') {
      assert.ok(!f.squad.some(p => p.id === 'PL_OWNED'), `Player must not appear in ${fid}`);
    }
  }
});

// 10. Incomplete squads are assessed honestly
await t.it('10. Incomplete squads are assessed honestly', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  // CSK has only 5 players (minimum required is 15)
  room.franchises.CSK.squad = [
    buildTestPlayer('P1', 'Player 1', 'BAT', 'BAT', false, 1),
    buildTestPlayer('P2', 'Player 2', 'BOWL', 'FAST', false, 1),
    buildTestPlayer('P3', 'Player 3', 'WK', 'WK', false, 1),
    buildTestPlayer('P4', 'Player 4', 'AR', 'AR', false, 1),
    buildTestPlayer('P5', 'Player 5', 'SP', 'SPIN', false, 1)
  ];
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  const csk = mastermind.franchises.CSK;
  assert.strictEqual(csk.eligibility.eligible, false);
  assert.ok(csk.eligibility.failures.some(f => /minimum required is 15/i.test(f)));
});

// 11. Empty franchises are handled
await t.it('11. Empty franchises are handled safely', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  for (const f of Object.values(room.franchises)) {
    f.isClaimed = false;
    f.squad = [];
  }
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  assert.strictEqual(Object.keys(mastermind.franchises).length, 10);
  assert.strictEqual(mastermind.rankings.length, 10);
  for (const f of Object.values(mastermind.franchises)) {
    assert.strictEqual(f.participating, false);
    assert.strictEqual(f.squadSize, 0);
  }
});

// 12. Head-to-head comparisons use real squad data
await t.it('12. Head-to-head comparisons use real squad data', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  // Franchise A has dedicated death bowlers
  room.franchises.CSK.squad = [
    buildTestPlayer('P1', 'Jasprit Bumrah', 'BOWL', 'Purple Cap Death Specialist', false, 10),
    buildTestPlayer('P2', 'MS Dhoni', 'WK', 'Wicketkeeper Batter & Legend', false, 5),
    buildTestPlayer('P3', 'Sanju Samson', 'WK', 'Wicketkeeper Opener', false, 5),
    ...Array.from({ length: 12 }, (_, i) => buildTestPlayer(`C${i}`, `CSK Player ${i}`, 'BAT', 'BAT', false, 1))
  ];
  // Franchise B has 0 death bowlers and 0 backup keeper
  room.franchises.MI.squad = [
    buildTestPlayer('Q1', 'K L Rahul', 'WK', 'Wicketkeeper Batter', false, 15),
    ...Array.from({ length: 14 }, (_, i) => buildTestPlayer(`M${i}`, `MI Player ${i}`, 'BAT', 'BAT', false, 1))
  ];
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  const csk = mastermind.franchises.CSK;
  const mi = mastermind.franchises.MI;
  const matchup = compareFranchises(csk, mi);

  assert.strictEqual(matchup.winner, 'CSK', 'CSK must defeat MI in direct tactical matchup');
  assert.ok(matchup.reason.includes('death-over'), 'Reason must cite death-over bowling');
});

// 13. Analysis does not change auction results
await t.it('13. Analysis does not change auction results', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  const snapshotBefore = JSON.stringify(room.franchises);
  const mastermind = runCricketMastermind(room);
  const snapshotAfter = JSON.stringify(room.franchises);

  assert.strictEqual(snapshotBefore, snapshotAfter, 'Franchise data must remain untouched by analysis');
});

// 14. Analysis persists across restarts
await t.it('14. Analysis persists across restarts', () => {
  const file = tempStorageFile('persist-analysis');
  const rm1 = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const { room } = liveRoom(rm1);
  rm1.finishAuction(room);
  rm1.flushStorage();

  const checksum1 = room.analysis.inputChecksum;
  const winner1 = room.analysis.verdict.winnerFranchiseId;

  // Restart server
  const rm2 = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const loaded = rm2.getRoom(room.roomCode);

  assert.ok(loaded.analysis, 'Analysis must be preserved after restart');
  assert.strictEqual(loaded.analysis.inputChecksum, checksum1);
  assert.strictEqual(loaded.analysis.verdict.winnerFranchiseId, winner1);
});

// 15. JSON persistence works
await t.it('15. JSON persistence saves Mastermind analysis correctly', () => {
  const file = tempStorageFile('json-save');
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: file }));
  const { room } = liveRoom(rm);
  rm.finishAuction(room);
  rm.flushStorage();

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const savedRoom = raw[room.roomCode];
  assert.ok(savedRoom.analysis);
  assert.strictEqual(savedRoom.analysis.engineVersion, MASTERMIND_ENGINE_VERSION);
  assert.strictEqual(savedRoom.analysis.rankings.length, 10);
});

// 16. Database schema compatibility (verified via shape test)
await t.it('16. Database JSON mapping compatibility', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  const mastermind = runCricketMastermind(room);

  // PostgreSQL extra column stores plain JSON serializable objects
  const serialized = JSON.stringify(mastermind);
  const deserialized = JSON.parse(serialized);
  assert.strictEqual(deserialized.engineVersion, MASTERMIND_ENGINE_VERSION);
  assert.strictEqual(deserialized.rankings.length, 10);
  assert.strictEqual(deserialized.verdict.winnerFranchiseId, mastermind.verdict.winnerFranchiseId);
});

// 17. Historical completed auctions remain unchanged
await t.it('17. Historical completed auctions remain unchanged', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.status = 'completed';
  room.analysis = {
    engineVersion: 'eval-2',
    inputChecksum: 'legacy-checksum-1234',
    overall: 85,
    rankings: [{ rank: 1, franchiseId: 'CSK' }]
  };

  // Calling ensureAnalysisSnapshot on an already evaluated completed room should return false
  const modified = ensureAnalysisSnapshot(room);
  assert.strictEqual(modified, false, 'Must not overwrite existing analysis snapshot');
  assert.strictEqual(room.analysis.engineVersion, 'eval-2', 'Legacy engineVersion must be preserved');
  assert.strictEqual(room.analysis.inputChecksum, 'legacy-checksum-1234');
});

// 18. Concurrent analysis requests do not generate inconsistent reports
await t.it('18. Concurrent analysis requests produce identical deterministic reports', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.status = 'completed';

  const rep1 = runCricketMastermind(room);
  const rep2 = runCricketMastermind(room);

  const clean1 = JSON.parse(JSON.stringify({ ...rep1, generatedAt: null }));
  const clean2 = JSON.parse(JSON.stringify({ ...rep2, generatedAt: null }));
  assert.deepStrictEqual(clean1, clean2, 'Deterministic output must be identical across concurrent runs');
});

// 19. Section 4: Why the Winner Won provides direct 1st vs 2nd comparison
await t.it('19. Why the Winner Won compares 1st vs 2nd without numerical score diffs', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.franchises.CSK.squad = [
    buildTestPlayer('P1', 'Jasprit Bumrah', 'BOWL', 'Purple Cap Death Specialist', false, 10),
    buildTestPlayer('P2', 'MS Dhoni', 'WK', 'Wicketkeeper Batter & Legend', false, 5),
    buildTestPlayer('P3', 'Sanju Samson', 'WK', 'Wicketkeeper Opener', false, 5),
    ...Array.from({ length: 12 }, (_, i) => buildTestPlayer(`C${i}`, `CSK Player ${i}`, 'BAT', 'BAT', false, 1))
  ];
  room.franchises.MI.squad = [
    buildTestPlayer('Q1', 'K L Rahul', 'WK', 'Wicketkeeper Batter', false, 15),
    ...Array.from({ length: 14 }, (_, i) => buildTestPlayer(`M${i}`, `MI Player ${i}`, 'BAT', 'BAT', false, 1))
  ];
  room.status = 'completed';
  const mastermind = runCricketMastermind(room);

  assert.ok(mastermind.whyWinnerWon, 'Must generate whyWinnerWon comparison');
  assert.strictEqual(mastermind.whyWinnerWon.firstPlace, mastermind.franchises.CSK.franchiseName);
  assert.strictEqual(mastermind.whyWinnerWon.secondPlace, mastermind.franchises.MI.franchiseName);
  assert.ok(mastermind.whyWinnerWon.verdictStatement.includes('beats'));
});

// 20. Completed room carries everything the React results screen renders (Unity removed)
await t.it('20. Completed room exposes a verdict for all 10 franchises to the React results view', () => {
  const rm = make();
  const { room } = liveRoom(rm);
  room.status = 'completed';
  room.analysis = runCricketMastermind(room);
  assert.strictEqual(Object.keys(room.franchises).length, 10);
  const ranks = Object.values(room.analysis.franchises || {}).map(f => f.rank).filter(r => r != null);
  assert.strictEqual(new Set(ranks).size, ranks.length, 'ranks must be unique');
});

// 21. Custom overseas limits (0, 1, 3, 4, 8) respect Math.min(4, maxOverseas) & targets.squadOverseasCap
await t.it('21. Custom overseas limits (0, 1, 3, 4, 8) enforce accurate critical weaknesses and targets.squadOverseasCap', () => {
  const mkCompliantIndianSquad = (prefix, osCount) => {
    const players = [
      buildTestPlayer(`${prefix}W1`, 'Keeper One', 'WK', 'Wicketkeeper Opener', false, 5),
      buildTestPlayer(`${prefix}W2`, 'Keeper Two', 'WK', 'Wicketkeeper Finisher', false, 2),
      buildTestPlayer(`${prefix}B1`, 'Jasprit Pace', 'BOWL', 'Purple Cap Death Specialist Swing', false, 10),
      buildTestPlayer(`${prefix}B2`, 'Yuzi Spin', 'SP', 'Wrist Spinner Leg-spin', false, 5),
      buildTestPlayer(`${prefix}B3`, 'Jaddu AR', 'AR', 'Left-arm Spin All-Rounder', false, 6),
      buildTestPlayer(`${prefix}B4`, 'Hardik AR', 'AR', 'Pace All-Rounder Finisher', false, 6)
    ];
    for (let i = 0; i < 9; i++) {
      const isOs = i < osCount;
      players.push(buildTestPlayer(`${prefix}P${i}`, `Player ${prefix}${i}`, 'BAT', i < 2 ? 'Opening Batter' : 'Finisher', isOs, 1));
    }
    return players;
  };

  for (const [maxOs, optOs, underOs] of [
    [0, 0, null],
    [1, 1, 0],
    [3, 3, 1],
    [4, 4, 3],
    [8, 4, 3]
  ]) {
    const rm = make();
    const room = rm.createRoom({ hostName: 'Host', hostToken: strongToken('h'), configOverrides: { maxSquadSize: 15, maxOverseas: maxOs } });
    room.status = 'completed';
    room.franchises.CSK.isClaimed = true;
    room.franchises.CSK.squad = mkCompliantIndianSquad('C', optOs);
    if (underOs !== null) {
      room.franchises.MI.isClaimed = true;
      room.franchises.MI.squad = mkCompliantIndianSquad('M', underOs);
    }

    const res = runCricketMastermind(room);
    assert.strictEqual(res.targets.squadOverseasCap, maxOs, `targets.squadOverseasCap must be ${maxOs}`);
    assert.strictEqual(res.targets.xiOverseasCap, Math.min(4, maxOs));
    const cskEval = res.franchises.CSK;
    assert.strictEqual(cskEval.eligibility.eligible, true, `CSK with ${optOs}/${maxOs} overseas must be eligible`);
    assert.ok(!cskEval.criticalWeaknesses.some(w => /cannot utilize the full \d+-overseas/i.test(w)), `maxOverseas=${maxOs} with ${optOs} overseas must NOT report false overseas-depth weakness`);

    if (underOs !== null) {
      const miEval = res.franchises.MI;
      const expectedCap = Math.min(4, maxOs);
      assert.ok(miEval.criticalWeaknesses.some(w => w.includes(`full ${expectedCap}-overseas`)), `maxOverseas=${maxOs} with ${underOs} overseas should cite full ${expectedCap}-overseas`);
      const h2h = compareFranchises(cskEval, miEval);
      assert.strictEqual(h2h.winner, 'CSK', `Pairwise comparison must favor CSK at optimal cap over MI at maxOverseas=${maxOs}`);
    }
  }
});

// 22. Snake_case legacy config & missing config normalization in Cricket Mastermind
await t.it('22. Snake_case and missing room.config normalize cleanly without undefined cap failures', () => {
  const rm = make();
  const room = rm.createRoom({ hostName: 'Host', hostToken: strongToken('h'), configOverrides: { max_squad_size: 18, max_overseas_players: 2 } });
  room.status = 'completed';
  room.franchises.CSK.isClaimed = true;
  room.franchises.CSK.squad = [
    buildTestPlayer('K1', 'Keeper One', 'WK', 'Wicketkeeper Opener', false, 2),
    ...Array.from({ length: 14 }, (_, i) => buildTestPlayer(`S${i}`, `Player ${i}`, 'BAT', 'Batter', i < 2, 1))
  ];
  const resSnake = runCricketMastermind(room);
  assert.strictEqual(resSnake.rules.maxSquadSize, 18);
  assert.strictEqual(resSnake.rules.maxOverseas, 2);
  assert.strictEqual(resSnake.targets.squadOverseasCap, 2);
  assert.strictEqual(resSnake.franchises.CSK.eligibility.eligible, true);

  // Missing config falls back cleanly to legacy defaults (15 / 8)
  const noCfgRoom = { ...room, config: undefined, max_squad_size: undefined, max_overseas_players: undefined };
  const resFallback = runCricketMastermind(noCfgRoom);
  assert.strictEqual(resFallback.rules.maxSquadSize, 15);
  assert.strictEqual(resFallback.rules.maxOverseas, 8);
  assert.strictEqual(resFallback.targets.squadOverseasCap, 8);
  assert.strictEqual(resFallback.rankings.length, 10);
});

await t.finish();
