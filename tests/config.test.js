// Shared configuration validator: room creation and lobby updates.
import assert from 'node:assert';
import {
  startServer, connect, emit, createRoom, makeRunner, strongToken, tempStorageFile, trackManager, mockIo
} from './helpers/harness.js';

process.env.ROOM_STORAGE_FILE = process.env.ROOM_STORAGE_FILE || tempStorageFile('config-unit');
const { validateConfig, DEFAULT_CONFIG, ConfigValidationError } = await import('../server/config.js');
const { RoomManager } = await import('../server/roomManager.js');

const t = makeRunner('Configuration Validation Suite');

// Each entry: [label, change] that must be rejected
const INVALID = [
  ['purse below 20', { basePurse: 10 }],
  ['purse above 250', { basePurse: 500 }],
  ['purse 3 decimals', { basePurse: 100.125 }],
  ['purse non-numeric', { basePurse: 'lots' }],
  ['purse boolean', { basePurse: true }],
  ['purse empty string', { basePurse: '' }],
  ['purse NaN', { basePurse: NaN }],
  ['min squad below 5', { minSquadSize: 1 }],
  ['min squad fractional', { minSquadSize: 15.5 }],
  ['max squad above 30', { maxSquadSize: 40 }],
  ['min > max squad', { minSquadSize: 25, maxSquadSize: 20 }],
  ['overseas below 4', { maxOverseas: 2 }],
  ['overseas above 10', { maxOverseas: 11 }],
  ['participants 0', { minParticipants: 0 }],
  ['participants 11', { minParticipants: 11 }],
  ['timer 5s', { timerDuration: 5 }],
  ['timer 200s', { timerDuration: 200 }],
  ['timer fractional', { timerDuration: 12.5 }],
  ['min player price 0', { minPlayerPrice: 0 }],
  ['min player price 5', { minPlayerPrice: 5 }],
  ['auto-advance 0', { autoAdvanceDelay: 0 }],
  ['auto-advance 120', { autoAdvanceDelay: 120 }],
  ['purse cannot cover min squad', { basePurse: 20, minSquadSize: 25, minPlayerPrice: 1 }],
  ['unknown key', { godMode: 1 }],
  ['change maxFranchises', { maxFranchises: 12 }],
  ['object value', { timerDuration: { $gt: 1 } }],
  // Stage 2: fixed IPL rules cannot be changed
  ['purse 150 (fixed 120)', { basePurse: 150 }],
  ['purse 100 (fixed 120)', { basePurse: 100 }],
  ['min squad 18 (fixed 15)', { minSquadSize: 18 }],
  ['max squad 22 (fixed 25)', { maxSquadSize: 22 }],
  ['overseas 6 (fixed 8)', { maxOverseas: 6 }],
  ['min keepers 0 (fixed 1)', { minWKs: 0 }]
];

await t.it('defaults are the approved values and pass validation', () => {
  assert.strictEqual(DEFAULT_CONFIG.basePurse, 120);
  assert.strictEqual(DEFAULT_CONFIG.minSquadSize, 15);
  assert.strictEqual(DEFAULT_CONFIG.maxSquadSize, 25);
  assert.strictEqual(DEFAULT_CONFIG.maxOverseas, 8);
  assert.strictEqual(DEFAULT_CONFIG.timerDuration, 20);
  assert.ok(validateConfig({}).ok);
  assert.throws(() => { DEFAULT_CONFIG.basePurse = 1; }, TypeError, 'defaults are mutable');
});

await t.it('validator rejects every invalid value and combination (nothing silently dropped)', () => {
  for (const [label, change] of INVALID) {
    const r = validateConfig(change);
    assert.strictEqual(r.ok, false, `accepted: ${label}`);
    assert.ok(r.errors.length > 0, `no error message: ${label}`);
  }
  assert.strictEqual(validateConfig('x').ok, false);
  assert.strictEqual(validateConfig([1]).ok, false);
});

await t.it('validator accepts the fixed IPL rule values and every adjustable value; fixed rules reject anything else', async () => {
  const { FIXED_RULES } = await import('../server/config.js');
  assert.deepStrictEqual({ ...FIXED_RULES }, { basePurse: 120, minSquadSize: 15, maxSquadSize: 25, maxOverseas: 8, minWKs: 1 });
  assert.ok(validateConfig({ ...FIXED_RULES }).ok, 'the fixed values themselves must be accepted (older clients send them)');
  assert.ok(validateConfig({ timerDuration: 10 }).ok);
  assert.ok(validateConfig({ timerDuration: 90 }).ok);
  assert.ok(validateConfig({ basePurse: '120', timerDuration: '30' }).ok, 'numeric strings from inputs');
  for (const [key, value] of Object.entries(FIXED_RULES)) {
    for (const other of [value - 1, value + 1]) {
      const r = validateConfig({ [key]: other });
      assert.strictEqual(r.ok, false, `${key}=${other} accepted`);
      assert.ok(r.errors.some(e => /fixed at/.test(e)) || r.errors.length > 0, `${key}: no reason`);
    }
  }
});

await t.it('exact boundaries for every rule: min and max accepted, one step outside rejected', async () => {
  const { CONFIG_RULES, FIXED_RULES } = await import('../server/config.js');
  const base = { ...DEFAULT_CONFIG };
  let probes = 0;
  const adjustable = Object.entries(CONFIG_RULES).filter(([key]) => !(key in FIXED_RULES));
  for (const [key, rule] of adjustable) {
    const step = rule.kind === 'int' ? 1 : 0.01;
    const below = Math.round((rule.min - step) * 100) / 100;
    const above = Math.round((rule.max + step) * 100) / 100;
    assert.ok(validateConfig({ [key]: rule.min }, base).ok, `${key}=${rule.min} (min) rejected: ${JSON.stringify(validateConfig({ [key]: rule.min }, base).errors)}`);
    assert.ok(validateConfig({ [key]: rule.max }, base).ok, `${key}=${rule.max} (max) rejected: ${JSON.stringify(validateConfig({ [key]: rule.max }, base).errors)}`);
    assert.strictEqual(validateConfig({ [key]: below }, base).ok, false, `${key}=${below} (below min) accepted`);
    assert.strictEqual(validateConfig({ [key]: above }, base).ok, false, `${key}=${above} (above max) accepted`);
    probes += 4;
  }
  assert.strictEqual(probes, adjustable.length * 4);
  assert.ok(probes >= 16, 'timer, delay, participants and floor price are still boundary-tested');
});

await t.it('approved defaults apply when a room is created without config, over REST and directly', async () => {
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('cfg-def') }));
  const room = rm.createRoom({ hostName: 'H', hostToken: strongToken('h') });
  const pick = c => [c.basePurse, c.minSquadSize, c.maxSquadSize, c.maxOverseas, c.timerDuration, c.minWKs];
  assert.deepStrictEqual(pick(room.config), [120, 15, 25, 8, 20, 1]);
  assert.strictEqual(room.franchises.MI.initialPurse, 120);
});

await t.it('RoomManager.createRoom throws on invalid config and creates nothing', () => {
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('cfg-rm') }));
  const before = rm.rooms.size;
  for (const [label, change] of INVALID) {
    assert.throws(() => rm.createRoom({ hostName: 'H', hostToken: strongToken('h'), configOverrides: change }),
      ConfigValidationError, `accepted at creation: ${label}`);
  }
  assert.strictEqual(rm.rooms.size, before, 'a room was created');
});

await t.it('RoomManager.updateConfig rejects invalid changes and leaves config untouched', () => {
  const rm = trackManager(new RoomManager(mockIo(), { storageFile: tempStorageFile('cfg-up') }));
  const H = strongToken('h');
  const room = rm.createRoom({ hostName: 'H', hostToken: H });
  const snapshot = JSON.stringify(room.config);
  for (const [label, change] of INVALID) {
    const r = rm.updateConfig({ roomCode: room.roomCode, hostToken: H, newConfig: change });
    assert.strictEqual(r.success, false, `accepted in lobby: ${label}`);
    assert.strictEqual(JSON.stringify(room.config), snapshot, `config mutated by: ${label}`);
  }
  // Partial update that is only invalid in combination with the CURRENT config
  assert.strictEqual(rm.updateConfig({ roomCode: room.roomCode, hostToken: H, newConfig: { minSquadSize: 25, maxSquadSize: 20 } }).success, false);
  assert.strictEqual(rm.updateConfig({ roomCode: room.roomCode, hostToken: H, newConfig: { maxSquadSize: 15, minSquadSize: 20 } }).success, false);
  // Valid change still works; the purse stays the fixed ₹120 Cr
  assert.ok(rm.updateConfig({ roomCode: room.roomCode, hostToken: H, newConfig: { basePurse: 120, timerDuration: 30 } }).success);
  assert.strictEqual(room.config.timerDuration, 30);
  assert.strictEqual(room.config.basePurse, 120);
  assert.strictEqual(room.franchises.CSK.initialPurse, 120);
});

// Over the wire
const srv = await startServer();
await t.it('POST /api/rooms with invalid config → 400 with reasons, valid config → 200', async () => {
  for (const [label, change] of INVALID) {
    const r = await createRoom(srv.url, { hostToken: strongToken('h'), config: change });
    assert.strictEqual(r.status, 400, `accepted at creation over REST: ${label}`);
    assert.ok(Array.isArray(r.body.errors) && r.body.errors.length, `no reasons: ${label}`);
  }
  const ok = await createRoom(srv.url, { hostToken: strongToken('h'), config: { basePurse: 120, timerDuration: 25 } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.room.config.basePurse, 120);
  assert.strictEqual(ok.body.room.config.timerDuration, 25);
});

await t.it('update_config over socket rejects invalid values with reasons; config unchanged', async () => {
  const H = strongToken('sh');
  const { body } = await createRoom(srv.url, { hostToken: H });
  const s = await connect(srv.url);
  await emit(s, 'join_room', { roomCode: body.roomCode, participantName: 'Host', participantToken: H });
  for (const [label, change] of INVALID) {
    const r = await emit(s, 'update_config', { roomCode: body.roomCode, config: change });
    assert.strictEqual(r.success, false, `accepted over socket: ${label}`);
    assert.ok(r.errors?.length, `no reasons over socket: ${label}`);
  }
  const pub = await (await fetch(`${srv.url}/api/rooms/${body.roomCode}`)).json();
  assert.deepStrictEqual(
    { p: pub.config.basePurse, min: pub.config.minSquadSize, max: pub.config.maxSquadSize, o: pub.config.maxOverseas, t: pub.config.timerDuration },
    { p: 120, min: 15, max: 25, o: 8, t: 20 });
  // The payload an older LobbyView sends (all five fields, fixed values) and the current one (timer only)
  const old = await emit(s, 'update_config', { roomCode: body.roomCode, config: { basePurse: 120, timerDuration: 30, minSquadSize: 15, maxSquadSize: 25, maxOverseas: 8 } });
  assert.ok(old.success, old.error);
  const cur = await emit(s, 'update_config', { roomCode: body.roomCode, config: { timerDuration: 35 } });
  assert.ok(cur.success, cur.error);
  const changed = await emit(s, 'update_config', { roomCode: body.roomCode, config: { basePurse: 100 } });
  assert.strictEqual(changed.success, false);
  assert.match(changed.error, /fixed at 120/);
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
