// Real Local Cloudflare (workerd / Miniflare) Runtime Test Suite
// Executes against actual Cloudflare workerd C++ daemon with native WebSockets & SQLite
import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import esbuild from 'esbuild';
import { CloudflareNativeWsAdapter } from '../client/src/utils/wsAdapter.js';

test('Real Local Cloudflare workerd Runtime Suite', async (t) => {
  // 1. Bundle worker code with esbuild
  const build = esbuild.buildSync({
    entryPoints: ['cloudflare/src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    external: ['node:*', 'cloudflare:*']
  });

  const bundledCode = build.outputFiles[0].text;

  // 2. Instantiate Miniflare with DO SQLite enabled
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

  t.after(async () => {
    await mf.dispose();
  });

  let roomCode = null;
  const hostToken = 'usr_workerd_host_token_99999999';
  const bidderToken = 'usr_workerd_bidder_token_888888';

  // Test 1: Worker Health & Platform Metadata
  await t.test('1. Worker health check & DO SQLite platform report', async () => {
    const res = await mf.dispatchFetch('https://edge.workers.dev/api/health');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.platform, 'cloudflare-workers-durable-objects');
    assert.equal(data.storage.authoritative, true);
    assert.equal(data.storage.kind, 'cloudflare-durable-objects-sqlite');
  });

  // Test 2: Room Creation & DO SQLite Initialization
  await t.test('2. Room creation & Durable Object SQLite initialization', async () => {
    const res = await mf.dispatchFetch('https://edge.workers.dev/api/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://ipl-auction-omega-nine.vercel.app'
      },
      body: JSON.stringify({
        hostName: 'TestHost',
        hostToken,
        config: { basePurse: 120 }
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.roomCode);
    assert.equal(data.room.status, 'lobby');
    assert.equal(data.room.playersCatalog.length, 409);
    assert.equal(Object.keys(data.room.franchises).length, 10);
    roomCode = data.roomCode;
  });

  // Test 3: CORS & Edge Origin Security
  await t.test('3. Edge CORS and origin security', async () => {
    // 1. Disallowed origin on HTTP request -> 403
    const badHttpRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://malicious-phishing-site.com'
      },
      body: JSON.stringify({ hostName: 'Attacker' })
    });
    assert.equal(badHttpRes.status, 403);

    // 2. Disallowed origin on CORS preflight -> 403
    const badOptionsRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://malicious-phishing-site.com'
      }
    });
    assert.equal(badOptionsRes.status, 403);

    // 3. Approved origin on CORS preflight -> 204
    const goodOptionsRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ipl-auction-omega-nine.vercel.app'
      }
    });
    assert.equal(goodOptionsRes.status, 204);
  });

  // Test 4: Multiplayer WebSocket Joining, Franchise Claiming & Starting Auction
  await t.test('4. Multiplayer joining, franchise claiming and starting auction via WebSockets', async () => {
    // Connect Host
    const hostWsRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/ws`, {
      headers: { Upgrade: 'websocket', Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const hostWs = hostWsRes.webSocket;
    hostWs.accept();

    // Connect Bidder
    const bidderWsRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/ws`, {
      headers: { Upgrade: 'websocket', Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const bidderWs = bidderWsRes.webSocket;
    bidderWs.accept();

    const hostMessages = [];
    const bidderMessages = [];
    hostWs.addEventListener('message', e => hostMessages.push(JSON.parse(e.data)));
    bidderWs.addEventListener('message', e => bidderMessages.push(JSON.parse(e.data)));

    // Join Host
    hostWs.send(JSON.stringify({
      id: 'h_join',
      type: 'JOIN_ROOM',
      payload: { roomCode, participantName: 'HostUser', participantToken: hostToken }
    }));
    await new Promise(r => setTimeout(r, 150));

    // Join Bidder
    bidderWs.send(JSON.stringify({
      id: 'b_join',
      type: 'JOIN_ROOM',
      payload: { roomCode, participantName: 'BidderUser', participantToken: bidderToken }
    }));
    await new Promise(r => setTimeout(r, 150));

    // Host Claims CSK
    hostWs.send(JSON.stringify({
      id: 'h_claim',
      type: 'SELECT_FRANCHISE',
      payload: { franchiseId: 'CSK' }
    }));
    await new Promise(r => setTimeout(r, 150));

    // Bidder Claims MI
    bidderWs.send(JSON.stringify({
      id: 'b_claim',
      type: 'SELECT_FRANCHISE',
      payload: { franchiseId: 'MI' }
    }));
    await new Promise(r => setTimeout(r, 150));

    // Host starts auction
    hostWs.send(JSON.stringify({
      id: 'h_start',
      type: 'START_AUCTION',
      payload: {}
    }));
    await new Promise(r => setTimeout(r, 200));

    const startAck = hostMessages.find(m => m.id === 'h_start');
    assert.ok(startAck);
    assert.equal(startAck.success, true);

    const lotPresented = hostMessages.find(m => m.type === 'LOT_PRESENTED');
    assert.ok(lotPresented);
    assert.equal(lotPresented.payload.currentLot.lotNumber, 1);
    assert.equal(lotPresented.payload.currentLot.number, 1);
    assert.equal(lotPresented.payload.currentLot.player.categorySet, 'HIGH-R01-BAT');
    assert.ok(lotPresented.payload.currentLot.basePrice > 0);

    // Clean up sockets
    hostWs.close();
    bidderWs.close();
  });

  // Test 5: Real Bidding & Authoritative SQLite Persistence
  await t.test('5. Real bidding and authoritative SQLite persistence', async () => {
    // Query current state to obtain dynamically shuffled first player's basePrice
    const stateRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}`, {
      headers: { Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const stateData = await stateRes.json();
    const expectedBasePrice = stateData.currentLot.basePrice;

    const wsRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/ws`, {
      headers: { Upgrade: 'websocket', Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const ws = wsRes.webSocket;
    ws.accept();

    const messages = [];
    ws.addEventListener('message', e => messages.push(JSON.parse(e.data)));

    // Rejoin as Host (CSK owner)
    ws.send(JSON.stringify({
      id: 'rejoin_csk',
      type: 'JOIN_ROOM',
      payload: { roomCode, participantName: 'HostUser', participantToken: hostToken }
    }));
    await new Promise(r => setTimeout(r, 150));

    // Place opening bid at current lot's base price
    ws.send(JSON.stringify({
      id: 'bid_vk',
      type: 'PLACE_BID',
      payload: { franchiseId: 'CSK', bidAmount: expectedBasePrice, expectedVersion: 1 }
    }));
    await new Promise(r => setTimeout(r, 200));

    const bidAck = messages.find(m => m.id === 'bid_vk');
    assert.ok(bidAck);
    assert.equal(bidAck.success, true);
    assert.equal(bidAck.payload.bidRecord.amount, expectedBasePrice);
    assert.equal(bidAck.payload.bidRecord.franchiseId, 'CSK');

    const bidAccepted = messages.find(m => m.type === 'BID_ACCEPTED');
    assert.ok(bidAccepted);
    assert.equal(bidAccepted.payload.currentLot.highestBid, expectedBasePrice);

    ws.close();
  });

  // Test 6: Reconnection & Session Persistence
  await t.test('6. Reconnection and session recovery in workerd', async () => {
    // Open a fresh WebSocket pretending client lost connection
    const wsRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/ws`, {
      headers: { Upgrade: 'websocket', Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const ws = wsRes.webSocket;
    ws.accept();

    const messages = [];
    ws.addEventListener('message', e => messages.push(JSON.parse(e.data)));

    ws.send(JSON.stringify({
      id: 'reconnect_1',
      type: 'JOIN_ROOM',
      payload: { roomCode, participantName: 'HostUser', participantToken: hostToken }
    }));
    await new Promise(r => setTimeout(r, 150));

    const ack = messages.find(m => m.id === 'reconnect_1');
    assert.ok(ack);
    assert.equal(ack.success, true);
    assert.equal(ack.payload.participant.franchiseId, 'CSK'); // Still owns CSK!
    assert.ok(ack.payload.room.currentLot.highestBid > 0);

    ws.close();
  });

  // Test 7: Export Endpoint Security (401 without auth, 200 with host token)
  await t.test('7. Export endpoint security under workerd', async () => {
    // 1. Unauthenticated request -> 401
    const unauth = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/export`, {
      headers: { Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    assert.equal(unauth.status, 401);

    // 2. Unauthorized request (wrong token) -> 403
    const forbidden = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/export`, {
      headers: {
        Origin: 'https://ipl-auction-omega-nine.vercel.app',
        'x-host-token': 'wrong_token_123'
      }
    });
    assert.equal(forbidden.status, 403);

    // 3. Authorized request (correct hostToken) -> 200
    const auth = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/export`, {
      headers: {
        Origin: 'https://ipl-auction-omega-nine.vercel.app',
        'x-host-token': hostToken
      }
    });
    assert.equal(auth.status, 200);
    const data = await auth.json();
    assert.equal(data.roomCode, roomCode);
    assert.equal(data.authoritativeStore, 'cloudflare-durable-objects-sqlite');
    assert.ok(Array.isArray(data.bids));
    assert.equal(data.bids.length, 1); // Opening bid is durably stored!
    assert.ok(data.bids[0].amount_cr > 0);
    assert.equal(data.room.hostToken, undefined); // Token is scrubbed!
  });

  // Test 8: Room Isolation between Independent Rooms
  await t.test('8. Strict data isolation between independent Durable Object rooms', async () => {
    // Create Room 2
    const res2 = await mf.dispatchFetch('https://edge.workers.dev/api/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://ipl-auction-omega-nine.vercel.app'
      },
      body: JSON.stringify({
        hostName: 'Room2Host',
        hostToken: 'usr_room2_token_77777777',
        config: { basePurse: 120 }
      })
    });
    const data2 = await res2.json();
    const roomCode2 = data2.roomCode;
    assert.notEqual(roomCode2, roomCode);

    // Query state of Room 2
    const state2Res = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode2}`, {
      headers: { Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const state2 = await state2Res.json();
    assert.equal(state2.roomCode, roomCode2);
    assert.equal(state2.status, 'lobby'); // Room 2 is in lobby, while Room 1 is active!

    // Query state of Room 1
    const state1Res = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}`, {
      headers: { Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const state1 = await state1Res.json();
    assert.equal(state1.status, 'active');
  });

  // Test 9: Auction Completion & Cricket Mastermind Analysis
  await t.test('9. Auction completion & Cricket Mastermind rule-based analysis', async () => {
    const wsRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/ws`, {
      headers: { Upgrade: 'websocket', Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const ws = wsRes.webSocket;
    ws.accept();

    const messages = [];
    ws.addEventListener('message', e => messages.push(JSON.parse(e.data)));

    // Rejoin as Host
    ws.send(JSON.stringify({
      id: 'rejoin_finish',
      type: 'JOIN_ROOM',
      payload: { roomCode, participantName: 'HostUser', participantToken: hostToken }
    }));
    await new Promise(r => setTimeout(r, 150));

    // Finish auction
    ws.send(JSON.stringify({
      id: 'finish_req',
      type: 'FINISH_AUCTION',
      payload: {}
    }));
    await new Promise(r => setTimeout(r, 200));

    const finishAck = messages.find(m => m.id === 'finish_req');
    assert.ok(finishAck);
    assert.equal(finishAck.success, true);

    const completionMsg = messages.find(m => m.type === 'AUCTION_COMPLETED');
    assert.ok(completionMsg);
    assert.equal(completionMsg.payload.status, 'completed');
    assert.ok(completionMsg.payload.analysis); // Mastermind analysis generated!
    assert.equal(completionMsg.payload.analysis.rankings.length, 10);

    // Verify GET /api/rooms/:code/analysis
    const analysisRes = await mf.dispatchFetch(`https://edge.workers.dev/api/rooms/${roomCode}/analysis`, {
      headers: { Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    assert.equal(analysisRes.status, 200);
    const analysisData = await analysisRes.json();
    assert.equal(analysisData.roomCode, roomCode);
    assert.ok(analysisData.analysis.rankings);

    ws.close();
  });

  // Test 10: Frontend CloudflareNativeWsAdapter Integration with Live Local workerd Instance
  await t.test('10. Frontend CloudflareNativeWsAdapter integration with live local workerd instance', async () => {
    const serverUrl = (await mf.ready).origin;
    const adapter = new CloudflareNativeWsAdapter(serverUrl);
    try {
      let stateUpdatedReceived = false;
      adapter.on('state_updated', (room) => {
        if (room && room.roomCode === roomCode) {
          stateUpdatedReceived = true;
        }
      });

      // Connect and Join Room through frontend adapter (reconnect preserves registered display name)
      const joinResult = await new Promise((resolve) => {
        adapter.emit('join_room', {
          roomCode,
          participantName: 'HostUser',
          participantToken: hostToken
        }, (res) => {
          resolve(res);
        });
      });

      assert.ok(joinResult);
      assert.equal(joinResult.success, true);
      assert.equal(joinResult.room.roomCode, roomCode);
      assert.equal(joinResult.participant.name, 'HostUser');

      // A reconnect-join no longer fans out a full snapshot to every client (bandwidth
      // hardening); a real state change in a lobby must still reach the adapter as a broadcast.
      const lobbyRes = await mf.dispatchFetch('https://edge.workers.dev/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostName: 'AdapterHost', hostToken: 'usr_adapter_host_token_0001' })
      });
      const lobbyCode = (await lobbyRes.json()).roomCode;
      const lobbyAdapter = new CloudflareNativeWsAdapter(serverUrl);
      let lobbyBroadcast = false;
      lobbyAdapter.on('state_updated', (st) => { if (st?.roomCode === lobbyCode) lobbyBroadcast = true; });
      try {
        const j = await new Promise((resolve) => lobbyAdapter.emit('join_room', { roomCode: lobbyCode, participantName: 'AdapterHost', participantToken: 'usr_adapter_host_token_0001' }, resolve));
        assert.equal(j.success, true, j.error);
        const sel = await new Promise((resolve) => lobbyAdapter.emit('select_franchise', { franchiseId: 'LSG' }, resolve));
        assert.equal(sel.success, true, sel.error);
        await new Promise(r => setTimeout(r, 150));
        assert.equal(lobbyBroadcast, true);
      } finally {
        lobbyAdapter.disconnect();
      }
    } finally {
      adapter.disconnect();
    }
  });
});
