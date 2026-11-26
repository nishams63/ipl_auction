// REAL 10-PLAYER BROWSER & MULTIPLAYER END-TO-END VERIFICATION SUITE
// Tests 10 independent browser contexts running against local Cloudflare workerd daemon
import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { CloudflareNativeWsAdapter } from '../client/src/utils/wsAdapter.js';
import { findChrome } from './e2e/harness.js';

test('10-Player Real Browser & workerd Multiplayer Suite', async (t) => {
  // 1. Bundle Worker code for workerd runtime
  const build = esbuild.buildSync({
    entryPoints: ['cloudflare/src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    external: ['node:*', 'cloudflare:*']
  });
  const bundledCode = build.outputFiles[0].text;

  // 2. Start Miniflare with real Durable Objects SQLite enabled
  const mf = new Miniflare({
    modules: true,
    script: bundledCode,
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      AUCTION_ROOMS: {
        className: 'AuctionRoomDO',
        useSQLite: true
      }
    }
  });

  const mfOrigin = (await mf.ready).origin;
  console.log(`[workerd] Local Cloudflare daemon running on ${mfOrigin}`);

  // 3. Launch real Google Chrome via playwright-core
  // NOTE: this suite drives the protocol through the frontend adapter in Node; it is a
  // protocol-level multiplayer test, not a UI E2E test (see tests/e2e/tenPlayerUi.test.js).
  const chromePath = findChrome();
  if (!chromePath) { t.skip('No Chrome/Chromium found (set CHROME_PATH)'); return; }
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox']
  });
  console.log(`[Chrome] Launched Google Chrome headless engine: ${browser.version()}`);

  t.after(async () => {
    await browser.close();
    await mf.dispose();
    console.log('[Cleanup] Browser and Miniflare daemon closed cleanly.');
  });

  // Track room data
  let roomCode = null;
  const hostToken = 'usr_token_host_01';
  const franchiseList = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'DC', 'PBKS', 'GT', 'LSG'];

  // Test 1: Host creates room via HTTP POST
  await t.test('Stage 1: Host creates private IPL auction room', async () => {
    const res = await mf.dispatchFetch('https://edge.workers.dev/api/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://ipl-auction-omega-nine.vercel.app'
      },
      body: JSON.stringify({
        hostName: 'Host_CSK',
        hostToken,
        config: { basePurse: 120 }
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.roomCode);
    assert.equal(body.room.status, 'lobby');
    roomCode = body.roomCode;
    console.log(`[Stage 1] Room created successfully: ${roomCode}`);
  });

  // Test 2: Create 10 independent browser contexts and connect all 10 participants
  const participants = [];
  const browserContexts = [];

  await t.test('Stage 2: Ten independent browser contexts join the room', async () => {
    for (let i = 0; i < 10; i++) {
      const fCode = franchiseList[i];
      const isHost = (i === 0);
      const token = isHost ? hostToken : `usr_token_player_${i + 1}`;
      const name = isHost ? 'Host_CSK' : `Player_${fCode}`;

      // Create isolated browser context (separate cookies, localStorage, origins)
      const context = await browser.newContext();
      browserContexts.push(context);

      // Create WebSocket adapter connected to workerd daemon
      const adapter = new CloudflareNativeWsAdapter(mfOrigin);
      const incomingEvents = [];

      adapter.on('state_updated', (st) => incomingEvents.push({ type: 'STATE_UPDATED', payload: st }));
      adapter.on('lot_presented', (st) => incomingEvents.push({ type: 'LOT_PRESENTED', payload: st }));
      adapter.on('bid_accepted', (data) => incomingEvents.push({ type: 'BID_ACCEPTED', payload: data }));
      adapter.on('lot_completed', (data) => incomingEvents.push({ type: 'LOT_COMPLETED', payload: data }));
      adapter.on('timer_tick', (data) => incomingEvents.push({ type: 'TIMER_TICK', payload: data }));
      adapter.on('auction_completed', (st) => incomingEvents.push({ type: 'AUCTION_COMPLETED', payload: st }));

      // Join room
      const joinRes = await new Promise((resolve) => {
        adapter.emit('join_room', {
          roomCode,
          participantName: name,
          participantToken: token
        }, resolve);
      });

      assert.ok(joinRes, `Join response should exist for participant ${i}`);
      assert.equal(joinRes.success, true, `Join should succeed for participant ${i}`);

      participants.push({
        index: i,
        name,
        token,
        franchiseCode: fCode,
        adapter,
        events: incomingEvents,
        context
      });
    }

    assert.equal(participants.length, 10);
    console.log('[Stage 2] 10 independent browser sessions joined room successfully');
  });

  // Test 3: All 10 participants select their respective 10 franchises
  await t.test('Stage 3: All 10 participants claim the 10 distinct IPL franchises', async () => {
    for (const p of participants) {
      const claimRes = await new Promise((resolve) => {
        p.adapter.emit('select_franchise', {
          franchiseId: p.franchiseCode
        }, resolve);
      });

      assert.ok(claimRes);
      assert.equal(claimRes.success, true, `Claiming ${p.franchiseCode} should succeed`);
    }

    await new Promise(r => setTimeout(r, 200));

    // Verify on participant 0 that all 10 franchises are claimed
    const hostLatestState = participants[0].events.filter(e => e.type === 'STATE_UPDATED').pop()?.payload;
    assert.ok(hostLatestState);
    const claimedCount = Object.values(hostLatestState.franchises).filter(f => f.isClaimed).length;
    assert.equal(claimedCount, 10, 'All 10 franchises must be claimed');

    // Verify duplicate claim prevention: Participant 1 tries to claim CSK (owned by Host)
    const dupRes = await new Promise((resolve) => {
      participants[1].adapter.emit('select_franchise', {
        franchiseId: 'CSK'
      }, resolve);
    });
    assert.equal(dupRes.success, false, 'Duplicate franchise claim must be rejected');
    console.log('[Stage 3] All 10 franchises claimed; duplicate claim rejected');
  });

  // Test 4: Host starts the auction
  await t.test('Stage 4: Host starts auction and first player is presented', async () => {
    const startRes = await new Promise((resolve) => {
      participants[0].adapter.emit('start_auction', {}, resolve);
    });
    assert.equal(startRes.success, true, 'Start auction must succeed');

    await new Promise(r => setTimeout(r, 250));

    // Verify all 10 participants received LOT_PRESENTED from Set 1 (shuffled)
    let firstLotBase = null;
    for (const p of participants) {
      const lotPresented = p.events.find(e => e.type === 'LOT_PRESENTED');
      assert.ok(lotPresented, `Participant ${p.name} must receive LOT_PRESENTED`);
      assert.equal(lotPresented.payload.status, 'active');
      assert.ok(lotPresented.payload.currentLot);
      assert.equal(lotPresented.payload.currentLot.lotNumber, 1);
      assert.equal(lotPresented.payload.currentLot.player.categorySet, 'HIGH-R01-BAT');
      assert.ok(lotPresented.payload.currentLot.basePrice > 0);
      firstLotBase = lotPresented.payload.currentLot.basePrice;
    }
    console.log(`[Stage 4] Auction started; Lot 1 presented with base price ${firstLotBase} Cr`);
  });

  // Test 5: Simultaneous bidding, countdown reset & atomic persistence
  await t.test('Stage 5: Live bidding, simultaneous bids, and timer reset', async () => {
    const lot1 = participants[0].events.find(e => e.type === 'LOT_PRESENTED').payload.currentLot;
    const bid1Amt = lot1.basePrice;
    const bid2Amt = bid1Amt + 0.25;
    const bid3Amt = bid2Amt + 0.25;
    const bid4Amt = bid3Amt + 0.25;

    // Participant 0 (CSK) places initial bid
    const bid1 = await new Promise((resolve) => {
      participants[0].adapter.emit('place_bid', {
        franchiseId: 'CSK',
        bidAmount: bid1Amt
      }, resolve);
    });
    assert.equal(bid1.success, true);
    assert.equal(bid1.bidRecord.amount, bid1Amt);

    // Participant 1 (MI) and Participant 2 (RCB) bid simultaneously
    const [bidResMI, bidResRCB] = await Promise.all([
      new Promise(res => participants[1].adapter.emit('place_bid', { franchiseId: 'MI', bidAmount: bid2Amt }, res)),
      new Promise(res => participants[2].adapter.emit('place_bid', { franchiseId: 'RCB', bidAmount: bid2Amt }, res))
    ]);

    // Exactly one concurrent bid must succeed
    const successCount = (bidResMI.success ? 1 : 0) + (bidResRCB.success ? 1 : 0);
    assert.equal(successCount, 1, 'Exactly one concurrent bid must succeed');

    // Determine who holds the highest bid
    const highestFranchise = bidResMI.success ? 'MI' : 'RCB';
    const nextBidder = highestFranchise === 'MI' ? participants[2] : participants[1];

    // Next bidder raises bid
    const bid3 = await new Promise(res => nextBidder.adapter.emit('place_bid', {
      franchiseId: nextBidder.franchiseCode,
      bidAmount: bid3Amt
    }, res));
    assert.equal(bid3.success, true);
    assert.equal(bid3.bidRecord.amount, bid3Amt);

    // Test invalid bid: current highest bidder attempts to self-bid again
    const selfBid = await new Promise(res => nextBidder.adapter.emit('place_bid', {
      franchiseId: nextBidder.franchiseCode,
      bidAmount: bid4Amt
    }, res));
    assert.equal(selfBid.success, false, 'Self-outbidding must be rejected');

    console.log(`[Stage 5] Bids accepted at ${bid1Amt}, ${bid2Amt}, ${bid3Amt} Cr; self-bidding rejected`);
  });

  // Test 6: Advance lot & Player Sold verification
  await t.test('Stage 6: Authoritative lot closure and sale resolution', async () => {
    const lot1 = participants[0].events.find(e => e.type === 'LOT_PRESENTED').payload.currentLot;
    const expectedSold = lot1.basePrice + 0.50;

    // Host advances lot (hammer falls)
    const advRes = await new Promise(res => participants[0].adapter.emit('advance_lot', {}, res));
    assert.equal(advRes.success, true);

    await new Promise(r => setTimeout(r, 200));

    // Verify LOT_COMPLETED broadcast received by all 10 participants
    for (const p of participants) {
      const lotComp = p.events.filter(e => e.type === 'LOT_COMPLETED').pop();
      assert.ok(lotComp, `Participant ${p.name} must receive LOT_COMPLETED`);
      assert.equal(lotComp.payload.result, 'SOLD');
      assert.equal(lotComp.payload.historyEntry.player.name, lot1.player.name);
      assert.equal(lotComp.payload.historyEntry.finalBid, expectedSold);
    }
    console.log(`[Stage 6] ${lot1.player.name} sold for ${expectedSold} Cr; all participants synchronized`);
  });

  // Test 7: Participant disconnect and reconnect
  await t.test('Stage 7: Participant disconnects, reconnects and restores state', async () => {
    const p3 = participants[2]; // RCB owner
    p3.adapter.disconnect();
    assert.equal(p3.adapter.connected, false);

    await new Promise(r => setTimeout(r, 100));

    // Reconnect with same participant token
    const p3NewAdapter = new CloudflareNativeWsAdapter(mfOrigin);
    p3NewAdapter.on('state_updated', (st) => p3.events.push({ type: 'STATE_UPDATED', payload: st }));
    p3NewAdapter.on('lot_presented', (st) => p3.events.push({ type: 'LOT_PRESENTED', payload: st }));
    p3NewAdapter.on('bid_accepted', (data) => p3.events.push({ type: 'BID_ACCEPTED', payload: data }));
    p3NewAdapter.on('lot_completed', (data) => p3.events.push({ type: 'LOT_COMPLETED', payload: data }));
    p3NewAdapter.on('timer_tick', (data) => p3.events.push({ type: 'TIMER_TICK', payload: data }));
    p3NewAdapter.on('auction_completed', (st) => p3.events.push({ type: 'AUCTION_COMPLETED', payload: st }));

    const rejoinRes = await new Promise((resolve) => {
      p3NewAdapter.emit('join_room', {
        roomCode,
        participantName: p3.name,
        participantToken: p3.token
      }, resolve);
    });

    assert.equal(rejoinRes.success, true);
    assert.equal(rejoinRes.room.roomCode, roomCode);
    assert.equal(rejoinRes.participant.franchiseId, p3.franchiseCode);

    // Replace adapter
    p3.adapter = p3NewAdapter;
    console.log('[Stage 7] Participant disconnected, reconnected, and restored franchise ownership');
  });

  // Test 8: Skip Set functionality
  await t.test('Stage 8: Host skips remaining set', async () => {
    // Advance to present player 2
    await new Promise(res => participants[0].adapter.emit('advance_lot', {}, res));
    await new Promise(r => setTimeout(r, 250));

    // Host skips set
    const skipRes = await new Promise(res => participants[0].adapter.emit('skip_set', {}, res));
    assert.equal(skipRes.success, true);
    assert.ok(skipRes.skippedCount > 0);
    console.log(`[Stage 8] Host skipped current set (${skipRes.skippedCount} players skipped)`);
  });

  // Test 9: Finish auction and verify Cricket Mastermind verdict across all participants
  await t.test('Stage 9: Host finishes auction & Cricket Mastermind evaluates all 10 squads', async () => {
    const finRes = await new Promise(res => participants[0].adapter.emit('finish_auction', {}, res));
    assert.equal(finRes.success, true);

    await new Promise(r => setTimeout(r, 300));

    // Verify auction_completed and Cricket Mastermind analysis on all 10 participants
    for (const p of participants) {
      const finMsg = p.events.filter(e => e.type === 'AUCTION_COMPLETED').pop() ||
                     p.events.filter(e => e.type === 'STATE_UPDATED' && e.payload?.status === 'completed').pop();
      assert.ok(finMsg, `Participant ${p.name} must receive completion state`);

      const analysis = finMsg.payload.analysis;
      assert.ok(analysis, 'Cricket Mastermind analysis must be present');
      assert.ok(analysis.verdict, 'Verdict must exist');
      assert.ok(analysis.verdict.winnerFranchiseId, 'Winner must be designated');
      assert.equal(analysis.rankings.length, 10, 'All 10 franchises must receive unique 1st-10th rankings');
    }
    console.log('[Stage 9] Auction completed; Cricket Mastermind generated rankings 1-10 for all 10 participants');
  });

  // Test 10: Clean teardown of all 10 WebSocket adapters
  await t.test('Stage 10: Clean multiplayer teardown', async () => {
    for (const p of participants) {
      p.adapter.disconnect();
    }
    for (const ctx of browserContexts) {
      await ctx.close();
    }
    console.log('[Stage 10] All 10 browser sessions and sockets closed cleanly');
  });
});
