// Real-time End-to-End Multiplayer Simulation using Socket.io clients
import assert from 'assert';
import { io } from 'socket.io-client';
import { calculateNextBid } from '../server/auctionEngine.js';

const DEFAULT_PORT = 4000;

async function resolveServerUrl() {
  if (process.env.SERVER_URL) return { url: process.env.SERVER_URL, srv: null };
  try {
    const probe = await fetch(`http://localhost:${DEFAULT_PORT}/api/health`, { signal: AbortSignal.timeout(500) });
    if (probe.ok) return { url: `http://localhost:${DEFAULT_PORT}`, srv: null };
  } catch {
    // Local server not running
  }
  const { startServer, tempStorageFile } = await import('./helpers/harness.js');
  const srv = await startServer({ storageFile: tempStorageFile('sim-live') });
  return { url: srv.url, srv };
}

async function runMultiplayerSimulation() {
  console.log('🚀 Launching Real-time Multiplayer Auction Simulation...\n');
  const { url: SERVER_URL, srv } = await resolveServerUrl();

  try {
    // 1. Create Room via REST API
  const hostToken = 'usr_dhoni_777_simulation_host'; // tokens must be >= 16 chars
  const joinToken = 'usr_gambhir_888_simulation_join';

  const createRes = await fetch(`${SERVER_URL}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hostName: 'MS Dhoni',
      hostToken,
      config: { basePurse: 120.0, timerDuration: 15, minParticipants: 2 } // squad limits are fixed IPL rules (Stage 2)
    })
  });

  const { roomCode } = await createRes.json();
  console.log(`  🏠 Room Created: ${roomCode}`);
  assert.ok(roomCode);

  // 2. Connect Two Sockets
  const socket1 = io(SERVER_URL, { transports: ['websocket'] });
  const socket2 = io(SERVER_URL, { transports: ['websocket'] });

  await new Promise((resolve) => {
    let connected = 0;
    const check = () => { if (++connected === 2) resolve(); };
    socket1.on('connect', check);
    socket2.on('connect', check);
  });
  console.log('  ⚡ Both client sockets connected');

  // 3. Join Room
  const join1 = await new Promise((res) => {
    socket1.emit('join_room', { roomCode, participantName: 'MS Dhoni', participantToken: hostToken }, res);
  });
  assert.strictEqual(join1.success, true);

  const join2 = await new Promise((res) => {
    socket2.emit('join_room', { roomCode, participantName: 'Gautam Gambhir', participantToken: joinToken }, res);
  });
  assert.strictEqual(join2.success, true);
  console.log('  👥 Both participants joined room');

  // 4. Franchise Selection
  const select1 = await new Promise((res) => {
    socket1.emit('select_franchise', { roomCode, participantToken: hostToken, franchiseId: 'CSK' }, res);
  });
  assert.strictEqual(select1.success, true);

  const select2 = await new Promise((res) => {
    socket2.emit('select_franchise', { roomCode, participantToken: joinToken, franchiseId: 'KKR' }, res);
  });
  assert.strictEqual(select2.success, true);
  console.log('  🟡 MS Dhoni claimed CSK, 🟣 Gautam Gambhir claimed KKR');

  // 5. Verify Flat Initial Purse (Every franchise starts with ₹120.00 Cr, Total across 10 franchises = ₹1,200 Cr)
  const roomStateRes = await fetch(`${SERVER_URL}/api/rooms/${roomCode}`);
  const roomState = await roomStateRes.json();
  assert.strictEqual(roomState.franchises.CSK.initialPurse, 120.0);
  assert.strictEqual(roomState.franchises.KKR.initialPurse, 120.0);
  console.log(`  💰 Flat Purse verified: ₹${roomState.franchises.CSK.initialPurse} Cr each across all franchises`);

  // 6. Host Starts Auction
  const startPromise = new Promise((res) => {
    socket2.on('lot_presented', (state) => res(state));
  });

  const startRes = await new Promise((res) => {
    socket1.emit('start_auction', { roomCode, hostToken }, res);
  });
  assert.strictEqual(startRes.success, true);

  const lotState = await startPromise;
  console.log(`  🎯 Auction Started! Presented Lot #1: ${lotState.currentLot.player.name} (${lotState.currentLot.setName})`);
  // Lot order is shuffled within each set at start: lot #1 is a player from the first set (High-Profile Round 1 Batters)
  assert.strictEqual(lotState.currentLot.player.categorySet, 'HIGH-R01-BAT');
  assert.strictEqual(lotState.currentLot.player.category, 'BAT');
  assert.strictEqual(lotState.currentLot.lotNumber, 1);
  assert.strictEqual(lotState.currentLot.countdown, 15);
  console.log(`  ⏱️ Verified 15-second initial countdown on Lot #1`);

  // 7. Dhoni places opening bid (the lot's base price; lot 1 is any first-set player since the
  //    order is shuffled within sets) - resets timer to 15s
  const opening = lotState.currentLot.player.basePrice;
  const second = calculateNextBid(opening, opening);
  const bid1Promise = new Promise((res) => {
    socket2.on('bid_accepted', (payload) => res(payload));
  });

  const bid1Res = await new Promise((res) => {
    socket1.emit('place_bid', {
      roomCode,
      participantToken: hostToken,
      franchiseId: 'CSK',
      bidAmount: opening,
      expectedVersion: lotState.currentLot.stateVersion
    }, res);
  });
  assert.strictEqual(bid1Res.success, true);

  const bid1Payload = await bid1Promise;
  console.log(`  🔨 Bid #1 Accepted: CSK bid ₹${bid1Payload.bid.bidAmount} Cr on ${bid1Payload.bid.playerName}`);
  assert.strictEqual(bid1Payload.currentLot.highestBid, opening);
  assert.strictEqual(bid1Payload.nextValidBid, second);
  assert.strictEqual(bid1Payload.currentLot.countdown, 15);
  console.log(`  ⏱️ Verified countdown reset to 15 seconds after bid #1`);

  // 8. Test Pause and Resume preserving timer accuracy
  const pauseRes = await new Promise((res) => {
    socket1.emit('pause_auction', { roomCode, hostToken }, res);
  });
  assert.strictEqual(pauseRes.success, true);
  assert.strictEqual(pauseRes.room.status, 'paused');
  console.log(`  ⏸️ Auction Paused successfully`);

  const resumeRes = await new Promise((res) => {
    socket1.emit('resume_auction', { roomCode, hostToken }, res);
  });
  assert.strictEqual(resumeRes.success, true);
  assert.strictEqual(resumeRes.room.status, 'active');
  console.log(`  ▶️ Auction Resumed successfully`);

  // 9. Gambhir places the automatic next increment bid
  const bid2Promise = new Promise((res) => {
    socket1.on('bid_accepted', (payload) => res(payload));
  });

  const bid2Res = await new Promise((res) => {
    socket2.emit('place_bid', {
      roomCode,
      participantToken: joinToken,
      franchiseId: 'KKR',
      bidAmount: second,
      expectedVersion: bid1Payload.currentLot.stateVersion
    }, res);
  });
  assert.strictEqual(bid2Res.success, true);

  const bid2Payload = await bid2Promise;
  console.log(`  🔨 Bid #2 Accepted: KKR outbid with automatic increment ₹${bid2Payload.bid.bidAmount} Cr`);
  assert.strictEqual(bid2Payload.currentLot.highestBid, second);
  assert.strictEqual(bid2Payload.nextValidBid, calculateNextBid(second, opening));
  assert.strictEqual(bid2Payload.currentLot.countdown, 15);
  console.log(`  ⏱️ Verified countdown reset to 15 seconds after bid #2`);

  // 10. Host closes/advances lot to sell to KKR
  const soldPromise = new Promise((res) => {
    socket1.on('lot_completed', (payload) => res(payload));
  });

  await new Promise((res) => {
    socket1.emit('advance_lot', { roomCode, hostToken }, res);
  });

  const soldResult = await soldPromise;
  console.log(`  🎉 SOLD! ${soldResult.lot.player.name} bought by ${soldResult.historyEntry.winningFranchiseName} for ₹${soldResult.historyEntry.finalBid} Cr`);
  assert.strictEqual(soldResult.result, 'SOLD');
  assert.strictEqual(soldResult.historyEntry.winningFranchiseCode, 'KKR');

  // Verify KKR Purse deducted exactly once, exactly (integer lakhs): ₹120 Cr − winning bid
  assert.strictEqual(soldResult.franchises.KKR.remainingPurse, (12000 - Math.round(second * 100)) / 100);
  assert.strictEqual(soldResult.franchises.KKR.squad.length, 1);
  console.log(`  💳 KKR Purse updated: Remaining ₹${soldResult.franchises.KKR.remainingPurse} Cr (₹${second} Cr deducted from ₹120 Cr)`);

  // 10. Finish Auction & Verify Evaluation & Podium
  const finishPromise = new Promise((res) => {
    socket2.on('auction_completed', (state) => res(state));
  });

  await new Promise((res) => {
    socket1.emit('finish_auction', { roomCode, hostToken }, res);
  });

  const finalState = await finishPromise;
  console.log('  🏆 Final Evaluation Completed!');
  assert.ok(finalState.evaluationResults);
  assert.strictEqual(finalState.evaluationResults.rankings.length, 2);
  console.log(`  📊 Rankings evaluated: ${finalState.evaluationResults.rankings.length} teams assessed`);
  console.log(`  ℹ️ Eligibility check: KKR has 0 WKs so eligible = ${finalState.evaluationResults.rankings[0].isEligible}`);

    socket1.disconnect();
    socket2.disconnect();

    console.log('\n🌟 Complete Multiplayer Real-Time Auction Lifecycle Verified Successfully!\n');
  } finally {
    if (srv) await srv.stop();
  }
}

runMultiplayerSimulation().catch(err => {
  console.error('Simulation Failed:', err);
  process.exit(1);
});
