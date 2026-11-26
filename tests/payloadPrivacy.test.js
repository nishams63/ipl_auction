// Public/private data audit: every REST response, every server→client socket event and every
// ack in a full auction lifecycle is captured and deep-scanned for private data.
import assert from 'node:assert';
import {
  startServer, connect, emit, waitFor, createRoom, makeRunner, strongToken, sleep, findPrivateData
} from './helpers/harness.js';

const t = makeRunner('Public/Private Payload Audit (full lifecycle)');
const srv = await startServer();

const H = strongToken('host'); const A = strongToken('alice'); const X = strongToken('outsider');
const FORBIDDEN_KEYS = ['ownerToken', 'ownerSocketId', 'hostToken', 'participantToken', 'token', 'socketId', 'participants', 'isSkippingSet'];
const captured = []; // { source, name, payload }
const rest = async (label, path, init) => {
  const r = await fetch(`${srv.url}${path}`, init);
  const body = await r.json();
  captured.push({ source: 'REST', name: label, payload: body });
  return { status: r.status, body };
};
const record = (sock, who) => sock.onAny((event, payload) => captured.push({ source: `event→${who}`, name: event, payload }));
const ack = async (who, sock, event, payload) => {
  const res = await emit(sock, event, payload);
  captured.push({ source: `ack→${who}`, name: event, payload: res });
  return res;
};

try {
  // Lobby
  const { body } = await createRoom(srv.url, { hostName: 'Host', hostToken: H, config: { minParticipants: 2, autoAdvanceDelay: 30 } });
  captured.push({ source: 'REST', name: 'POST /api/rooms', payload: body });
  const code = body.roomCode;
  const host = await connect(srv.url); record(host, 'host');
  let alice = await connect(srv.url); record(alice, 'alice');
  const outsider = await connect(srv.url); record(outsider, 'outsider');
  const aliceFirstSocketId = alice.id;

  await ack('host', host, 'join_room', { roomCode: code, participantName: 'Host', participantToken: H });
  await ack('alice', alice, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await ack('host', host, 'select_franchise', { roomCode: code, franchiseId: 'CSK' });
  await ack('alice', alice, 'select_franchise', { roomCode: code, franchiseId: 'RR' });
  await ack('alice', alice, 'select_franchise', { roomCode: code, franchiseId: 'MI' }); // releases RR
  await ack('host', host, 'update_config', { roomCode: code, config: { autoAdvanceDelay: 5 } });
  await ack('host', host, 'update_config', { roomCode: code, config: { basePurse: 1 } }); // error ack
  await ack('outsider', outsider, 'start_auction', { roomCode: code, hostToken: H }); // error ack
  await rest('GET /api/rooms/:code (lobby)', `/api/rooms/${code}`);

  // Live auction
  const lp = waitFor(alice, 'lot_presented');
  await ack('host', host, 'start_auction', { roomCode: code });
  let lot = (await lp).currentLot;
  await ack('alice', alice, 'place_bid', { roomCode: code, franchiseId: 'MI', bidAmount: lot.nextValidBid, expectedVersion: lot.stateVersion });
  const pub1 = (await rest('GET /api/rooms/:code (live)', `/api/rooms/${code}`)).body;
  await ack('host', host, 'place_bid', { roomCode: code, franchiseId: 'CSK', bidAmount: pub1.currentLot.nextValidBid, expectedVersion: pub1.currentLot.stateVersion });
  await ack('host', host, 'place_bid', { roomCode: code, franchiseId: 'CSK', expectedVersion: 1 }); // stale error ack
  await waitFor(alice, 'timer_tick');
  await ack('host', host, 'pause_auction', { roomCode: code });
  await ack('host', host, 'resume_auction', { roomCode: code });
  const sold = waitFor(alice, 'lot_completed');
  await ack('host', host, 'advance_lot', { roomCode: code }); // SOLD
  await sold;
  await ack('alice', alice, 'update_playing_xi', { roomCode: code, franchiseId: 'MI', playingXI: [] });
  await ack('alice', alice, 'update_playing_xi', { roomCode: code, franchiseId: 'CSK', playingXI: [] }); // error ack
  const next = waitFor(alice, 'lot_presented');
  await ack('host', host, 'advance_lot', { roomCode: code }); // next lot
  await next;
  const unsold = waitFor(alice, 'lot_completed', d => d.result === 'UNSOLD');
  await ack('host', host, 'advance_lot', { roomCode: code }); // UNSOLD (no bids)
  await unsold;
  await ack('host', host, 'advance_lot', { roomCode: code });
  const skipped = waitFor(alice, 'set_skipped');
  await ack('host', host, 'skip_set', { roomCode: code });
  await skipped;

  // Session takeover (new socket for Alice) → session_replaced to the old socket
  const replaced = waitFor(alice, 'session_replaced');
  const alice2 = await connect(srv.url); record(alice2, 'alice2');
  await ack('alice2', alice2, 'join_room', { roomCode: code, participantName: 'Alice', participantToken: A });
  await replaced;
  await ack('alice-old', alice, 'place_bid', { roomCode: code, franchiseId: 'MI' }); // error ack
  alice = alice2;

  // Completion
  const done = waitFor(alice, 'auction_completed');
  await ack('host', host, 'finish_auction', { roomCode: code });
  await done;
  await rest('GET /api/rooms/:code (completed)', `/api/rooms/${code}`);
  await rest('GET /api/health', '/api/health');
  await rest('GET /api/franchises', '/api/franchises');
  await rest('POST /api/rooms (invalid)', '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostName: 'Z', hostToken: X, config: { timerDuration: 1 } }) });
  await sleep(200);

  const socketIds = [host.id, alice2.id, outsider.id, aliceFirstSocketId].filter(Boolean);
  const secrets = [H, A, X, ...socketIds];

  await t.it('every server→client event type was exercised', () => {
    const seen = new Set(captured.filter(c => c.source.startsWith('event')).map(c => c.name));
    for (const ev of ['state_updated', 'lot_presented', 'bid_accepted', 'timer_tick', 'lot_completed', 'set_skipped', 'auction_completed', 'session_replaced']) {
      assert.ok(seen.has(ev), `never received ${ev}`);
    }
  });

  await t.it('every ack type was exercised (success and error paths)', () => {
    const seen = new Set(captured.filter(c => c.source.startsWith('ack')).map(c => c.name));
    for (const ev of ['join_room', 'select_franchise', 'update_config', 'start_auction', 'place_bid', 'pause_auction', 'resume_auction', 'advance_lot', 'update_playing_xi', 'skip_set', 'finish_auction']) {
      assert.ok(seen.has(ev), `never exercised ack for ${ev}`);
    }
    assert.ok(captured.some(c => c.source.startsWith('ack') && c.payload?.success === false), 'no error acks captured');
  });

  await t.it(`no payload (${captured.length} captured) contains a token, socket id or private field`, () => {
    const problems = [];
    for (const c of captured) {
      for (const hit of findPrivateData(c.payload, { secrets, forbiddenKeys: FORBIDDEN_KEYS })) {
        problems.push(`${c.source} ${c.name}: ${hit}`);
      }
    }
    assert.deepStrictEqual(problems, [], problems.slice(0, 10).join('\n'));
  });

  await t.it('nested objects are covered (franchises, squads, lots, bid history, history, evaluation)', () => {
    const final = captured.filter(c => c.name === 'auction_completed').at(-1).payload;
    assert.ok(final.franchises.CSK.squad.length >= 1, 'squad present to scan'); // host's outbid wins lot 1
    assert.ok(final.history.length >= 3, 'history present to scan');
    assert.ok(final.evaluationResults.rankings.length === 2, 'evaluation present to scan');
    assert.ok(final.recentBids.length >= 2, 'bids present to scan');
    assert.strictEqual(final.franchises.MI.ownerId?.startsWith('p_'), true, 'ownership uses public id');
  });
} finally {
  await srv.stop();
}

const failed = await t.finish();
process.exit(failed ? 1 : 0);
