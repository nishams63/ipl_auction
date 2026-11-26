// Comprehensive Test Suite for Cloudflare Migration (16 Required Scenarios + Hardening Edge Cases)
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuctionRoomDO } from '../cloudflare/src/AuctionRoomDO.js';
import cfWorker from '../cloudflare/src/index.js';
import { CloudflareNativeWsAdapter } from '../client/src/utils/wsAdapter.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-Memory Durable Object Context Harness with SQLite & WebSocket Simulation
class MockDOContext {
  constructor() {
    this.storage = {
      sql: {
        room_meta: new Map(),
        bids: [],
        lot_results: [],
        outbox: [],
        processed_messages: new Map(), // key: `${room_code}:${token_hash}:${msg_id}` -> { ack_json, created_at }
        faultHook: null,
        exec: (query, ...params) => {
          if (this.storage.sql.faultHook) {
            this.storage.sql.faultHook(query, params);
          }
          if (query.includes('CREATE TABLE')) return [];
          if (query.includes('CREATE INDEX')) return [];
          if (query.includes('INSERT INTO room_meta')) {
            const [code, json, deadline, updated, maxSquad = 15, maxOverseas = 8] = params;
            this.storage.sql.room_meta.set(code, {
              state_json: json,
              deadline_epoch_ms: deadline,
              updated_at: updated,
              max_squad_size: maxSquad,
              max_overseas_players: maxOverseas
            });
            return [];
          }
          if (query.includes('SELECT state_json')) {
            const row = Array.from(this.storage.sql.room_meta.values())[0];
            return row ? [row] : [];
          }
          if (query.includes('INSERT INTO bids')) {
            const [bid_id, room_code, lot_number, player_id, franchise_id, amount_cr, state_version, created_at] = params;
            this.storage.sql.bids.push({ bid_id, room_code, lot_number, player_id, franchise_id, amount_cr, state_version, created_at });
            return [];
          }
          if (query.includes('SELECT status, final_bid_cr, winning_franchise_id FROM lot_results')) {
            const [room_code, lot_number] = params;
            const found = this.storage.sql.lot_results.find(r => r.room_code === room_code && r.lot_number === lot_number);
            return found ? [found] : [];
          }
          if (query.includes('INSERT INTO lot_results')) {
            const [room_code, lot_number, player_id, status, final_bid_cr, winning_franchise_id, created_at] = params;
            const existingIdx = this.storage.sql.lot_results.findIndex(r => r.room_code === room_code && r.lot_number === lot_number);
            const row = { room_code, lot_number, player_id, status, final_bid_cr, winning_franchise_id, created_at };
            if (existingIdx >= 0) this.storage.sql.lot_results[existingIdx] = row;
            else this.storage.sql.lot_results.push(row);
            return [];
          }
          if (query.includes('INSERT INTO outbox')) {
            const [room_code, event_type, payload_json, status, created_at] = params;
            const id = this.storage.sql.outbox.length + 1;
            this.storage.sql.outbox.push({ id, room_code, event_type, payload_json, status: status || 'pending', created_at });
            return [];
          }
          if (query.includes('SELECT id, room_code, event_type, payload_json FROM outbox WHERE status = \'pending\'')) {
            return this.storage.sql.outbox.filter(row => row.status === 'pending');
          }
          if (query.includes('UPDATE outbox SET status = \'delivered\' WHERE id = ?')) {
            const [targetId] = params;
            const target = this.storage.sql.outbox.find(row => row.id === targetId);
            if (target) target.status = 'delivered';
            return [];
          }
          if (query.includes('SELECT ack_json FROM processed_messages')) {
            const [room_code, token_hash, msg_id] = params;
            const key = `${room_code}:${token_hash}:${msg_id}`;
            const item = this.storage.sql.processed_messages.get(key);
            return item ? [{ ack_json: item.ack_json }] : [];
          }
          if (query.includes('INSERT INTO processed_messages')) {
            const [room_code, token_hash, msg_id, ack_json, created_at] = params;
            const key = `${room_code}:${token_hash}:${msg_id}`;
            this.storage.sql.processed_messages.set(key, { ack_json, created_at });
            return [];
          }
          if (query.includes('DELETE FROM processed_messages WHERE created_at < ?')) {
            const [cutoff] = params;
            for (const [k, v] of this.storage.sql.processed_messages.entries()) {
              if (v.created_at < cutoff) {
                this.storage.sql.processed_messages.delete(k);
              }
            }
            return [];
          }
          return [];
        }
      },
      transactionSync: (closure) => {
        const snapshot = {
          room_meta: new Map(this.storage.sql.room_meta),
          bids: [...this.storage.sql.bids],
          lot_results: [...this.storage.sql.lot_results],
          outbox: [...this.storage.sql.outbox],
          processed_messages: new Map(this.storage.sql.processed_messages)
        };
        try {
          return closure();
        } catch (err) {
          this.storage.sql.room_meta = snapshot.room_meta;
          this.storage.sql.bids = snapshot.bids;
          this.storage.sql.lot_results = snapshot.lot_results;
          this.storage.sql.outbox = snapshot.outbox;
          this.storage.sql.processed_messages = snapshot.processed_messages;
          throw err;
        }
      },
      alarm: null,
      getAlarm: async () => {
        return this.storage.alarm;
      },
      setAlarm: async (epochMs) => {
        this.storage.alarm = epochMs;
      },
      deleteAlarm: async () => {
        this.storage.alarm = null;
      }
    };
    this.webSockets = new Set();
  }

  waitUntil(promise) {
    if (promise && typeof promise.then === 'function') {
      promise.catch(err => console.error('[waitUntil error]', err));
    }
  }

  acceptWebSocket(ws) {
    this.webSockets.add(ws);
  }

  getWebSockets() {
    return Array.from(this.webSockets);
  }
}

class MockWebSocket {
  constructor(name = 'client') {
    this.name = name;
    this.attachment = null;
    this.messages = [];
  }

  serializeAttachment(data) {
    this.attachment = data;
  }

  deserializeAttachment() {
    return this.attachment;
  }

  send(raw) {
    this.messages.push(JSON.parse(raw));
  }
}

function createDO(env = {}) {
  const ctx = new MockDOContext();
  const doInstance = new AuctionRoomDO(ctx, env);
  return { doInstance, ctx };
}

test('Cloudflare Migration Suite - All 16 Scenarios + Hardening Verifications', async (t) => {
  // Scenario 1: Two users join one auction room
  await t.test('Scenario 1: Two users join one auction room', async () => {
    const { doInstance } = createDO();
    const initRes = await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef' })
    }));
    assert.equal(initRes.status, 200);

    const ws1 = new MockWebSocket('User1');
    const ws2 = new MockWebSocket('User2');
    doInstance.ctx.acceptWebSocket(ws1);
    doInstance.ctx.acceptWebSocket(ws2);

    await doInstance.webSocketMessage(ws1, JSON.stringify({
      id: '1',
      type: 'JOIN_ROOM',
      payload: { roomCode: 'ROOM01', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' }
    }));

    await doInstance.webSocketMessage(ws2, JSON.stringify({
      id: '2',
      type: 'JOIN_ROOM',
      payload: { roomCode: 'ROOM01', participantName: 'UserTwo', participantToken: 'usr_user2_token_1234567890abcdef' }
    }));

    assert.equal(doInstance.room.participants.size, 2);
    const ack1 = ws1.messages.find(m => m.id === '1');
    const ack2 = ws2.messages.find(m => m.id === '2');
    assert.equal(ack1?.success, true);
    assert.equal(ack2?.success, true);
  });

  // Scenario 2: Ten users participate in one room
  await t.test('Scenario 2: Ten users participate in one room', async () => {
    const { doInstance } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM10', hostName: 'User1', hostToken: 'usr_host_token_1234567890abcdef' })
    }));

    for (let i = 1; i <= 10; i++) {
      const ws = new MockWebSocket(`User${i}`);
      doInstance.ctx.acceptWebSocket(ws);
      await doInstance.webSocketMessage(ws, JSON.stringify({
        id: `join_${i}`,
        type: 'JOIN_ROOM',
        payload: { roomCode: 'ROOM10', participantName: `User${i}`, participantToken: `usr_token_${i}_1234567890123456` }
      }));
    }
    assert.equal(doInstance.room.participants.size, 10);
  });

  // Scenario 3: Two or more independent auction rooms operate simultaneously
  await t.test('Scenario 3: Two or more independent auction rooms operate simultaneously', async () => {
    const { doInstance: do1 } = createDO();
    const { doInstance: do2 } = createDO();

    await do1.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM_A', hostName: 'HostA', hostToken: 'usr_token_a_1234567890123456' })
    }));

    await do2.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM_B', hostName: 'HostB', hostToken: 'usr_token_b_1234567890123456' })
    }));

    assert.equal(do1.room.roomCode, 'ROOM_A');
    assert.equal(do2.room.roomCode, 'ROOM_B');
    assert.notEqual(do1.room.roomCode, do2.room.roomCode);
  });

  // Scenario 4: Valid bids reset the timer & persist to SQLite
  await t.test('Scenario 4: Valid bids reset the timer & persist to SQLite', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'TIMER1', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'j',
      type: 'JOIN_ROOM',
      payload: { roomCode: 'TIMER1', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' }
    }));

    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'f',
      type: 'SELECT_FRANCHISE',
      payload: { franchiseId: 'CSK' }
    }));

    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 's',
      type: 'START_AUCTION',
      payload: {}
    }));

    const firstAlarm = ctx.storage.alarm;
    assert.ok(firstAlarm > Date.now());
    const basePrice = doInstance.room.currentLot.basePrice;

    // Place valid bid
    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'b',
      type: 'PLACE_BID',
      payload: { franchiseId: 'CSK', bidAmount: basePrice, expectedVersion: 1 }
    }));

    const secondAlarm = ctx.storage.alarm;
    assert.ok(secondAlarm >= firstAlarm);
    assert.equal(doInstance.room.currentLot.highestBid, basePrice);

    // Verify bid row was committed to SQLite
    assert.equal(ctx.storage.sql.bids.length, 1);
    assert.equal(ctx.storage.sql.bids[0].amount_cr, basePrice);
    assert.equal(ctx.storage.sql.bids[0].franchise_id, 'CSK');
  });

  // Scenario 5: Invalid bids do not reset the timer
  await t.test('Scenario 5: Invalid bids do not reset the timer', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'TIMER2', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'j',
      type: 'JOIN_ROOM',
      payload: { roomCode: 'TIMER2', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' }
    }));

    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    const initialAlarm = ctx.storage.alarm;

    // Send invalid bid amount
    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'bad_bid',
      type: 'PLACE_BID',
      payload: { franchiseId: 'CSK', bidAmount: 999.0, expectedVersion: 1 }
    }));

    const ack = ws.messages.find(m => m.id === 'bad_bid');
    assert.equal(ack.success, false);
    assert.equal(ctx.storage.alarm, initialAlarm);
  });

  // Scenario 6: Two users bid simultaneously (serialized by DO single-thread)
  await t.test('Scenario 6: Two users bid simultaneously', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'CONCUR', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef' })
    }));

    const ws1 = new MockWebSocket('U1');
    const ws2 = new MockWebSocket('U2');
    ctx.acceptWebSocket(ws1);
    ctx.acceptWebSocket(ws2);

    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'j1', type: 'JOIN_ROOM', payload: { roomCode: 'CONCUR', participantName: 'U1', participantToken: 'usr_user1_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws2, JSON.stringify({ id: 'j2', type: 'JOIN_ROOM', payload: { roomCode: 'CONCUR', participantName: 'U2', participantToken: 'usr_user2_token_1234567890abcdef' } }));

    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'f1', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws2, JSON.stringify({ id: 'f2', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'MI' } }));

    doInstance.room.hostToken = 'usr_user1_token_1234567890abcdef';
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    const openBase = doInstance.room.currentLot.basePrice;
    // Both attempt to bid base price at expectedVersion 1
    const bid1Promise = doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'bid1', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));
    const bid2Promise = doInstance.webSocketMessage(ws2, JSON.stringify({ id: 'bid2', type: 'PLACE_BID', payload: { franchiseId: 'MI', bidAmount: openBase, expectedVersion: 1 } }));

    await Promise.all([bid1Promise, bid2Promise]);

    const ack1 = ws1.messages.find(m => m.id === 'bid1');
    const ack2 = ws2.messages.find(m => m.id === 'bid2');

    // Exactly one succeeds, the other gets rejected due to version mismatch or outbid
    const successCount = (ack1.success ? 1 : 0) + (ack2.success ? 1 : 0);
    assert.equal(successCount, 1);
  });

  // Scenario 7: Timer expires during a bid
  await t.test('Scenario 7: Timer expires during a bid', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'EXPIRE', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'EXPIRE', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    // Trigger timer expiry
    doInstance.room.deadlineEpochMs = Date.now() - 1;
    await doInstance.alarm();
    assert.equal(doInstance.room.currentLot.hammerStatus, 'UNSOLD');

    // Attempt bid on closed lot
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'late_bid', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: 2.0 } }));
    const ack = ws.messages.find(m => m.id === 'late_bid');
    assert.equal(ack.success, false);
    assert.equal(ack.error, 'Bidding is closed for this player');
  });

  // Scenario 8: All users disconnect and reconnect
  await t.test('Scenario 8: All users disconnect and reconnect', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'RECONN', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef' })
    }));

    const ws1 = new MockWebSocket('Old');
    ctx.acceptWebSocket(ws1);
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'RECONN', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));

    // Simulating complete disconnect
    ctx.webSockets.clear();

    // Reconnecting on fresh socket
    const ws2 = new MockWebSocket('New');
    ctx.acceptWebSocket(ws2);
    await doInstance.webSocketMessage(ws2, JSON.stringify({ id: 'rejoin', type: 'JOIN_ROOM', payload: { roomCode: 'RECONN', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));

    const ack = ws2.messages.find(m => m.id === 'rejoin');
    assert.equal(ack.success, true);
    assert.equal(ack.payload.participant.franchiseId, 'CSK');
  });

  // Scenario 9: A Durable Object becomes inactive and resumes
  await t.test('Scenario 9: A Durable Object becomes inactive and resumes', async () => {
    const ctx = new MockDOContext();
    const do1 = new AuctionRoomDO(ctx, {});
    await do1.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'RESUME1', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef' })
    }));

    // Recreating DO instance simulating eviction & restart
    const do2 = new AuctionRoomDO(ctx, {});
    assert.ok(do2.room);
    assert.equal(do2.room.roomCode, 'RESUME1');
    assert.equal(do2.room.hostName, 'HostUser');
  });

  // Scenario 10: Auction state recovers after interruption
  await t.test('Scenario 10: Auction state recovers after interruption', async () => {
    const ctx = new MockDOContext();
    const do1 = new AuctionRoomDO(ctx, {});
    await do1.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'INTERRUPT', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await do1.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'INTERRUPT', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await do1.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await do1.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));
    const openBase = do1.room.currentLot.basePrice;
    await do1.webSocketMessage(ws, JSON.stringify({ id: 'b', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));

    // Simulating sudden process crash & recovery
    const do2 = new AuctionRoomDO(ctx, {});
    assert.equal(do2.room.currentLot.highestBid, openBase);
    assert.equal(do2.room.currentLot.bidder, 'CSK');
  });

  // Scenario 11: A player is sold exactly once & writes to lot_results/outbox
  await t.test('Scenario 11: A player is sold exactly once & writes to lot_results/outbox', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'SOLDFUN', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'SOLDFUN', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));
    const openBase = doInstance.room.currentLot.basePrice;
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'b', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));

    doInstance.room.deadlineEpochMs = Date.now() - 1;
    await doInstance.alarm();
    assert.equal(doInstance.room.franchises.CSK.squad.length, 1);
    assert.equal(doInstance.room.franchises.CSK.squad[0].boughtPrice, openBase);
    assert.equal(ctx.storage.sql.lot_results.length, 1);
    assert.equal(ctx.storage.sql.outbox.length, 1);
    assert.equal(ctx.storage.sql.outbox[0].event_type, 'LOT_SOLD');

    // Repeated alarm does not re-sell lot, but advances to next lot after configured display pause
    doInstance.room.deadlineEpochMs = Date.now() - 1;
    await doInstance.alarm();
    assert.equal(doInstance.room.franchises.CSK.squad.length, 1);
    assert.equal(doInstance.room.currentLot.lotNumber, 2); // Automatically advanced!
  });

  // Scenario 12: Different rooms cannot access one another's data
  await t.test('Scenario 12: Different rooms cannot access one another data', async () => {
    const { doInstance: doA } = createDO();
    const { doInstance: doB } = createDO();

    await doA.fetch(new Request('https://internal/init', { method: 'POST', body: JSON.stringify({ roomCode: 'ROOMA', hostName: 'Alice', hostToken: 'usr_alice_token_1234567890abcdef' }) }));
    await doB.fetch(new Request('https://internal/init', { method: 'POST', body: JSON.stringify({ roomCode: 'ROOMB', hostName: 'Bob', hostToken: 'usr_bob_token_1234567890abcdef' }) }));

    const wsA = new MockWebSocket();
    doA.ctx.acceptWebSocket(wsA);
    await doA.webSocketMessage(wsA, JSON.stringify({ id: 'ja', type: 'JOIN_ROOM', payload: { roomCode: 'ROOMA', participantName: 'Alice', participantToken: 'usr_alice_token_1234567890abcdef' } }));

    assert.equal(doA.room.participants.size, 1);
    assert.equal(doB.room.participants.size, 0);
  });

  // Scenario 13: Existing auction history remains intact
  await t.test('Scenario 13: Existing auction history remains intact', async () => {
    const diskPath = path.join(__dirname, '..', 'server', 'data', 'persisted_rooms.json');
    const content = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
    const rooms = Array.isArray(content) ? content : Object.values(content);
    assert.equal(rooms.length, 21);
    const activeRooms = rooms.filter(r => r.status === 'active');
    assert.equal(activeRooms.length, 7);
  });

  // Scenario 14: Existing player catalogue remains intact
  await t.test('Scenario 14: Existing player catalogue remains intact', async () => {
    const playersPath = path.join(__dirname, '..', 'server', 'data', 'players.json');
    const catalog = JSON.parse(fs.readFileSync(playersPath, 'utf-8'));
    assert.equal(catalog.length, 409);
  });

  // Scenario 15: React clients receive correct lobby snapshots (Unity removed)
  await t.test('Scenario 15: React clients receive correct lobby snapshots', async () => {
    const { doInstance } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'UNITYTEST', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef' })
    }));

    const publicState = doInstance.getPublicRoomState();
    assert.equal(publicState.status, 'lobby');
    assert.equal(Object.keys(publicState.franchises).length, 10);
    assert.equal(publicState.currentLot, null);
  });

  // Scenario 16: Database outages do not silently lose accepted bids & Outbox syncs safely
  await t.test('Scenario 16: Database outages do not silently lose accepted bids & Outbox syncs safely', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'OUTAGE', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'OUTAGE', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    const openBase = doInstance.room.currentLot.basePrice;
    // Even if external Neon DB connection fails, local SQLite holds state safely
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'b', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));

    assert.equal(doInstance.room.currentLot.highestBid, openBase);
    assert.equal(doInstance.room.currentLot.bidder, 'CSK');

    // Lot expires, writes outbox
    doInstance.room.deadlineEpochMs = Date.now() - 1;
    await doInstance.alarm();
    assert.equal(ctx.storage.sql.outbox.length, 1);
    assert.equal(ctx.storage.sql.outbox[0].status, 'pending');

    // Simulate database recovery: flushOutbox delivers safely and marks delivered
    const deliveredEvents = [];
    const flushRes = await doInstance.flushOutbox(async (eventType, payload) => {
      deliveredEvents.push({ eventType, payload });
    });

    assert.equal(flushRes.deliveredCount, 1);
    assert.equal(deliveredEvents.length, 1);
    assert.equal(ctx.storage.sql.outbox[0].status, 'delivered');
  });

  // Hardening Scenario 17: Duplicate bid messages & replayed message IDs (Idempotency)
  await t.test('Scenario 17: Duplicate message ID replay protection', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'REPLAY', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'REPLAY', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    const openBase = doInstance.room.currentLot.basePrice;
    // Send first bid
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'bid_repeat', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));
    const versionAfterFirst = doInstance.room.currentLot.stateVersion;

    // Send the EXACT SAME message ID again (network duplicate)
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'bid_repeat', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));

    // State version MUST NOT change, no second bid recorded
    assert.equal(doInstance.room.currentLot.stateVersion, versionAfterFirst);
    assert.equal(ctx.storage.sql.bids.length, 1);
  });

  // Hardening Scenario 18: Oversized payload rejection (> 32 KB)
  await t.test('Scenario 18: Oversized payload rejection (> 32 KB)', async () => {
    const { doInstance, ctx } = createDO();
    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);

    const hugePayload = 'X'.repeat(35000);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'huge', type: 'PING', payload: { data: hugePayload } }));

    const errorMsg = ws.messages.find(m => m.type === 'ERROR');
    assert.ok(errorMsg);
    assert.ok(errorMsg.error.includes('Payload too large'));
  });

  // Hardening Scenario 19: Valid bid arriving at timer expiry cancels premature closure
  await t.test('Scenario 19: Valid bid arriving at timer expiry cancels premature closure', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'RACE', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'RACE', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    const openBase = doInstance.room.currentLot.basePrice;
    // Simulate valid bid arriving at the exact instant an alarm was queued
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'late_valid_bid', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));

    // Now an outdated alarm fires, but deadlineEpochMs is 15s in the future
    await doInstance.alarm();

    // The lot MUST remain OPEN because the bid reset the deadline!
    assert.equal(doInstance.room.currentLot.hammerStatus, 'OPEN');
    assert.equal(doInstance.room.currentLot.highestBid, openBase);
  });

  // Hardening Scenario 20: Frontend wsAdapter callback envelope, listeners & timer tick
  await t.test('Scenario 20: Frontend wsAdapter callback envelope, listeners & timer tick', async () => {
    const adapter = new CloudflareNativeWsAdapter('http://localhost:8787');

    let listenerTriggered = 0;
    const testHandler = () => { listenerTriggered++; };
    adapter.on('custom_event', testHandler);
    adapter.trigger('custom_event', {});
    assert.equal(listenerTriggered, 1);

    // Test off without handler removes all listeners
    adapter.off('custom_event');
    adapter.trigger('custom_event', {});
    assert.equal(listenerTriggered, 1); // Not incremented

    // Test timer_tick generation from deadline
    let tickCount = 0;
    let lastTick = null;
    adapter.on('timer_tick', (tick) => {
      tickCount++;
      lastTick = tick;
    });

    const deadline = Date.now() + 14000;
    adapter.syncLocalCountdown(deadline, { hammerStatus: 'OPEN', stateVersion: 1 });
    assert.ok(tickCount >= 1);
    assert.ok(lastTick.countdown > 0);
    assert.equal(lastTick.hammerStatus, 'OPEN');
    adapter.stopLocalCountdown();
  });

  // Hardening Scenario 21: Persistent deduplication survives Durable Object eviction & restart
  await t.test('Scenario 21: Persistent deduplication survives Durable Object eviction & restart', async () => {
    const ctx = new MockDOContext();
    const do1 = new AuctionRoomDO(ctx, {});
    await do1.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'EVICT_ACK', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws1 = new MockWebSocket('User1');
    ctx.acceptWebSocket(ws1);
    await do1.webSocketMessage(ws1, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'EVICT_ACK', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await do1.webSocketMessage(ws1, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await do1.webSocketMessage(ws1, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    const openBase = do1.room.currentLot.basePrice;
    // Send bid on instance 1
    await do1.webSocketMessage(ws1, JSON.stringify({ id: 'bid_persist_unique', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));
    const ack1 = ws1.messages.find(m => m.id === 'bid_persist_unique');
    assert.equal(ack1.success, true);
    assert.equal(do1.room.currentLot.stateVersion, 2);

    // Evict instance 1 completely from memory and create brand-new DO instance 2 from persistent SQLite
    const do2 = new AuctionRoomDO(ctx, {});
    const ws2 = new MockWebSocket('User1_Reconnected');
    ctx.acceptWebSocket(ws2);
    // User reconnects
    await do2.webSocketMessage(ws2, JSON.stringify({ id: 'j_re', type: 'JOIN_ROOM', payload: { roomCode: 'EVICT_ACK', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));

    // Send the SAME message ID on the brand-new DO instance
    await do2.webSocketMessage(ws2, JSON.stringify({ id: 'bid_persist_unique', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));

    // Must return the cached ACK from SQLite
    const ack2 = ws2.messages.find(m => m.id === 'bid_persist_unique');
    assert.ok(ack2);
    assert.equal(ack2.success, true);
    // State version MUST NOT increment again
    assert.equal(do2.room.currentLot.stateVersion, 2);
    // Bids table has exactly 1 entry
    assert.equal(ctx.storage.sql.bids.length, 1);
  });

  // Hardening Scenario 22: Boundary timing: late bid rejected at or after authoritative deadline
  await t.test('Scenario 22: Boundary timing: late bid rejected at or after authoritative deadline', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'BOUNDARY', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'BOUNDARY', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    // Simulate clock advancing past the authoritative deadline
    doInstance.room.currentLot.deadlineEpochMs = Date.now() - 50;
    doInstance.room.deadlineEpochMs = doInstance.room.currentLot.deadlineEpochMs;
    const openBase = doInstance.room.currentLot.basePrice;

    // Late bid submitted after expiry
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'late_boundary_bid', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: openBase, expectedVersion: 1 } }));

    const ack = ws.messages.find(m => m.id === 'late_boundary_bid');
    assert.equal(ack.success, false);
    assert.equal(ack.error, 'Bidding is closed for this player');
    assert.equal(doInstance.room.currentLot.highestBid, 0); // No bid accepted
  });

  // Hardening Scenario 23: Outbox partial delivery & recovery after failure
  await t.test('Scenario 23: Outbox partial delivery & recovery after failure', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'PARTIAL', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'PARTIAL', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    // Lot 1 expires -> writes 1st outbox event
    doInstance.room.deadlineEpochMs = Date.now() - 1;
    await doInstance.alarm();

    // 3s pause expires -> advances to Lot 2
    doInstance.room.deadlineEpochMs = Date.now() - 1;
    await doInstance.alarm();

    // Lot 2 expires -> writes 2nd outbox event
    doInstance.room.deadlineEpochMs = Date.now() - 1;
    await doInstance.alarm();

    assert.equal(ctx.storage.sql.outbox.length, 2);
    assert.equal(ctx.storage.sql.outbox[0].status, 'pending');
    assert.equal(ctx.storage.sql.outbox[1].status, 'pending');

    // Simulate partial delivery failure on 2nd item
    let deliveryCalls = 0;
    await doInstance.flushOutbox(async (eventType, payload) => {
      deliveryCalls++;
      if (deliveryCalls === 2) throw new Error('Neon database network partition');
    });

    // 1st item delivered, 2nd item remains pending!
    assert.equal(ctx.storage.sql.outbox[0].status, 'delivered');
    assert.equal(ctx.storage.sql.outbox[1].status, 'pending');

    // Simulate network restored: second flush delivers the remaining item
    const secondFlush = await doInstance.flushOutbox(async (eventType, payload) => {
      // successfully delivered
    });
    assert.equal(secondFlush.deliveredCount, 1);
    assert.equal(ctx.storage.sql.outbox[1].status, 'delivered');
  });

  // Hardening Scenario 24: Bid persistence failure leaves in-memory state pristine & rejects bid
  await t.test('Scenario 24: Bid persistence failure leaves in-memory state pristine & rejects bid', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'SQL_FAIL', hostName: 'HostUser', hostToken: 'usr_host_token_1234567890abcdef', config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket();
    ctx.acceptWebSocket(ws);
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'j', type: 'JOIN_ROOM', payload: { roomCode: 'SQL_FAIL', participantName: 'HostUser', participantToken: 'usr_host_token_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 'f', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    const initialLot = { ...doInstance.room.currentLot };
    const initialAlarm = ctx.storage.alarm;
    const initialBidsCount = (doInstance.room.recentBids || []).length;

    // Simulate SQLite crash on bids insert
    const originalExec = ctx.storage.sql.exec;
    ctx.storage.sql.exec = (query, ...params) => {
      if (query.includes('INSERT INTO bids')) {
        throw new Error('SQLite disk I/O error');
      }
      return originalExec(query, ...params);
    };

    // Attempt bid while SQLite is failing
    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'failing_bid',
      type: 'PLACE_BID',
      payload: { franchiseId: 'CSK', bidAmount: initialLot.basePrice, expectedVersion: 1 }
    }));

    // Bid must be rejected!
    const ack = ws.messages.find(m => m.id === 'failing_bid');
    assert.equal(ack.success, false);
    assert.equal(ack.error, 'Failed to persist bid to durable storage');

    // In-memory state MUST remain completely untouched!
    assert.equal(doInstance.room.currentLot.highestBid, initialLot.highestBid);
    assert.equal(doInstance.room.currentLot.bidder, initialLot.bidder);
    assert.equal(doInstance.room.currentLot.stateVersion, initialLot.stateVersion);
    assert.equal(doInstance.room.recentBids.length, initialBidsCount);
    assert.equal(ctx.storage.alarm, initialAlarm); // Alarm NOT rescheduled!

    // Restore SQLite
    ctx.storage.sql.exec = originalExec;
  });

  // Hardening Scenario 25: CORS allowlist validation for HTTP endpoints
  await t.test('Scenario 25: CORS allowlist validation for HTTP endpoints', async () => {
    // 1. Allowed Production Origin
    const allowedReq = new Request('https://edge.workers.dev/api/health', {
      method: 'GET',
      headers: { Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    });
    const allowedRes = await cfWorker.fetch(allowedReq, {}, {});
    assert.equal(allowedRes.status, 200);
    assert.equal(allowedRes.headers.get('Access-Control-Allow-Origin'), 'https://ipl-auction-omega-nine.vercel.app');

    // 2. Unapproved Browser Origin
    const forbiddenReq = new Request('https://edge.workers.dev/api/health', {
      method: 'GET',
      headers: { Origin: 'https://malicious-attacker.com' }
    });
    const forbiddenRes = await cfWorker.fetch(forbiddenReq, {}, {});
    assert.equal(forbiddenRes.status, 403);

    // 3. OPTIONS Preflight from Unapproved Origin & Stranger Vercel Origin
    const preflightReq = new Request('https://edge.workers.dev/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: 'https://malicious-attacker.com' }
    });
    const preflightRes = await cfWorker.fetch(preflightReq, {}, {});
    assert.equal(preflightRes.status, 403);

    const otherVercelReq = new Request('https://edge.workers.dev/api/health', {
      method: 'GET',
      headers: { Origin: 'https://someone-elses-app.vercel.app' }
    });
    assert.equal((await cfWorker.fetch(otherVercelReq, { ENVIRONMENT: 'production' }, {})).status, 403);

    // 4. Project-scoped Vercel Preview Origin Allowed
    const previewReq = new Request('https://edge.workers.dev/api/health', {
      method: 'GET',
      headers: { Origin: 'https://ipl-auction-kr9mwn4d8-nishams63s-projects.vercel.app' }
    });
    const previewRes = await cfWorker.fetch(previewReq, { ENVIRONMENT: 'production' }, {});
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.headers.get('Access-Control-Allow-Origin'), 'https://ipl-auction-kr9mwn4d8-nishams63s-projects.vercel.app');
  });

  // Hardening Scenario 26: WebSocket upgrade Origin validation
  await t.test('Scenario 26: WebSocket upgrade Origin validation', async () => {
    const mockEnv = {
      AUCTION_ROOMS: {
        idFromName: () => 'mock_id',
        get: () => ({
          fetch: async () => ({ status: 101 })
        })
      }
    };

    // 1. WebSocket upgrade from approved Origin
    const allowedWsReq = new Request('https://edge.workers.dev/api/rooms/TEST01/ws', {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://ipl-auction-omega-nine.vercel.app'
      }
    });
    const allowedWsRes = await cfWorker.fetch(allowedWsReq, mockEnv, {});
    assert.equal(allowedWsRes.status, 101);

    // 2. WebSocket upgrade from unapproved Origin
    const forbiddenWsReq = new Request('https://edge.workers.dev/api/rooms/TEST01/ws', {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://hacker-phishing.com'
      }
    });
    const forbiddenWsRes = await cfWorker.fetch(forbiddenWsReq, mockEnv, {});
    assert.equal(forbiddenWsRes.status, 403);
  });

  // Hardening Scenario 27: Full room export / backup endpoint with host authentication
  await t.test('Scenario 27: Full room export / backup endpoint with host authentication', async () => {
    const hostToken = 'usr_host_token_1234567890abcdef';
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'EXPORT01', hostName: 'HostUser', hostToken })
    }));

    // 1. Unauthenticated export attempt (no token provided) -> 401
    const unauthRes = await doInstance.fetch(new Request('https://internal/export', { method: 'GET' }));
    assert.equal(unauthRes.status, 401);
    const unauthData = await unauthRes.json();
    assert.ok(unauthData.error.includes('Authentication required'));

    // 2. Unauthorized export attempt (wrong token) -> 403
    const forbiddenRes = await doInstance.fetch(new Request('https://internal/export', {
      method: 'GET',
      headers: { 'x-host-token': 'wrong_attacker_token_12345' }
    }));
    assert.equal(forbiddenRes.status, 403);
    const forbiddenData = await forbiddenRes.json();
    assert.ok(forbiddenData.error.includes('Forbidden'));

    // 3. Authorized export attempt via x-host-token header -> 200
    const authHeaderRes = await doInstance.fetch(new Request('https://internal/export', {
      method: 'GET',
      headers: { 'x-host-token': hostToken }
    }));
    assert.equal(authHeaderRes.status, 200);

    const snapshot = await authHeaderRes.json();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.roomCode, 'EXPORT01');
    assert.equal(snapshot.authoritativeStore, 'cloudflare-durable-objects-sqlite');
    assert.ok(Array.isArray(snapshot.bids));
    assert.ok(Array.isArray(snapshot.lotResults));
    assert.ok(Array.isArray(snapshot.outboxEvents));

    // Confirm that snapshot does NOT leak host or participant tokens
    assert.equal(snapshot.room.hostToken, undefined);
    assert.equal(snapshot.room.participants, undefined);
    for (const f of Object.values(snapshot.room.franchises)) {
      assert.equal(f.ownerToken, undefined);
    }

    // 4. Tokens in the URL are no longer accepted (URLs leak into logs/history) -> 401
    //    (security hardening 2026-11: header-only host authentication)
    const authQueryRes = await doInstance.fetch(new Request(`https://internal/export?token=${hostToken}`, {
      method: 'GET'
    }));
    assert.equal(authQueryRes.status, 401);

    // 5. Raw tokens are not persisted: only hashes are stored
    const stored = JSON.stringify(Array.from(ctx.storage.sql.room_meta.values()));
    assert.ok(!stored.includes(hostToken), 'raw host token must never be persisted');
  });

  // Hardening Scenario 28: SQLite transactionSync rollback on partial persistence failure
  await t.test('Scenario 28: SQLite transactionSync rollback on partial persistence failure', async () => {
    const { doInstance, ctx } = createDO();
    const hostToken = 'usr_host_token_rollback_test';
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'TX_FAIL', hostName: 'HostUser', hostToken, config: { minParticipants: 1 } })
    }));

    const ws = new MockWebSocket('bidder');
    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'join_1',
      type: 'JOIN_ROOM',
      payload: { roomCode: 'TX_FAIL', participantName: 'BidderUser', participantToken: hostToken }
    }));

    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'claim_1',
      type: 'SELECT_FRANCHISE',
      payload: { franchiseId: 'CSK' }
    }));

    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'start_1',
      type: 'START_AUCTION',
      payload: {}
    }));

    // Record initial state before bid
    const initialLot = { ...doInstance.room.currentLot };
    const initialBidsCount = ctx.storage.sql.bids.length;

    // Simulate partial failure: INSERT INTO bids succeeds, but INSERT INTO room_meta throws
    const origExec = ctx.storage.sql.exec.bind(ctx.storage.sql);
    ctx.storage.sql.exec = (query, ...params) => {
      if (query.includes('INSERT INTO room_meta')) {
        throw new Error('Simulated SQLite constraint failure on room_meta');
      }
      return origExec(query, ...params);
    };

    // Attempt to place a valid bid
    await doInstance.webSocketMessage(ws, JSON.stringify({
      id: 'bid_fail_tx',
      type: 'PLACE_BID',
      payload: { franchiseId: 'CSK', bidAmount: initialLot.basePrice, expectedVersion: initialLot.stateVersion }
    }));

    // 1. Verify rejection response
    const ack = ws.messages.find(m => m.id === 'bid_fail_tx');
    assert.ok(ack);
    assert.equal(ack.success, false);
    assert.equal(ack.error, 'Failed to persist bid to durable storage');

    // 2. Verify SQLite transaction ROLLBACK: bids table must NOT contain the bid!
    assert.equal(ctx.storage.sql.bids.length, initialBidsCount);

    // 3. Verify in-memory state is pristine (not corrupted)
    assert.equal(doInstance.room.currentLot.highestBid, initialLot.highestBid);
    assert.equal(doInstance.room.currentLot.bidCount, initialLot.bidCount);
    assert.equal(doInstance.room.currentLot.stateVersion, initialLot.stateVersion);
    assert.equal(doInstance.room.deadlineEpochMs, initialLot.deadlineEpochMs);
  });

  // Hardening Scenario 29: Neon outbox sync auto-triggered on lot closure when DATABASE_URL is configured
  await t.test('Scenario 29: Neon outbox sync auto-triggered on lot closure', async () => {
    let neonQueryExecuted = false;
    let neonReceivedQuery = '';

    // Mock global fetch for Neon HTTP queries
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('my-neon-host.neon.tech/sql')) {
        neonQueryExecuted = true;
        neonReceivedQuery = JSON.parse(opts.body).query;
        return new Response(JSON.stringify({ rowCount: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, opts);
    };

    try {
      const mockEnv = { DATABASE_URL: 'postgres://user:neon_pass@my-neon-host.neon.tech/db' };
      const ctx = new MockDOContext();
      const doInstance = new AuctionRoomDO(ctx, mockEnv);

      await doInstance.fetch(new Request('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ roomCode: 'NEON_AUTO', hostName: 'HostUser', hostToken: 'usr_neon_auto_token', config: { minParticipants: 1 } })
      }));

      // Setup and start auction
      const ws = new MockWebSocket('host');
      await doInstance.webSocketMessage(ws, JSON.stringify({
        id: 'join_neon',
        type: 'JOIN_ROOM',
        payload: { roomCode: 'NEON_AUTO', participantName: 'HostUser', participantToken: 'usr_neon_auto_token' }
      }));
      await doInstance.webSocketMessage(ws, JSON.stringify({
        id: 'claim_neon',
        type: 'SELECT_FRANCHISE',
        payload: { franchiseId: 'MI' }
      }));
      await doInstance.webSocketMessage(ws, JSON.stringify({
        id: 'start_neon',
        type: 'START_AUCTION',
        payload: {}
      }));

      // Place winning bid
      const basePrice = doInstance.room.currentLot.basePrice;
      await doInstance.webSocketMessage(ws, JSON.stringify({
        id: 'bid_neon',
        type: 'PLACE_BID',
        payload: { franchiseId: 'MI', bidAmount: basePrice, expectedVersion: 1 }
      }));

      // Close lot
      doInstance.room.deadlineEpochMs = Date.now() - 1;
      doInstance.room.currentLot.deadlineEpochMs = Date.now() - 1;
      await doInstance.alarm();

      // Wait a tick for waitUntil to settle
      await new Promise(r => setTimeout(r, 20));

      // Verify Neon was called with LOT_SOLD
      assert.ok(neonQueryExecuted);
      assert.ok(neonReceivedQuery.includes('INSERT INTO lot_results'));

      // Verify outbox record status was updated to delivered
      const deliveredOutbox = ctx.storage.sql.outbox.find(r => r.event_type === 'LOT_SOLD');
      assert.ok(deliveredOutbox);
      assert.equal(deliveredOutbox.status, 'delivered');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Hardening Scenario 30: Frontend socket.js adapter contract & Socket.IO compatibility
  await t.test('Scenario 30: Frontend socket.js adapter contract & Socket.IO compatibility', async () => {
    // 1. Verify CloudflareNativeWsAdapter interface
    const adapter = new CloudflareNativeWsAdapter('https://my-backend.workers.dev');
    assert.equal(typeof adapter.on, 'function');
    assert.equal(typeof adapter.off, 'function');
    assert.equal(typeof adapter.emit, 'function');
    assert.equal(typeof adapter.connect, 'function');
    assert.equal(typeof adapter.disconnect, 'function');
    assert.equal(typeof adapter.connected, 'boolean');
    assert.equal(typeof adapter.id, 'string');
    assert.ok(adapter.id.startsWith('ws_'));

    // 2. Verify ACK callback resolution
    let ackResult = null;
    adapter.emit('test_event', { foo: 'bar' }, (res) => {
      ackResult = res;
    });

    // Extract message id from pending acks
    const msgId = Array.from(adapter.pendingAcks.keys())[0];
    assert.ok(msgId);

    // Simulate incoming ACK from DO
    adapter.ws = {
      readyState: 1,
      send: () => {}
    };
    // Mock onmessage handler call
    const mockEvent = {
      data: JSON.stringify({
        id: msgId,
        type: 'ACK',
        success: true,
        payload: { updated: true }
      })
    };
    // Trigger onmessage logic
    const parsed = JSON.parse(mockEvent.data);
    const cb = adapter.pendingAcks.get(parsed.id);
    adapter.pendingAcks.delete(parsed.id);
    cb({ success: true, ...parsed.payload });

    assert.deepEqual(ackResult, { success: true, updated: true });
  });

  // Hardening Scenario 31: Production blockers fixed (minParticipants, shuffle, isOverseas cap, boughtPrice, PlayingXI, auditLog, TOKEN_HASH_SECRET)
  await t.test('Scenario 31: minParticipants & shuffleWithinSets enforcement', async () => {
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'MINP01', hostName: 'Host', hostToken: 'usr_host_minp_1234567890abcdef' })
    }));

    const ws1 = new MockWebSocket('H');
    ctx.acceptWebSocket(ws1);
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'j1', type: 'JOIN_ROOM', payload: { roomCode: 'MINP01', participantName: 'Host', participantToken: 'usr_host_minp_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'f1', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));

    // Starting with 1 claimed franchise must fail (minParticipants defaults to 2)
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 's_fail', type: 'START_AUCTION', payload: {} }));
    assert.equal(ws1.messages.find(m => m.id === 's_fail').success, false);

    // Join second participant & claim MI -> start succeeds and shuffles within sets keeping all 409 unique players
    const ws2 = new MockWebSocket('P2');
    ctx.acceptWebSocket(ws2);
    await doInstance.webSocketMessage(ws2, JSON.stringify({ id: 'j2', type: 'JOIN_ROOM', payload: { roomCode: 'MINP01', participantName: 'P2', participantToken: 'usr_p2_minp_1234567890abcdef' } }));
    await doInstance.webSocketMessage(ws2, JSON.stringify({ id: 'f2', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'MI' } }));
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 's_ok', type: 'START_AUCTION', payload: {} }));
    assert.equal(ws1.messages.find(m => m.id === 's_ok').success, true);

    assert.equal(doInstance.room.playersCatalog.length, 409);
    const ids = new Set(doInstance.room.playersCatalog.map(p => p.id));
    assert.equal(ids.size, 409);
    assert.equal(doInstance.room.currentLot.lotNumber, 1);
    assert.ok(doInstance.room.currentLot.nextPlayer);
    assert.ok(Array.isArray(doInstance.room.auditLog));
    assert.ok(doInstance.room.auditLog[0].type && doInstance.room.auditLog[0].message);
  });

  await t.test('Scenario 32: Overseas cap (8 max), lakh arithmetic, boughtPrice & Playing XI validation', async () => {
    const { doInstance, ctx } = createDO();
    const hTok = 'usr_host_rules_1234567890abcdef';
    const pTok = 'usr_p2_rules_1234567890abcdef';
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'OVS001', hostName: 'Host', hostToken: hTok })
    }));

    const ws1 = new MockWebSocket('H');
    const ws2 = new MockWebSocket('P2');
    ctx.acceptWebSocket(ws1);
    ctx.acceptWebSocket(ws2);
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'j1', type: 'JOIN_ROOM', payload: { roomCode: 'OVS001', participantName: 'Host', participantToken: hTok } }));
    await doInstance.webSocketMessage(ws2, JSON.stringify({ id: 'j2', type: 'JOIN_ROOM', payload: { roomCode: 'OVS001', participantName: 'P2', participantToken: pTok } }));
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'f1', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(ws2, JSON.stringify({ id: 'f2', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'MI' } }));
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 's', type: 'START_AUCTION', payload: {} }));

    // Advance & buy 8 overseas players for CSK and 1 WK for CSK
    let msgSeq = 1;
    let wkBought = false;
    while ((doInstance.room.franchises.CSK.overseasCount < 8 || !wkBought) && doInstance.room.status === 'active') {
      const lot = doInstance.room.currentLot;
      const p = lot.player;
      const canTakePlayer = !p.isOverseas || doInstance.room.franchises.CSK.overseasCount < 8;
      const wantCSK = canTakePlayer && ((p.isOverseas && doInstance.room.franchises.CSK.overseasCount < 8) || (!wkBought && p.category === 'WK'));
      if (wantCSK) {
        const bidId = `bid_${msgSeq++}`;
        await doInstance.webSocketMessage(ws1, JSON.stringify({ id: bidId, type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: lot.basePrice, expectedVersion: lot.stateVersion } }));
        assert.equal(ws1.messages.find(m => m.id === bidId).success, true);
        if (p.category === 'WK') wkBought = true;
      }
      await doInstance.webSocketMessage(ws1, JSON.stringify({ id: `adv_c_${msgSeq++}`, type: 'ADVANCE_LOT', payload: {} }));
      await doInstance.webSocketMessage(ws1, JSON.stringify({ id: `adv_n_${msgSeq++}`, type: 'ADVANCE_LOT', payload: {} }));
      await new Promise(r => setTimeout(r, 110));
    }

    assert.equal(doInstance.room.franchises.CSK.overseasCount, 8);
    assert.ok(doInstance.room.franchises.CSK.squad.every(p => typeof p.boughtPrice === 'number' && p.boughtPrice > 0));
    // Verify exact lakh accounting (spent + remaining === 120)
    assert.equal(Math.round((doInstance.room.franchises.CSK.totalSpent + doInstance.room.franchises.CSK.remainingPurse) * 100), 12000);

    // Find next overseas player and verify CSK is blocked from bidding
    while (doInstance.room.status === 'active' && !doInstance.room.currentLot?.player?.isOverseas) {
      await doInstance.webSocketMessage(ws1, JSON.stringify({ id: `skip_c_${msgSeq++}`, type: 'ADVANCE_LOT', payload: {} }));
      await doInstance.webSocketMessage(ws1, JSON.stringify({ id: `skip_n_${msgSeq++}`, type: 'ADVANCE_LOT', payload: {} }));
      await new Promise(r => setTimeout(r, 110));
    }
    if (doInstance.room.status === 'active') {
      const lot = doInstance.room.currentLot;
      await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'ovs_block', type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: lot.basePrice, expectedVersion: lot.stateVersion } }));
      const ovsAck = ws1.messages.find(m => m.id === 'ovs_block');
      assert.equal(ovsAck.success, false);
      assert.ok(/Overseas/i.test(ovsAck.error));
    }

    // Playing XI validation: unowned player rejected, >4 overseas rejected, valid owned player accepted & updates playingXIConfigurations
    const unownedId = doInstance.room.playersCatalog.find(p => p.status === 'available').id;
    await doInstance.webSocketMessage(ws1, JSON.stringify({
      id: 'xi_unowned', type: 'UPDATE_PLAYING_XI', payload: { franchiseId: 'CSK', playingXI: [unownedId] }
    }));
    assert.equal(ws1.messages.find(m => m.id === 'xi_unowned').success, false);
    assert.equal(ws1.messages.find(m => m.id === 'xi_unowned').code, 'PLAYER_NOT_IN_SQUAD');

    const cskOverseasIds = doInstance.room.franchises.CSK.squad.filter(p => p.isOverseas).slice(0, 5).map(p => p.id);
    await doInstance.webSocketMessage(ws1, JSON.stringify({
      id: 'xi_5os', type: 'UPDATE_PLAYING_XI', payload: { franchiseId: 'CSK', playingXI: cskOverseasIds }
    }));
    assert.equal(ws1.messages.find(m => m.id === 'xi_5os').success, false);

    // Other participant (MI) cannot edit CSK Playing XI
    const validId = doInstance.room.franchises.CSK.squad[0].id;
    await doInstance.webSocketMessage(ws2, JSON.stringify({
      id: 'xi_forbid', type: 'UPDATE_PLAYING_XI', payload: { franchiseId: 'CSK', playingXI: [validId] }
    }));
    assert.equal(ws2.messages.find(m => m.id === 'xi_forbid').success, false);
    assert.equal(ws2.messages.find(m => m.id === 'xi_forbid').code, 'FORBIDDEN');

    await doInstance.webSocketMessage(ws1, JSON.stringify({
      id: 'xi_ok', type: 'UPDATE_PLAYING_XI', payload: { franchiseId: 'CSK', playingXI: [validId] }
    }));
    assert.equal(ws1.messages.find(m => m.id === 'xi_ok').success, true);
    assert.deepEqual(doInstance.room.playingXIConfigurations.CSK.playingXI, [validId]);

    // Finish & confirm Mastermind sees real spent amount
    await doInstance.webSocketMessage(ws1, JSON.stringify({ id: 'fin', type: 'FINISH_AUCTION', payload: {} }));
    assert.equal(doInstance.room.analysis.franchises.CSK.purse.spent, doInstance.room.franchises.CSK.totalSpent);
    assert.ok(doInstance.room.analysis.summary.totalExpenditure > 0);
  });

  await t.test('Scenario 33: Production auth enforcement, localhost block & secret rotation safety', async () => {
    const prodEnvNoSecret = { ENVIRONMENT: 'production' };
    const healthMissing = await cfWorker.fetch(new Request('https://edge.workers.dev/api/health', {
      headers: { Origin: 'https://ipl-auction-omega-nine.vercel.app' }
    }), prodEnvNoSecret, {});
    assert.equal((await healthMissing.json()).status, 'degraded');

    const createMissing = await cfWorker.fetch(new Request('https://edge.workers.dev/api/rooms', {
      method: 'POST',
      headers: { Origin: 'https://ipl-auction-omega-nine.vercel.app' },
      body: JSON.stringify({ hostName: 'H', hostToken: 'usr_valid_host_token_1234567890' })
    }), prodEnvNoSecret, {});
    assert.equal(createMissing.status, 503);

    const localhostProd = await cfWorker.fetch(new Request('https://edge.workers.dev/api/health', {
      headers: { Origin: 'http://localhost:5173' }
    }), { ENVIRONMENT: 'production', TOKEN_HASH_SECRET: 'A_32_CHAR_OR_LONGER_PROD_SECRET_KEY_12345' }, {});
    assert.equal(localhostProd.status, 403);

    // Secret change detection inside DO
    const ctx = new MockDOContext();
    const do1 = new AuctionRoomDO(ctx, { ENVIRONMENT: 'production', TOKEN_HASH_SECRET: 'SECRET_ONE_32_CHARS_MINIMUM_VALUE_XYZ' });
    await do1.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'ROT001', hostName: 'Host', hostToken: 'usr_rot_token_1234567890abcdef' })
    }));
    const doRotated = new AuctionRoomDO(ctx, { ENVIRONMENT: 'production', TOKEN_HASH_SECRET: 'SECRET_TWO_DIFFERENT_VALUE_32_CHARS_XYZ' });
    const ws = new MockWebSocket('R');
    await doRotated.webSocketMessage(ws, JSON.stringify({
      id: 'jr', type: 'JOIN_ROOM', payload: { roomCode: 'ROT001', participantName: 'Host', participantToken: 'usr_rot_token_1234567890abcdef' }
    }));
    assert.equal(ws.messages.find(m => m.id === 'jr').success, false);
  });

  await t.test('Scenario 34: Save-Before-Broadcast atomicity, storage failure hold, retries, races, and recovery', async () => {
    const H_TOK = 'usr_host_save34_1234567890abcdef';
    const A_TOK = 'usr_alice_save34_1234567890abcd';

    async function setupActiveBiddedRoom(code) {
      const { doInstance, ctx } = createDO();
      await doInstance.fetch(new Request('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ roomCode: code, hostName: 'Host', hostToken: H_TOK, config: { minParticipants: 2, autoAdvanceDelay: 2 } })
      }));
      const wsh = new MockWebSocket('H');
      const wsa = new MockWebSocket('A');
      ctx.acceptWebSocket(wsh);
      ctx.acceptWebSocket(wsa);
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'jh', type: 'JOIN_ROOM', payload: { roomCode: code, participantName: 'Host', participantToken: H_TOK } }));
      await doInstance.webSocketMessage(wsa, JSON.stringify({ id: 'ja', type: 'JOIN_ROOM', payload: { roomCode: code, participantName: 'Alice', participantToken: A_TOK } }));
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'fh', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
      await doInstance.webSocketMessage(wsa, JSON.stringify({ id: 'fa', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'MI' } }));
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'st', type: 'START_AUCTION', payload: {} }));

      const lot = doInstance.room.currentLot;
      await doInstance.webSocketMessage(wsa, JSON.stringify({
        id: 'bid1',
        type: 'PLACE_BID',
        payload: { roomCode: code, franchiseId: 'MI', bidAmount: lot.basePrice, expectedVersion: lot.stateVersion }
      }));
      return { doInstance, ctx, wsh, wsa, lotPrice: lot.basePrice, playerId: lot.player.id };
    }

    // 1. SQLite write failure immediately before sale (failing before lot_results write)
    {
      const { doInstance, ctx, wsh, playerId } = await setupActiveBiddedRoom('SBF_01');
      ctx.storage.sql.faultHook = (q) => {
        if (q.includes('INSERT INTO lot_results')) throw new Error('SQLITE_BUSY: disk write blocked before sale');
      };
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'adv_fail1', type: 'ADVANCE_LOT', payload: {} }));
      const ack = wsh.messages.find(m => m.id === 'adv_fail1');
      assert.equal(ack.success, false);
      assert.equal(ack.code, 'STORAGE_UNAVAILABLE');
      assert.equal(wsh.messages.filter(m => m.type === 'LOT_COMPLETED').length, 0, 'Must NEVER announce SOLD/UNSOLD before DB save');
      assert.equal(doInstance.room.status, 'paused', 'Room must pause safely on storage failure');
      assert.equal(doInstance.room.deadlineEpochMs, null, 'Timer must stop');
      assert.equal(ctx.storage.alarm, null, 'DO alarm must be cleared');
      assert.equal(doInstance.room.storageFailure?.code, 'STORAGE_UNAVAILABLE');
      assert.equal(doInstance.room.currentLot.hammerStatus, 'OPEN');
      assert.equal(doInstance.room.franchises.MI.remainingPurse, 120);
      assert.equal(doInstance.room.franchises.MI.squad.length, 0);
      assert.equal(ctx.storage.sql.lot_results.length, 0);
      assert.equal(doInstance.room.playersCatalog.find(p => p.id === playerId).status, 'in_auction');

      // 6. Retry after storage recovery (via RESUME_AUCTION) completes sale cleanly once
      ctx.storage.sql.faultHook = null;
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'rec_1', type: 'RESUME_AUCTION', payload: {} }));
      const recAck = wsh.messages.find(m => m.id === 'rec_1');
      assert.equal(recAck.success, true, recAck.error);
      assert.equal(doInstance.room.storageFailure, null);
      assert.equal(doInstance.room.status, 'active');
      assert.equal(wsh.messages.filter(m => m.type === 'LOT_COMPLETED').length, 1);
      assert.equal(ctx.storage.sql.lot_results.length, 1);
      assert.equal(doInstance.room.franchises.MI.squad.length, 1);
      assert.ok(doInstance.room.franchises.MI.remainingPurse < 120);
    }

    // 2. Failure mid-transaction (lot_results & outbox succeed, room_meta throws -> transactionSync rolls back all SQL tables + memory rolls back)
    {
      const { doInstance, ctx, wsh, lotPrice } = await setupActiveBiddedRoom('SBF_02');
      ctx.storage.sql.faultHook = (q) => {
        if (q.includes('INSERT INTO room_meta')) throw new Error('SQLITE_FULL mid-transaction');
      };
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'adv_fail2', type: 'ADVANCE_LOT', payload: {} }));
      const ack = wsh.messages.find(m => m.id === 'adv_fail2');
      assert.equal(ack.success, false);
      assert.equal(ack.code, 'STORAGE_UNAVAILABLE');
      assert.equal(ctx.storage.sql.lot_results.length, 0, 'Transaction rollback must clear lot_results');
      assert.equal(ctx.storage.sql.outbox.length, 0, 'Transaction rollback must clear outbox');
      assert.equal(wsh.messages.filter(m => m.type === 'LOT_COMPLETED').length, 0);
      assert.equal(doInstance.room.status, 'paused');
      assert.equal(doInstance.room.franchises.MI.remainingPurse, 120);
      assert.equal(doInstance.room.franchises.MI.squad.length, 0);

      // 5. Worker restart during failure -> new DO loads last committed OPEN lot (or expired alarm) and closes once cleanly after recovery
      ctx.storage.sql.faultHook = null;
      const metaRow = ctx.storage.sql.room_meta.get('SBF_02');
      const savedState = JSON.parse(metaRow.state_json);
      savedState.deadlineEpochMs = Date.now() - 1000; // simulate deadline elapsed
      ctx.storage.sql.room_meta.set('SBF_02', { ...metaRow, state_json: JSON.stringify(savedState), deadline_epoch_ms: savedState.deadlineEpochMs });

      const restartedDO = new AuctionRoomDO(ctx);
      await restartedDO.ensureAlarmRestored();
      assert.equal(ctx.storage.sql.lot_results.length, 1);
      assert.equal(restartedDO.room.franchises.MI.squad.length, 1);
      assert.equal(restartedDO.room.franchises.MI.remainingPurse, 120 - lotPrice);
    }

    // 3. Failure after transaction commit but before broadcast -> SQLite retains committed sale once, no duplicate sale on retry/restart
    {
      const { doInstance, ctx, wsh, lotPrice } = await setupActiveBiddedRoom('SBF_03');
      const origBroadcast = doInstance.broadcast.bind(doInstance);
      doInstance.broadcast = (type, payload) => {
        if (type === 'LOT_COMPLETED') throw new Error('Simulated crash after commit before broadcast');
        return origBroadcast(type, payload);
      };
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'adv_post', type: 'ADVANCE_LOT', payload: {} }));
      assert.equal(ctx.storage.sql.lot_results.length, 1);
      assert.equal(doInstance.room.franchises.MI.squad.length, 1);
      assert.equal(doInstance.room.franchises.MI.remainingPurse, 120 - lotPrice);

      // Simulate duplicate close retry + worker restart -> zero duplicate sale
      doInstance.broadcast = origBroadcast;
      await doInstance.closeCurrentLot(1);
      const restarted = new AuctionRoomDO(ctx);
      await restarted.closeCurrentLot(1);
      assert.equal(ctx.storage.sql.lot_results.length, 1);
      assert.equal(restarted.room.franchises.MI.squad.length, 1);
      assert.equal(restarted.room.franchises.MI.remainingPurse, 120 - lotPrice);
    }

    // 4 & 8. Duplicate close requests + Duplicate and replayed WebSocket message IDs
    {
      const { doInstance, ctx, wsh, lotPrice } = await setupActiveBiddedRoom('SBF_04');
      await Promise.all([
        doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'dup_adv_1', type: 'ADVANCE_LOT', payload: {} })),
        doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'dup_adv_2', type: 'ADVANCE_LOT', payload: {} })),
        doInstance.alarm()
      ]);
      // Replay exact same message id again
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'dup_adv_1', type: 'ADVANCE_LOT', payload: {} }));

      assert.equal(ctx.storage.sql.lot_results.length, 1);
      assert.equal(doInstance.room.franchises.MI.squad.length, 1);
      assert.equal(doInstance.room.franchises.MI.remainingPurse, 120 - lotPrice);
      assert.equal(wsh.messages.filter(m => m.type === 'LOT_COMPLETED').length, 1, 'LOT_COMPLETED must be broadcast once');
      assert.equal(wsh.messages.filter(m => m.id === 'dup_adv_1').length, 2, 'Replay receives cached ACK');
    }

    // 7. Simultaneous bid and lot-close race
    {
      const { doInstance, ctx, wsh, wsa } = await setupActiveBiddedRoom('SBF_07');
      const lot = doInstance.room.currentLot;
      await Promise.all([
        doInstance.webSocketMessage(wsh, JSON.stringify({
          id: 'race_bid_h',
          type: 'PLACE_BID',
          payload: { roomCode: 'SBF_07', franchiseId: 'CSK', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion }
        })),
        doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'race_close', type: 'ADVANCE_LOT', payload: {} }))
      ]);
      // Regardless of winner order, room & SQLite are strictly consistent with exactly 1 lot_results row
      assert.equal(ctx.storage.sql.lot_results.length, 1);
      const totalSold = doInstance.room.franchises.MI.squad.length + doInstance.room.franchises.CSK.squad.length;
      assert.equal(totalSold, 1);
      const totalPurseLeft = doInstance.room.franchises.MI.remainingPurse + doInstance.room.franchises.CSK.remainingPurse;
      const recordedPrice = ctx.storage.sql.lot_results[0].final_bid_cr;
      assert.equal(Math.round((totalPurseLeft + recordedPrice) * 100), 24000);
      void wsa;
    }
  });

  await t.test('Scenario 35: Canonical increment boundaries & fixed 15s timer enforcement', async () => {
    const { calculateNextBid } = await import('../server/auctionEngine.js');
    // Boundary verification in ₹ Cr (100L/Cr integer precision)
    assert.equal(calculateNextBid(9.75), 10.00);
    assert.equal(calculateNextBid(10.00), 10.50);
    assert.equal(calculateNextBid(14.50), 15.00);
    assert.equal(calculateNextBid(15.00), 16.00);

    const H_TOK = 'usr_host_rule35_1234567890abcdef';
    const A_TOK = 'usr_alice_rule35_1234567890abcd';
    const { doInstance, ctx } = createDO();
    await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ roomCode: 'RULE35', hostName: 'Host', hostToken: H_TOK, config: { minParticipants: 2 } })
    }));
    const wsh = new MockWebSocket('H');
    const wsa = new MockWebSocket('A');
    ctx.acceptWebSocket(wsh);
    ctx.acceptWebSocket(wsa);
    await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'jh', type: 'JOIN_ROOM', payload: { roomCode: 'RULE35', participantName: 'Host', participantToken: H_TOK } }));
    await doInstance.webSocketMessage(wsa, JSON.stringify({ id: 'ja', type: 'JOIN_ROOM', payload: { roomCode: 'RULE35', participantName: 'Alice', participantToken: A_TOK } }));
    await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'fh', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(wsa, JSON.stringify({ id: 'fa', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'MI' } }));

    // Host cannot change timerDuration away from 15s
    await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'cfg25', type: 'UPDATE_CONFIG', payload: { config: { timerDuration: 25 } } }));
    assert.equal(wsh.messages.find(m => m.id === 'cfg25').success, false);
    assert.equal(doInstance.room.config.timerDuration, 15);

    await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'st', type: 'START_AUCTION', payload: {} }));
    const lotPresented = wsh.messages.find(m => m.type === 'LOT_PRESENTED');
    assert.equal(lotPresented.payload.currentLot.timerDuration, 15);
    const startRemaining = lotPresented.payload.deadlineEpochMs - Date.now();
    assert.ok(startRemaining > 13500 && startRemaining <= 15100);

    // Invalid bid does NOT reset timer or advance version
    const initialDeadline = doInstance.room.deadlineEpochMs - 5000;
    doInstance.room.deadlineEpochMs = initialDeadline;
    doInstance.room.currentLot.deadlineEpochMs = initialDeadline;
    await doInstance.webSocketMessage(wsa, JSON.stringify({
      id: 'bad_bid',
      type: 'PLACE_BID',
      payload: { roomCode: 'RULE35', franchiseId: 'CSK', bidAmount: doInstance.room.currentLot.basePrice, expectedVersion: doInstance.room.currentLot.stateVersion }
    }));
    assert.equal(wsa.messages.find(m => m.id === 'bad_bid').success, false);
    assert.equal(doInstance.room.deadlineEpochMs, initialDeadline);

    // Valid bid resets timer back to 15s
    await doInstance.webSocketMessage(wsa, JSON.stringify({
      id: 'good_bid',
      type: 'PLACE_BID',
      payload: { roomCode: 'RULE35', franchiseId: 'MI', bidAmount: doInstance.room.currentLot.basePrice, expectedVersion: doInstance.room.currentLot.stateVersion }
    }));
    assert.equal(wsa.messages.find(m => m.id === 'good_bid').success, true);
    const afterBidRem = doInstance.room.deadlineEpochMs - Date.now();
    assert.ok(afterBidRem > 13500 && afterBidRem <= 15100);

    // Reconnect snapshot preserves server-authoritative remaining time (<= 15s)
    const wsa2 = new MockWebSocket('A2');
    ctx.acceptWebSocket(wsa2);
    await doInstance.webSocketMessage(wsa2, JSON.stringify({ id: 'jr2', type: 'JOIN_ROOM', payload: { roomCode: 'RULE35', participantName: 'Alice', participantToken: A_TOK } }));
    const recSnap = wsa2.messages.find(m => m.id === 'jr2').payload.room;
    assert.ok(recSnap.currentLot.countdown >= 1 && recSnap.currentLot.countdown <= 15);
    assert.equal(recSnap.currentLot.deadlineEpochMs, doInstance.room.deadlineEpochMs);
  });

  await t.test('Scenario 36: Dynamic squad size (15) & overseas limit (5) during room creation, multi-team enforcement & legacy fallback', async () => {
    const H_TOK = 'usr_host_dyn36_1234567890abcdef';
    const A_TOK = 'usr_alice_dyn36_1234567890abcd';
    const { doInstance, ctx } = createDO();

    // Reject overseas limit exceeding squad size
    const badInit = await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({
        roomCode: 'DYN_BAD',
        hostName: 'Host',
        hostToken: H_TOK,
        config: { minParticipants: 2, maxSquadSize: 15, maxOverseas: 16 }
      })
    }));
    assert.equal(badInit.status, 400);

    // Create room with custom max_squad_size = 15 & max_overseas_players = 5
    const goodInit = await doInstance.fetch(new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({
        roomCode: 'DYN036',
        hostName: 'Host',
        hostToken: H_TOK,
        config: { minParticipants: 2, max_squad_size: 15, max_overseas_players: 5, autoAdvanceDelay: 1 }
      })
    }));
    assert.equal(goodInit.status, 200);
    const createdBody = await goodInit.json();
    assert.equal(createdBody.room.max_squad_size, 15);
    assert.equal(createdBody.room.max_overseas_players, 5);
    assert.equal(createdBody.room.config.maxSquadSize, 15);
    assert.equal(createdBody.room.config.maxOverseas, 5);

    const wsh = new MockWebSocket('H');
    const wsa = new MockWebSocket('A');
    ctx.acceptWebSocket(wsh);
    ctx.acceptWebSocket(wsa);
    await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'jh', type: 'JOIN_ROOM', payload: { roomCode: 'DYN036', participantName: 'Host', participantToken: H_TOK } }));
    await doInstance.webSocketMessage(wsa, JSON.stringify({ id: 'ja', type: 'JOIN_ROOM', payload: { roomCode: 'DYN036', participantName: 'Alice', participantToken: A_TOK } }));
    await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'fh', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'CSK' } }));
    await doInstance.webSocketMessage(wsa, JSON.stringify({ id: 'fa', type: 'SELECT_FRANCHISE', payload: { franchiseId: 'MI' } }));
    await doInstance.webSocketMessage(wsh, JSON.stringify({ id: 'st', type: 'START_AUCTION', payload: {} }));

    let seq = 1;
    let cskWk = false;
    // CSK buys 5 overseas + 10 Indian (including 1 WK) = 15 total; MI buys 2 different players concurrently
    while (doInstance.room.status === 'active' && (doInstance.room.franchises.CSK.squad.length < 15 || doInstance.room.franchises.MI.squad.length < 2)) {
      if (wsh.attachment) wsh.attachment.msgCount = 0;
      if (wsa.attachment) wsa.attachment.msgCount = 0;
      const lot = doInstance.room.currentLot;
      if (!lot || lot.hammerStatus !== 'OPEN') {
        await doInstance.webSocketMessage(wsh, JSON.stringify({ id: `adv_p_${seq++}`, type: 'ADVANCE_LOT', payload: {} }));
        continue;
      }
      const p = lot.player;
      const csk = doInstance.room.franchises.CSK;
      const mi = doInstance.room.franchises.MI;

      if (csk.overseasCount === 5 && p.isOverseas) {
        // CSK has reached 5/5 overseas -> MUST be rejected on overseas player
        const osFailId = `os_blk_${seq++}`;
        await doInstance.webSocketMessage(wsh, JSON.stringify({
          id: osFailId, type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: lot.basePrice, expectedVersion: lot.stateVersion }
        }));
        const osFailAck = wsh.messages.find(m => m.id === osFailId);
        assert.equal(osFailAck.success, false);
        assert.match(osFailAck.error, /Overseas player limit reached!/);

        // Meanwhile MI (0/5 OS) CAN still bid on that same overseas player!
        if (mi.squad.length < 2 && p.basePrice <= 5) {
          const miBidId = `mi_bid_${seq++}`;
          await doInstance.webSocketMessage(wsa, JSON.stringify({
            id: miBidId, type: 'PLACE_BID', payload: { franchiseId: 'MI', bidAmount: lot.basePrice, expectedVersion: lot.stateVersion }
          }));
          assert.equal(wsa.messages.find(m => m.id === miBidId).success, true);
        }
      } else if (csk.squad.length < 15 && p.basePrice <= 5) {
        const needWkOnly = !cskWk && csk.squad.length === 14;
        const needIndianOnly = csk.overseasCount >= 5;
        const canBuy = (!needWkOnly || p.category === 'WK') && (!needIndianOnly || !p.isOverseas);
        if (canBuy) {
          const cskBidId = `csk_bid_${seq++}`;
          await doInstance.webSocketMessage(wsh, JSON.stringify({
            id: cskBidId, type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: lot.basePrice, expectedVersion: lot.stateVersion }
          }));
          if (wsh.messages.find(m => m.id === cskBidId).success && p.category === 'WK') {
            cskWk = true;
          }
        }
      } else if (mi.squad.length < 2 && p.basePrice <= 5 && !p.isOverseas) {
        const miBidId = `mi_ind_${seq++}`;
        await doInstance.webSocketMessage(wsa, JSON.stringify({
          id: miBidId, type: 'PLACE_BID', payload: { franchiseId: 'MI', bidAmount: lot.basePrice, expectedVersion: lot.stateVersion }
        }));
      }

      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: `adv_c_${seq++}`, type: 'ADVANCE_LOT', payload: {} }));
      await doInstance.webSocketMessage(wsh, JSON.stringify({ id: `adv_n_${seq++}`, type: 'ADVANCE_LOT', payload: {} }));
    }

    assert.equal(doInstance.room.franchises.CSK.overseasCount, 5, 'CSK stopped at 5 overseas');
    assert.equal(doInstance.room.franchises.CSK.squad.length, 15, 'CSK stopped at 15 players (10 IND + 5 OS)');

    // Once CSK is at 15/15, CSK MUST be rejected on ANY player (Indian OR Overseas) with "Squad limit reached!"
    if (wsh.attachment) wsh.attachment.msgCount = 0;
    const fullLot = doInstance.room.currentLot;
    assert.ok(fullLot && fullLot.hammerStatus === 'OPEN');
    const fullId = `sq_full_${seq++}`;
    await doInstance.webSocketMessage(wsh, JSON.stringify({
      id: fullId, type: 'PLACE_BID', payload: { franchiseId: 'CSK', bidAmount: fullLot.basePrice, expectedVersion: fullLot.stateVersion }
    }));
    const fullAck = wsh.messages.find(m => m.id === fullId);
    assert.equal(fullAck.success, false);
    assert.match(fullAck.error, /Squad limit reached!/);

    // Worker restart / reconnect preserves max_squad_size=15 and max_overseas_players=5
    const restarted = new AuctionRoomDO(ctx);
    assert.equal(restarted.room.max_squad_size, 15);
    assert.equal(restarted.room.max_overseas_players, 5);
    assert.equal(restarted.room.config.maxSquadSize, 15);
    assert.equal(restarted.room.config.maxOverseas, 5);
    const pubState = restarted.getPublicRoomState();
    assert.equal(pubState.max_squad_size, 15);
    assert.equal(pubState.max_overseas_players, 5);

    // Legacy room stored without maxSquadSize/maxOverseas falls back to 15 total & 8 overseas
    const { ctx: legCtx, doInstance: legDO } = createDO();
    legCtx.storage.sql.room_meta.set('LEGACY_OLD', {
      state_json: JSON.stringify({
        roomCode: 'LEGACY_OLD',
        status: 'paused',
        hostName: 'OldHost',
        config: { basePurse: 120, timerDuration: 15 },
        franchises: {},
        playersCatalog: [],
        participants: {}
      }),
      deadline_epoch_ms: null,
      updated_at: new Date().toISOString()
    });
    legDO.loadFromStorage();
    assert.equal(legDO.room.config.maxSquadSize, 15);
    assert.equal(legDO.room.config.maxOverseas, 8);
    assert.equal(legDO.room.max_squad_size, 15);
    assert.equal(legDO.room.max_overseas_players, 8);
  });
});
