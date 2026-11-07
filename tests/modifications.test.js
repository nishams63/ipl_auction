import assert from 'node:assert';
import { RoomManager } from '../server/roomManager.js';
import { validateBid, calculateNextBid } from '../server/auctionEngine.js';

// Mock io to allow testing RoomManager without network sockets
const mockIo = {
  to: () => ({
    emit: () => {}
  }),
  emit: () => {}
};

async function runModificationsTests() {
  console.log('🧪 Starting IPL Modifications Test Suite...\n');
  const roomManager = new RoomManager(mockIo);

  // ==========================================
  // MODIFICATION 1: PLAYING XI PERSISTENCE
  // ==========================================
  console.log('▶ Testing Modification 1: Playing XI Persistence');
  const hostToken1 = 'token_test_host_1';
  const room1 = roomManager.createRoom({
    hostName: 'TestHost',
    hostToken: hostToken1,
    configOverrides: { minParticipants: 1, basePurse: 120 }
  });

  const roomCode1 = room1.roomCode;

  // Join host participant
  roomManager.joinRoom({
    roomCode: roomCode1,
    participantName: 'TestHost',
    participantToken: hostToken1,
    socketId: 'sock-1'
  });

  // Claim CSK franchise
  const claimRes1 = roomManager.selectFranchise({
    roomCode: roomCode1,
    participantToken: hostToken1,
    franchiseId: 'CSK'
  });
  assert.strictEqual(claimRes1.success, true, 'CSK selection should succeed');

  // Select 11 players for Playing XI during auction setup from catalog (ensuring 1 WK, <= 4 OS)
  const catalog1 = room1.playersCatalog;
  const wkPlayer = catalog1.find(p => p.category === 'WK');
  const indPlayers = catalog1.filter(p => !p.isOverseas && p.id !== wkPlayer.id).slice(0, 10);
  const selectedXI = [wkPlayer.id, ...indPlayers.map(p => p.id)];
  const captain = selectedXI[0];
  const viceCaptain = selectedXI[1];
  const wk = wkPlayer.id;

  const updateRes = roomManager.updatePlayingXI({
    roomCode: roomCode1,
    participantToken: hostToken1,
    hostToken: hostToken1,
    franchiseId: 'CSK',
    playingXI: selectedXI,
    captainId: captain,
    viceCaptainId: viceCaptain,
    wicketKeeperId: wk
  });
  assert.strictEqual(updateRes.success, true, 'Playing XI setup should succeed');

  // Verify Playing XI is saved in independent data structure
  const savedConfig = room1.playingXIConfigurations['CSK'];
  assert.deepStrictEqual(savedConfig.playingXI, selectedXI, 'Playing XI must match selected IDs');
  assert.strictEqual(savedConfig.captainId, captain, 'Captain must match');
  assert.strictEqual(savedConfig.viceCaptainId, viceCaptain, 'Vice Captain must match');
  console.log('  ✅ Playing XI configured and saved during setup');

  // Start live auction
  const startRes1 = roomManager.startAuction({ roomCode: roomCode1, hostToken: hostToken1 });
  assert.strictEqual(startRes1.success, true, 'Auction start should succeed');

  // Verify Playing XI is NOT reset by starting the auction
  assert.deepStrictEqual(room1.playingXIConfigurations['CSK'].playingXI, selectedXI, 'Playing XI must survive auction start');
  console.log('  ✅ Playing XI preserved when auction starts');

  // Place bids on lot #1
  const bid1 = roomManager.placeBid({
    roomCode: roomCode1,
    participantToken: hostToken1,
    franchiseId: 'CSK',
    bidAmount: room1.currentLot.nextValidBid,
    expectedVersion: room1.currentLot.stateVersion
  });
  assert.strictEqual(bid1.success, true, 'Placing bid should succeed');

  // Verify Playing XI is NOT affected by placing bids
  assert.deepStrictEqual(room1.playingXIConfigurations['CSK'].playingXI, selectedXI, 'Playing XI must survive bidding');
  console.log('  ✅ Playing XI preserved when bid is placed');

  // Advance lot (simulate lot sale or completion)
  const advanceRes = roomManager.skipOrAdvanceLot({ roomCode: roomCode1, hostToken: hostToken1 });
  assert.strictEqual(advanceRes.success, true, 'Advance lot should succeed');

  // Verify Playing XI is NOT affected by player purchase or lot advance
  assert.deepStrictEqual(room1.playingXIConfigurations['CSK'].playingXI, selectedXI, 'Playing XI must survive lot advance/purchase');
  console.log('  ✅ Playing XI preserved when player is sold / lot advances');

  // Verify persistent storage reload: loadFromStorage preserves playingXIConfigurations
  roomManager.saveToStorage();
  roomManager.loadFromStorage();
  const reloadedRoom = roomManager.getRoom(roomCode1);
  assert.ok(reloadedRoom);
  assert.deepStrictEqual(
    reloadedRoom.playingXIConfigurations['CSK'].playingXI,
    selectedXI,
    'Playing XI must persist to and load from persistent storage'
  );
  assert.deepStrictEqual(
    reloadedRoom.franchises['CSK'].playingXI,
    selectedXI,
    'Franchise playingXI must match configuration after storage reload'
  );
  console.log('  ✅ Playing XI reloaded accurately from disk persistence');
  roomManager.clearRoomTimer(roomCode1);

  // ==========================================
  // MODIFICATION 2: HOST SKIP SET WORKFLOW
  // ==========================================
  console.log('\n▶ Testing Modification 2: Skip Set Option');
  const hostToken2 = 'token_test_host_2';
  const room2 = roomManager.createRoom({
    hostName: 'HostSkipTest',
    hostToken: hostToken2,
    configOverrides: { minParticipants: 1 }
  });
  const roomCode2 = room2.roomCode;

  roomManager.joinRoom({
    roomCode: roomCode2,
    participantName: 'HostSkipTest',
    participantToken: hostToken2,
    socketId: 'sock-2'
  });

  roomManager.selectFranchise({
    roomCode: roomCode2,
    participantToken: hostToken2,
    franchiseId: 'MI'
  });

  const startRes2 = roomManager.startAuction({ roomCode: roomCode2, hostToken: hostToken2 });
  assert.strictEqual(startRes2.success, true);
  assert.strictEqual(room2.status, 'active');

  const initialLot = room2.currentLot;
  const activeSet = initialLot.player.categorySet;
  const initialPurse = room2.franchises['MI'].remainingPurse;

  // 1. Non-host attempt to skip set must fail
  const nonHostRes = roomManager.skipCurrentSet({
    roomCode: roomCode2,
    hostToken: 'fake-invalid-token'
  });
  assert.strictEqual(nonHostRes.success, false);
  assert.ok(nonHostRes.error.includes('Only the auction host can skip player sets'));
  console.log('  ✅ Non-host skip attempt rejected server-side');

  // 2. Host skips the current set
  const skipRes = roomManager.skipCurrentSet({ roomCode: roomCode2, hostToken: hostToken2 });
  assert.strictEqual(skipRes.success, true);
  assert.strictEqual(skipRes.skippedSet, activeSet);
  assert.ok(skipRes.skippedCount > 0, 'Must have skipped at least one player in set');
  console.log(`  ✅ Host successfully skipped set ${activeSet} (${skipRes.skippedCount} players)`);

  // 3. Verify skipped players have distinct SKIPPED status and were not sold/unsold
  const skippedPlayers = room2.playersCatalog.filter(p => p.categorySet === activeSet);
  for (const p of skippedPlayers) {
    assert.strictEqual(p.status, 'SKIPPED', `Player ${p.name} must have status SKIPPED`);
    assert.strictEqual(p.soldTo, null, `Skipped player ${p.name} must not be sold`);
    assert.strictEqual(p.soldPrice, null, `Skipped player ${p.name} must have null soldPrice`);
  }
  console.log('  ✅ All skipped players marked with distinct SKIPPED status without sold/unsold confusion');

  // 4. Verify no purse deduction
  assert.strictEqual(room2.franchises['MI'].remainingPurse, initialPurse, 'Skipping a set must not deduct purse');
  console.log('  ✅ Team purse unchanged after skipping set');

  // 5. Verify room advanced to a player of the next set
  if (room2.status === 'active') {
    assert.notStrictEqual(
      room2.currentLot.player.categorySet,
      activeSet,
      'Active player must belong to the next set'
    );
    console.log(`  ✅ Room advanced to next player set: ${room2.currentLot.player.categorySet}`);
  }

  // 6. Verify auction history recorded SKIPPED events
  const historyEntries = room2.history.filter(h => h.status === 'SKIPPED' && (h.player?.categorySet === activeSet || h.player?.setName === activeSet));
  assert.strictEqual(historyEntries.length, skipRes.skippedCount);
  console.log('  ✅ Skip events recorded in auction history');
  roomManager.clearRoomTimer(roomCode2);

  // ==========================================
  // MODIFICATION 3: STRICT INCREMENT-ONLY BIDDING
  // ==========================================
  console.log('\n▶ Testing Modification 3: Increment-Only Bidding & Custom Bid Removal');
  const fakeRoom = {
    status: 'active',
    config: { basePurse: 120 },
    currentLot: {
      player: { id: 'PL_TEST', name: 'Test Player', basePrice: 2.0, isOverseas: false },
      highestBid: 2.0, // current bid 2.0 Cr
      highestBidderFranchiseId: 'CSK',
      stateVersion: 1
    },
    franchises: {
      MI: {
        id: 'MI',
        remainingPurse: 110.0,
        squad: [],
        overseasCount: 0
      }
    }
  };

  // Next valid bid calculation
  const nextValidBid = calculateNextBid(2.0, 2.0);
  assert.strictEqual(nextValidBid, 2.25);
  console.log('  ✅ Next bid correctly calculated using configured increment (2.0 + 0.25 = 2.25 Cr)');

  // 1. Exact next increment bid is ACCEPTED
  const validBid = validateBid({
    room: fakeRoom,
    franchiseId: 'MI',
    bidAmount: 2.25,
    expectedVersion: 1
  });
  assert.strictEqual(validBid.valid, true);
  assert.strictEqual(validBid.validNextAmount, 2.25);
  console.log('  ✅ Exact predefined increment bid accepted');

  // 2. Custom arbitrary amount is REJECTED
  const customBidHigher = validateBid({
    room: fakeRoom,
    franchiseId: 'MI',
    bidAmount: 3.50,
    expectedVersion: 1
  });
  assert.strictEqual(customBidHigher.valid, false);
  assert.ok(customBidHigher.error.includes('Custom bids are disabled'));
  console.log('  ✅ Custom arbitrary higher bid rejected with custom bids disabled error');

  // 3. Custom amount below next increment is REJECTED
  const customBidLower = validateBid({
    room: fakeRoom,
    franchiseId: 'MI',
    bidAmount: 2.10,
    expectedVersion: 1
  });
  assert.strictEqual(customBidLower.valid, false);
  assert.ok(customBidLower.error.includes('Custom bids are disabled'));
  console.log('  ✅ Custom bid below next increment rejected');

  // 4. Bid higher than remaining purse is REJECTED
  fakeRoom.franchises['MI'].remainingPurse = 1.0;
  const unaffordableBid = validateBid({
    room: fakeRoom,
    franchiseId: 'MI',
    bidAmount: 2.25,
    expectedVersion: 1
  });
  assert.strictEqual(unaffordableBid.valid, false);
  assert.ok(unaffordableBid.error.includes('Insufficient purse'));
  console.log('  ✅ Unaffordable bid rejected safely');

  console.log('\n🎉 ALL 3 MAJOR MODIFICATIONS TESTED AND VERIFIED SUCCESSFULLY!\n');
  process.exit(0);
}

runModificationsTests().catch(err => {
  console.error('\n❌ Test execution failed with error:', err);
  process.exit(1);
});
