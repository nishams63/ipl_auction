// UNIT TESTS (no database): room object <-> normalized rows mapping.
// The database is simulated only by converting values the way pg returns them (numeric as
// strings, timestamptz as Date, jsonb re-parsed). Real database behaviour is covered by the
// pg*.test.js integration suites.
import assert from 'node:assert';
import { makeRunner, trackManager, mockIo, tempStorageFile, strongToken } from './helpers/harness.js';
import { richRoom, lobbyRoom, normalizeRoom } from './helpers/auctionRooms.js';

const { RoomManager } = await import('../server/roomManager.js');
const { roomToRows, rowsToRoom, MappingError, TABLES, fingerprint, stableStringify } = await import('../server/persistence/roomMapper.js');
const { hashToken, hashKeyOf, isHashKey, tokenHashScheme } = await import('../server/persistence/tokenHash.js');
const { isValidToken } = await import('../server/security.js');

const t = makeRunner('PostgreSQL Mapper Suite — UNIT (no database; pg value types simulated)');
const make = () => trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('map') }));

const NUMERIC = new Set(['initial_purse', 'remaining_purse', 'total_spent', 'sold_price', 'bought_price', 'amount', 'final_bid']);
const TIMESTAMP = new Set(['created_at', 'confirmed_at', 'placed_at', 'completed_at', 'logged_at']);
// What a SELECT would return for rows written from roomToRows output
function asDbRows(rows) {
  const conv = (table, row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) out[k] = null;
      else if (TABLES[table].json.includes(k)) out[k] = JSON.parse(JSON.stringify(v));
      else if (NUMERIC.has(k)) out[k] = String(v);
      else if (TIMESTAMP.has(k)) out[k] = new Date(v);
      else out[k] = v;
    }
    return out;
  };
  const d = { room: conv('rooms', rows.room) };
  for (const tbl of ['franchises', 'participants', 'room_players', 'squad_entries', 'bids', 'lot_results', 'audit_logs']) {
    d[tbl] = rows[tbl].map(r => conv(tbl, r));
  }
  d.lineups = rows.lineups.map(l => conv('lineups', l.row));
  d.lineup_players = rows.lineups.flatMap(l => l.players.map(p => conv('lineup_players', p)));
  return d;
}
const roundTrip = room => rowsToRoom(asDbRows(roomToRows(room)));

await t.it('M1: a rich mid-auction room survives the round trip exactly (documented normalizations only)', () => {
  const rm = make();
  const { room } = richRoom(rm);
  assert.ok(room.history.some(h => h.status === 'SOLD') && room.history.some(h => h.status === 'UNSOLD') && room.history.some(h => h.status === 'SKIPPED'));
  assert.ok(room.currentLot.bidHistory.length === 2 && room.franchises.MI.playingXI.length > 0);
  const restored = roundTrip(room);
  assert.deepStrictEqual(normalizeRoom(restored), normalizeRoom(room));
});

await t.it('M2: restored objects are linked like live ones (lot player, history players and lot bids are shared objects)', () => {
  const rm = make();
  const { room } = richRoom(rm);
  const r = roundTrip(room);
  const byId = new Map(r.playersCatalog.map(p => [p.id, p]));
  assert.strictEqual(r.currentLot.player, byId.get(r.currentLot.player.id), 'lot player is not the catalogue object');
  for (const h of r.history) assert.strictEqual(h.player, byId.get(h.player.id), 'history player is not the catalogue object');
  for (const b of r.currentLot.bidHistory) assert.ok(r.allBids.includes(b), 'lot bid is not the bid-log object');
});

await t.it('M3: rows never contain a raw session token or a socket id', () => {
  const rm = make();
  const { room, H, A } = richRoom(rm);
  const dump = JSON.stringify(roomToRows(room));
  for (const secret of [H, A, 'sock-host-1', 'sock-alice-1']) assert.ok(!dump.includes(secret), `rows contain ${secret.slice(0, 12)}…`);
  assert.ok(dump.includes(hashToken(H)), 'host token hash missing');
});

await t.it('M4: absent fields stay absent, verbatim legacy values are preserved, unknown fields are kept', () => {
  const rm = make();
  const { room } = lobbyRoom(rm);
  // franchises created in the lobby have no isConfirmed field: it must not appear after restore
  assert.ok(!('isConfirmed' in room.franchises.RR));
  room.legacyField = { nested: [1, 'two'] };                 // unknown room field
  room.franchises.RR.oldSponsor = 'Acme';                    // unknown franchise field
  room.createdAt = '15/11/2024 10:00';                        // non-canonical timestamp
  room.auditLog[0].timestamp = 'yesterday';
  room.auditLog[0].extraNote = 42;
  room.hostName = 12345;                                      // wrong-typed optional value
  room.playersCatalog[3].soldPrice = 'n/a';                  // wrong-typed optional value
  delete room.playersCatalog[4].soldTo;                       // absent optional
  const r = roundTrip(room);
  assert.ok(!('isConfirmed' in r.franchises.RR), 'absent isConfirmed re-created');
  assert.ok(!('soldTo' in r.playersCatalog[4]), 'absent soldTo re-created');
  assert.deepStrictEqual(r.legacyField, { nested: [1, 'two'] });
  assert.strictEqual(r.franchises.RR.oldSponsor, 'Acme');
  assert.strictEqual(r.createdAt, '15/11/2024 10:00');
  assert.strictEqual(r.auditLog[0].timestamp, 'yesterday');
  assert.strictEqual(r.auditLog[0].extraNote, 42);
  assert.strictEqual(r.hostName, 12345);
  assert.strictEqual(r.playersCatalog[3].soldPrice, 'n/a');
  assert.deepStrictEqual(normalizeRoom(r), normalizeRoom(room));
});

await t.it('M5: a legacy squad entry that differs from its catalogue entry is preserved via overrides', () => {
  const rm = make();
  const { room } = richRoom(rm);
  const rows = roomToRows(room);
  assert.ok(rows.squad_entries.every(s => Object.keys(s.overrides).length === 0), 'live squad entries need no overrides');
  room.franchises.CSK.squad[0].legacyNote = 'retained';
  delete room.franchises.CSK.squad[1].rating;
  const r = roundTrip(room);
  assert.strictEqual(r.franchises.CSK.squad[0].legacyNote, 'retained');
  assert.ok(!('rating' in r.franchises.CSK.squad[1]));
  assert.deepStrictEqual(normalizeRoom(r), normalizeRoom(room));
});

await t.it('M6: data that cannot be stored faithfully is refused (MappingError), never coerced', () => {
  const cases = {
    'player in two squads (double sale)': r => { r.franchises.MI.squad.push({ ...r.franchises.CSK.squad[0] }); },
    'player twice in one squad': r => { r.franchises.CSK.squad.push({ ...r.franchises.CSK.squad[0] }); },
    'two results for one player': r => { r.history.push({ ...r.history[0] }); },
    'squad player not in catalogue': r => { r.franchises.CSK.squad.push({ id: 'PL_GHOST', boughtPrice: 1 }); },
    'duplicate catalogue id': r => { r.playersCatalog.push({ ...r.playersCatalog[0] }); },
    'non-numeric bid amount': r => { r.allBids[0].bidAmount = '2.5'; },
    'missing purse': r => { delete r.franchises.RR.remainingPurse; },
    'lineup with 12 players': r => { r.franchises.CSK.playingXI = Array.from({ length: 12 }, (_, i) => `X${i}`); },
    'invalid room code': r => { r.roomCode = 'bad code'; }
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const rm = make();
    const { room } = richRoom(rm);
    mutate(room);
    assert.throws(() => roomToRows(room), MappingError, `not refused: ${label}`);
  }
});

await t.it('M7: mapping is stable — a restored room maps to identical rows (no spurious rewrites)', () => {
  const rm = make();
  const { room } = richRoom(rm);
  const rows1 = roomToRows(room);
  const rows2 = roomToRows(roundTrip(room));
  for (const tbl of ['franchises', 'participants', 'room_players', 'squad_entries', 'bids', 'lot_results', 'audit_logs', 'lineups']) {
    assert.deepStrictEqual(rows2[tbl].map(fingerprint), rows1[tbl].map(fingerprint), `${tbl} rows differ after a round trip`);
  }
  assert.strictEqual(fingerprint(rows2.room), fingerprint(rows1.room));
});

await t.it('M8: token hashing — deterministic, scheme-dependent, and hash keys can never be presented as tokens', () => {
  const tok = strongToken('x');
  assert.match(hashToken(tok), /^[0-9a-f]{64}$/);
  assert.strictEqual(hashToken(tok), hashToken(tok));
  const peppered = hashToken(tok, { TOKEN_HASH_SECRET: 's3cret' });
  assert.notStrictEqual(peppered, hashToken(tok));
  assert.strictEqual(tokenHashScheme({}), 'sha256-v1');
  assert.strictEqual(tokenHashScheme({ TOKEN_HASH_SECRET: 'x' }), 'hmac-sha256-v1');
  const key = hashKeyOf(tok);
  assert.ok(isHashKey(key) && hashKeyOf(key) === key, 'hash key must map to itself');
  assert.strictEqual(isValidToken(key), false, 'a hash key must never pass token validation');
  // legacy-format tokens hash like any other
  assert.match(hashToken('usr_1731740000000_h0st01'), /^[0-9a-f]{64}$/);
});

await t.it('M9: audit entries carry a unique, increasing seq; memory keeps 200, rows keep what memory has', () => {
  const rm = make();
  const { room, code, H } = lobbyRoom(rm);
  for (let i = 0; i < 230; i++) rm.updateConfig({ roomCode: code, hostToken: H, newConfig: { autoAdvanceDelay: 2 + (i % 5) } });
  assert.strictEqual(room.auditLog.length, 200);
  const seqs = room.auditLog.map(a => a.seq);
  assert.strictEqual(new Set(seqs).size, 200);
  assert.ok(seqs.every((s, i) => i === 0 || s < seqs[i - 1]), 'newest first, strictly decreasing seq');
  assert.strictEqual(room.auditSeq, seqs[0]);
  assert.ok(room.auditSeq > 230);
});

await t.it('M10: stableStringify ignores key order but not values', () => {
  assert.strictEqual(stableStringify({ a: 1, b: { c: 2, d: [1, { e: 3 }] } }), stableStringify({ b: { d: [1, { e: 3 }], c: 2 }, a: 1 }));
  assert.notStrictEqual(stableStringify({ a: 1 }), stableStringify({ a: '1' }));
});

process.exit(await t.finish());
