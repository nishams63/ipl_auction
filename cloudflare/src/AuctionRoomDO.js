import playersRaw from '../../server/data/playersData.js';
import { IPL_FRANCHISES } from '../../server/data/franchises.js';
import {
  DEFAULT_CONFIG,
  calculateNextBid,
  validateBid,
  isLotOpen,
  checkFinancialElimination,
  reserveFloorLakh
} from '../../server/auctionEngine.js';
import { validateConfig, getRoomSquadLimits } from '../../server/config.js';
import { toLakh, fromLakh } from '../../server/money.js';
import { evaluateAuction } from '../../server/analysis/evaluation.js';
import {
  hashToken,
  tokenHashVerifier,
  tokenHashSecretProblem,
  isHashKey
} from '../../server/persistence/tokenHash.js';
import { cleanName, isValidToken } from '../../server/security.js';
import {
  FINAL_PLAYER_STATUSES,
  PLAYING_XI_FORBIDDEN,
  validateAndBuildPlayingXI,
  appendAuditEntry,
  shuffleWithinSets,
  applyFixedRulesToLobbyRoom
} from '../../server/roomRules.js';

const MAX_PARTICIPANTS = 30; // 10 franchise owners + spectators; bounds per-room state

export class AuctionRoomDO {
  constructor(ctx, env = {}) {
    this.ctx = ctx;
    this.env = env || {};
    this.room = null;
    this._closingLotNumber = null;
    this.initSql();
    this.loadFromStorage();
  }

  isProduction() {
    return this.env?.ENVIRONMENT === 'production' || this.env?.NODE_ENV === 'production';
  }

  getAuthConfigError() {
    const problem = tokenHashSecretProblem(this.env);
    if (problem) return 'Server authentication secret configuration is invalid';
    if (this.isProduction() && !this.env?.TOKEN_HASH_SECRET) {
      return 'Server authentication secret is not configured';
    }
    return null;
  }

  verifyRoomTokenSecret() {
    if (!this.room?.tokenHashVerifier) return true;
    return this.room.tokenHashVerifier === tokenHashVerifier(this.env);
  }

  // Raw private tokens are never kept in room state or storage: only their (HMAC) hashes.
  // Converts rooms written by older builds (raw hostToken / rawToken / ownerToken) in place.
  normalizeSecrets() {
    const r = this.room;
    if (!r) return;
    if (typeof r.hostToken === 'string' && r.hostToken) {
      r.hostTokenHash = hashToken(r.hostToken, this.env);
    }
    delete r.hostToken;
    for (const f of Object.values(r.franchises || {})) {
      if (typeof f.ownerToken === 'string' && f.ownerToken && !f.ownerTokenHash) {
        f.ownerTokenHash = hashToken(f.ownerToken, this.env);
      }
      delete f.ownerToken;
      if (f.ownerTokenHash === undefined) f.ownerTokenHash = null;
    }
    const parts = r.participants instanceof Map ? r.participants.values() : Object.values(r.participants || {});
    for (const p of parts) {
      delete p.rawToken;
    }
  }

  isHostHash(tokenHash) {
    return !!tokenHash && !!this.room?.hostTokenHash && tokenHash === this.room.hostTokenHash;
  }

  initSql() {
    if (!this.ctx.storage?.sql) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        room_code TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        deadline_epoch_ms INTEGER,
        updated_at TEXT NOT NULL,
        max_squad_size INTEGER NOT NULL DEFAULT 15,
        max_overseas_players INTEGER NOT NULL DEFAULT 8
      );
      CREATE TABLE IF NOT EXISTS bids (
        bid_id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        lot_number INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        franchise_id TEXT NOT NULL,
        amount_cr REAL NOT NULL,
        state_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lot_results (
        room_code TEXT NOT NULL,
        lot_number INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        status TEXT NOT NULL,
        final_bid_cr REAL NOT NULL,
        winning_franchise_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (room_code, lot_number)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_messages (
        room_code TEXT NOT NULL,
        participant_token_hash TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ack_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (room_code, participant_token_hash, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_processed_messages_created ON processed_messages (created_at);
    `);
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE room_meta ADD COLUMN max_squad_size INTEGER NOT NULL DEFAULT 15`);
    } catch {}
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE room_meta ADD COLUMN max_overseas_players INTEGER NOT NULL DEFAULT 8`);
    } catch {}
  }

  normalizeRoomLimits(rowMaxSquad = null, rowMaxOverseas = null) {
    if (!this.room) return;
    if (!this.room.config || typeof this.room.config !== 'object') {
      this.room.config = {};
    }
    const maxSquadSize = this.room.config.maxSquadSize
      ?? this.room.config.max_squad_size
      ?? this.room.max_squad_size
      ?? rowMaxSquad
      ?? 15;
    const maxOverseas = this.room.config.maxOverseas
      ?? this.room.config.max_overseas_players
      ?? this.room.max_overseas_players
      ?? rowMaxOverseas
      ?? 8;
    this.room.config.maxSquadSize = maxSquadSize;
    this.room.config.maxOverseas = maxOverseas;
    this.room.max_squad_size = maxSquadSize;
    this.room.max_overseas_players = maxOverseas;
  }

  loadFromStorage() {
    if (!this.ctx.storage?.sql) return;
    try {
      let cursor;
      try {
        cursor = this.ctx.storage.sql.exec(`SELECT state_json, deadline_epoch_ms, max_squad_size, max_overseas_players FROM room_meta LIMIT 1`);
      } catch {
        cursor = this.ctx.storage.sql.exec(`SELECT state_json, deadline_epoch_ms FROM room_meta LIMIT 1`);
      }
      for (const row of cursor) {
        if (row.state_json) {
          this.room = JSON.parse(row.state_json);
          this.room.participants = new Map(Object.entries(this.room.participants || {}));
          this.normalizeSecrets();
          this.normalizeRoomLimits(row.max_squad_size ?? null, row.max_overseas_players ?? null);
          if (row.deadline_epoch_ms !== undefined && row.deadline_epoch_ms !== null) {
            this.room.deadlineEpochMs = row.deadline_epoch_ms;
            if (this.room.currentLot) {
              this.room.currentLot.deadlineEpochMs = row.deadline_epoch_ms;
            }
          }
        }
      }
    } catch (err) {
      console.error('[DO load error]');
    }
  }

  writeRoomMetaSql() {
    if (!this.ctx.storage?.sql || !this.room) return;
    this.normalizeSecrets();
    this.normalizeRoomLimits();
    const { maxSquadSize, maxOverseas } = getRoomSquadLimits(this.room);
    const copy = { ...this.room };
    copy.participants = Object.fromEntries(this.room.participants.entries());
    const stateJson = JSON.stringify(copy);
    const deadline = this.room.deadlineEpochMs || null;
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO room_meta (room_code, state_json, deadline_epoch_ms, updated_at, max_squad_size, max_overseas_players)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_code) DO UPDATE SET
         state_json = excluded.state_json,
         deadline_epoch_ms = excluded.deadline_epoch_ms,
         updated_at = excluded.updated_at,
         max_squad_size = excluded.max_squad_size,
         max_overseas_players = excluded.max_overseas_players`,
      this.room.roomCode,
      stateJson,
      deadline,
      now,
      maxSquadSize,
      maxOverseas
    );
  }

  saveToStorage() {
    if (!this.ctx.storage?.sql || !this.room) return;
    try {
      this.writeRoomMetaSql();
    } catch (err) {
      console.error('[DO save error]');
      throw err;
    }
  }

  cloneRoomStateForRollback() {
    if (!this.room) return null;
    const raw = { ...this.room };
    raw.participants = Object.fromEntries(this.room.participants.entries());
    const cloned = JSON.parse(JSON.stringify(raw));
    cloned.participants = new Map(Object.entries(cloned.participants || {}));
    return cloned;
  }

  restoreRoomStateSnapshot(snapshot) {
    if (!snapshot) return;
    this.room = snapshot;
    if (!(this.room.participants instanceof Map)) {
      this.room.participants = new Map(Object.entries(this.room.participants || {}));
    }
  }

  async safeDeleteAlarm() {
    if (!this.ctx.storage?.deleteAlarm) return;
    try {
      await this.ctx.storage.deleteAlarm();
    } catch (err) {
      console.error('[DO deleteAlarm warning]');
    }
  }

  async safeSetAlarm(epochMs) {
    if (!this.ctx.storage?.setAlarm || !epochMs) return;
    try {
      await this.ctx.storage.setAlarm(epochMs);
    } catch (err) {
      console.error('[DO setAlarm warning]');
    }
  }

  async enterStorageFailureHold(operation, _err, extra = {}) {
    if (!this.room) {
      return {
        ok: false,
        code: 'STORAGE_UNAVAILABLE',
        error: 'Storage temporarily unavailable; operation was not saved.'
      };
    }

    const activeDeadline = this.room.deadlineEpochMs || this.room.currentLot?.deadlineEpochMs || null;
    const rem = this.room.currentLot && isLotOpen(this.room.currentLot)
      ? Math.max(0, Math.ceil(((activeDeadline || 0) - Date.now()) / 1000))
      : (this.room.remainingSecondsOnPause ?? 0);

    if (this.room.status === 'active' || this.room.status === 'paused') {
      this.room.status = 'paused';
      this.room.remainingSecondsOnPause = rem;
    }
    this.room.deadlineEpochMs = null;
    if (this.room.currentLot) {
      this.room.currentLot.deadlineEpochMs = null;
      this.room.currentLot.countdown = rem;
    }
    this.room.storageFailure = {
      code: 'STORAGE_UNAVAILABLE',
      operation,
      message: 'Durable storage write failed. Auction has been safely paused with no sale announced; retry or resume once storage recovers.',
      failedAt: new Date().toISOString(),
      ...extra
    };
    this.addAuditLog('STORAGE_FAILURE_HOLD', `Storage unavailable during ${operation}. Auction safely held (${this.room.status}).`);
    await this.safeDeleteAlarm();
    this.broadcast('STATE_UPDATED', this.getPublicRoomState());
    return {
      ok: false,
      code: 'STORAGE_UNAVAILABLE',
      error: 'Storage unavailable: could not persist auction state. Auction paused safely; retry once storage recovers.'
    };
  }

  // Restore or fire pending alarm after eviction / sleep recovery
  async ensureAlarmRestored() {
    if (!this.room || this.room.status !== 'active') return;
    const deadline = this.room.deadlineEpochMs || this.room.currentLot?.deadlineEpochMs;
    if (deadline && this.ctx.storage?.getAlarm && this.ctx.storage?.setAlarm) {
      const scheduled = await this.ctx.storage.getAlarm();
      const now = Date.now();
      if (!scheduled || scheduled !== deadline) {
        if (deadline > now) {
          await this.ctx.storage.setAlarm(deadline);
        } else {
          // Deadline elapsed while inactive; fire alarm immediately to resolve lot
          await this.alarm();
        }
      }
    }
  }

  // Persistent Message-ID Deduplication
  getCachedAck(roomCode, tokenHash, messageId) {
    if (!this.ctx.storage?.sql || !messageId) return null;
    try {
      const cursor = this.ctx.storage.sql.exec(
        `SELECT ack_json FROM processed_messages
         WHERE room_code = ? AND participant_token_hash = ? AND message_id = ? LIMIT 1`,
        roomCode,
        tokenHash || 'anon',
        messageId
      );
      for (const row of cursor) {
        if (row.ack_json) return JSON.parse(row.ack_json);
      }
    } catch (err) {
      console.error('[getCachedAck error]');
    }
    return null;
  }

  saveCachedAck(roomCode, tokenHash, messageId, ackMsg) {
    if (!this.ctx.storage?.sql || !messageId) return;
    try {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO processed_messages (room_code, participant_token_hash, message_id, ack_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (room_code, participant_token_hash, message_id) DO NOTHING`,
        roomCode,
        tokenHash || 'anon',
        messageId,
        JSON.stringify(ackMsg),
        now
      );
      // Prune messages older than 2 hours (7,200,000 ms)
      this.ctx.storage.sql.exec(
        `DELETE FROM processed_messages WHERE created_at < ?`,
        now - 7200000
      );
    } catch (err) {
      console.error('[saveCachedAck error]');
    }
  }

  // Full Room Snapshot for Backup & Portability (strictly scrubbed of private tokens)
  getExportSnapshot() {
    let bids = [];
    let lotResults = [];
    let outboxEvents = [];
    if (this.ctx.storage?.sql && this.room) {
      try {
        bids = Array.from(this.ctx.storage.sql.exec(`SELECT * FROM bids WHERE room_code = ? ORDER BY lot_number ASC`, this.room.roomCode));
        lotResults = Array.from(this.ctx.storage.sql.exec(`SELECT * FROM lot_results WHERE room_code = ? ORDER BY lot_number ASC`, this.room.roomCode));
        outboxEvents = Array.from(this.ctx.storage.sql.exec(`SELECT * FROM outbox WHERE room_code = ? ORDER BY id ASC`, this.room.roomCode));
      } catch (err) {
        console.error('[export snapshot sql error]');
      }
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      roomCode: this.room?.roomCode,
      room: this.getPublicRoomState(),
      bids,
      lotResults,
      outboxEvents,
      authoritativeStore: 'cloudflare-durable-objects-sqlite'
    };
  }

  // HTTP Gateway
  async fetch(request) {
    const url = new URL(request.url);

    // Internal initialization from Worker
    if (url.pathname === '/init' && request.method === 'POST') {
      const authErr = this.getAuthConfigError();
      if (authErr) {
        return new Response(JSON.stringify({ error: authErr }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      const body = await request.json();
      return this.handleInit(body);
    }

    // Public room state
    if (url.pathname === '/state' && request.method === 'GET') {
      if (!this.room) return new Response(JSON.stringify({ error: 'Room not found' }), { status: 404 });
      await this.ensureAlarmRestored();
      return new Response(JSON.stringify(this.getPublicRoomState()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Cricket Mastermind analysis
    if (url.pathname === '/analysis' && request.method === 'GET') {
      if (!this.room) return new Response(JSON.stringify({ error: 'Room not found' }), { status: 404 });
      if (this.room.status !== 'completed') {
        return new Response(JSON.stringify({ error: 'The auction has not finished yet' }), { status: 409 });
      }
      return new Response(JSON.stringify({
        roomCode: this.room.roomCode,
        analysis: this.room.analysis,
        aiAnalysis: this.room.aiAnalysis
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Full State Export / Backup Endpoint (Protected: Host Only)
    if (url.pathname === '/export' && request.method === 'GET') {
      if (!this.room) return new Response(JSON.stringify({ error: 'Room not found' }), { status: 404 });

      const authHeader = request.headers.get('Authorization') || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const xHostToken = request.headers.get('x-host-token') || request.headers.get('X-Host-Token');
      // Tokens are accepted in headers only (never the URL, which ends up in logs and history)
      const suppliedToken = xHostToken || bearerToken;

      if (!suppliedToken) {
        return new Response(JSON.stringify({ error: 'Authentication required. A valid host token must be provided via x-host-token header or Authorization Bearer token.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      this.normalizeSecrets();
      if (!isValidToken(suppliedToken) || !this.isHostHash(hashToken(suppliedToken, this.env))) {
        return new Response(JSON.stringify({ error: 'Forbidden. Only the host of this room can export room data.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify(this.getExportSnapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Native WebSocket Upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const authErr = this.getAuthConfigError();
      if (authErr) {
        return new Response(JSON.stringify({ error: authErr }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      await this.ensureAlarmRestored();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      // Unauthenticated until JOIN_ROOM; the attachment still carries the rate-limit window so an
      // unjoined socket cannot flood the room
      if (server.serializeAttachment) server.serializeAttachment({ windowStart: Date.now(), msgCount: 0 });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }

  handleInit({ roomCode, hostName, hostToken, config: configOverrides }) {
    if (this.room) {
      // Room code collision: never overwrite an existing room (the Worker retries a new code)
      return new Response(JSON.stringify({ error: 'Room code already in use', code: 'ROOM_EXISTS' }), { status: 409 });
    }
    if (!cleanName(hostName) || !isValidToken(hostToken)) {
      return new Response(JSON.stringify({ error: 'A valid hostName and hostToken are required' }), { status: 400 });
    }
    const checked = validateConfig(configOverrides || {}, DEFAULT_CONFIG);
    if (!checked.ok) {
      return new Response(JSON.stringify({ error: 'Invalid config', errors: checked.errors }), { status: 400 });
    }
    const config = checked.config;

    const catalog = JSON.parse(JSON.stringify(playersRaw));
    const franchises = {};
    const playingXIConfigurations = {};
    for (const f of IPL_FRANCHISES) {
      franchises[f.id] = {
        ...f,
        ownerTokenHash: null,
        ownerId: null,
        ownerName: null,
        isClaimed: false,
        initialPurse: config.basePurse || 120.0,
        remainingPurse: config.basePurse || 120.0,
        totalSpent: 0,
        squad: [],
        overseasCount: 0,
        isEliminated: false,
        eliminationReason: null,
        playingXI: [],
        captainId: null,
        viceCaptainId: null,
        wicketKeeperId: null,
        impactPlayerId: null,
        isConfirmed: false
      };
      playingXIConfigurations[f.id] = {
        franchiseId: f.id,
        playingXI: [],
        captainId: null,
        viceCaptainId: null,
        wicketKeeperId: null,
        impactPlayerId: null,
        isConfirmed: false,
        confirmedAt: null
      };
    }

    this.room = {
      roomCode,
      createdAt: new Date().toISOString(),
      hostTokenHash: hashToken(hostToken, this.env),
      tokenHashVerifier: tokenHashVerifier(this.env),
      hostName,
      status: 'lobby',
      config,
      max_squad_size: config.maxSquadSize,
      max_overseas_players: config.maxOverseas,
      franchises,
      playingXIConfigurations,
      playersCatalog: catalog,
      currentPlayerIndex: -1,
      currentLot: null,
      auctionOrder: null,
      history: [],
      auditLog: [],
      auditSeq: 0,
      participants: new Map(),
      recentBids: [],
      deadlineEpochMs: null,
      remainingSecondsOnPause: null,
      analysis: null,
      aiAnalysis: null
    };

    this.addAuditLog('ROOM_CREATED', `Room ${roomCode} created by host "${hostName}"`);
    this.saveToStorage();

    return new Response(JSON.stringify({
      roomCode: this.room.roomCode,
      room: this.getPublicRoomState()
    }), { status: 200 });
  }

  // Native WebSocket Message Handler
  async webSocketMessage(ws, message) {
    // 1. Message size guard (Max 32 KB)
    const rawLen = typeof message === 'string' ? message.length : (message?.byteLength || 0);
    if (rawLen > 32768) {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Payload too large (maximum allowed is 32 KB)' }));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Malformed JSON message' }));
      return;
    }

    const { id, type, payload = {} } = msg;

    if (type === 'PING') {
      ws.send(JSON.stringify({ id, type: 'PONG', timestamp: new Date().toISOString() }));
      return;
    }

    const authErr = this.getAuthConfigError();
    if (authErr) {
      if (id) ws.send(JSON.stringify({ id, type: 'ACK', success: false, error: authErr }));
      return;
    }

    if (!this.room) {
      if (id) ws.send(JSON.stringify({ id, type: 'ACK', success: false, error: 'Auction room not found' }));
      return;
    }

    if (!this.verifyRoomTokenSecret()) {
      if (id) ws.send(JSON.stringify({ id, type: 'ACK', success: false, error: 'Authentication configuration mismatch; existing room sessions cannot be verified' }));
      return;
    }
    this.normalizeSecrets();

    if (typeof type !== 'string' || type.length > 40 || (id !== undefined && (typeof id !== 'string' || id.length > 80))) {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Malformed message' }));
      return;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      if (id) ws.send(JSON.stringify({ id, type: 'ACK', success: false, error: 'Malformed payload' }));
      return;
    }

    const session = ws.deserializeAttachment ? ws.deserializeAttachment() : null;
    const roomCode = this.room.roomCode || payload.roomCode || 'UNKNOWN';
    const tokenHash = session?.tokenHash || (payload.participantToken && !isHashKey(payload.participantToken) ? hashToken(payload.participantToken, this.env) : 'anon');

    // 2. Persistent SQLite Deduplication / Replay Protection
    if (id) {
      const cached = this.getCachedAck(roomCode, tokenHash, id);
      if (cached) {
        ws.send(JSON.stringify(cached));
        return;
      }
    }

    // 3. Rate limiting per WebSocket (max 30 messages/sec)
    const now = Date.now();
    if (session) {
      if (!session.windowStart || now - session.windowStart > 1000) {
        session.windowStart = now;
        session.msgCount = 1;
      } else {
        session.msgCount = (session.msgCount || 0) + 1;
        if (session.msgCount > 30) {
          ws.send(JSON.stringify({ id, type: 'ERROR', error: 'Rate limit exceeded (max 30 msgs/sec)' }));
          return;
        }
      }
      if (ws.serializeAttachment) ws.serializeAttachment(session);
    }

    const sendAck = (success, resultOrError) => {
      if (!id) return;
      let ackMsg;
      if (success) {
        ackMsg = { id, type: 'ACK', success: true, payload: resultOrError };
      } else {
        ackMsg = {
          id,
          type: 'ACK',
          success: false,
          error: typeof resultOrError === 'string' ? resultOrError : resultOrError?.error || 'Operation failed',
          code: resultOrError?.code,
          errors: resultOrError?.errors
        };
      }

      // Persistently cache mutation ACKs in SQLite for replay protection (joins/leaves and
      // transient STORAGE_UNAVAILABLE failures are not permanently cached)
      if (type !== 'JOIN_ROOM' && type !== 'LEAVE_ROOM' && resultOrError?.code !== 'STORAGE_UNAVAILABLE') {
        this.saveCachedAck(roomCode, tokenHash, id, ackMsg);
      }

      ws.send(JSON.stringify(ackMsg));
    };

    if (type === 'JOIN_ROOM') {
      const { participantName, participantToken } = payload;
      const name = cleanName(participantName);
      if (!name || typeof participantToken !== 'string' || isHashKey(participantToken) || participantToken.includes(':') || !isValidToken(participantToken)) {
        return sendAck(false, 'Invalid participant details');
      }

      const pTokenHash = hashToken(participantToken, this.env);
      const connId = 'conn_' + crypto.randomUUID().slice(0, 12);
      const snapshot = this.cloneRoomStateForRollback();
      let isNewParticipant = false;
      let participant = this.room.participants.get(pTokenHash);
      if (!participant) {
        if (this.room.status !== 'lobby') {
          return sendAck(false, 'Auction has already started. New participants cannot join an active room.');
        }
        if (this.room.participants.size >= MAX_PARTICIPANTS) {
          return sendAck(false, 'This room is full.');
        }
        participant = {
          tokenHash: pTokenHash,
          publicId: 'usr_' + crypto.randomUUID().slice(0, 8),
          name,
          franchiseId: null,
          isHost: this.isHostHash(pTokenHash),
          activeConnId: connId,
          joinedAt: new Date().toISOString()
        };
        this.room.participants.set(pTokenHash, participant);
        isNewParticipant = true;
        this.addAuditLog('PARTICIPANT_JOINED', `${name} joined the lobby.`);
      } else {
        // Keep originally registered display name for ownership consistency on reconnect
        participant.activeConnId = connId;
        participant.isHost = this.isHostHash(pTokenHash);
      }

      try {
        this.saveToStorage();
      } catch (err) {
        this.restoreRoomStateSnapshot(snapshot);
        return sendAck(false, { code: 'STORAGE_UNAVAILABLE', error: 'Storage temporarily unavailable; could not join room.' });
      }

      // Replace any older WebSocket open for this same participant only after durable commit
      if (this.ctx.getWebSockets) {
        for (const otherWs of this.ctx.getWebSockets()) {
          if (otherWs !== ws) {
            const att = otherWs.deserializeAttachment ? otherWs.deserializeAttachment() : null;
            if (att?.tokenHash === pTokenHash) {
              try {
                otherWs.send(JSON.stringify({ type: 'SESSION_REPLACED', payload: { roomCode: this.room.roomCode } }));
                otherWs.close(1000, 'Session replaced');
              } catch {}
            }
          }
        }
      }

      ws.serializeAttachment({
        tokenHash: pTokenHash,
        publicId: participant.publicId,
        name: participant.name,
        connId,
        windowStart: now,
        msgCount: 1
      });
      // Only a NEW participant changes what others see; a reconnect must not fan out a full
      // snapshot to every client (reconnect storms on flaky mobile networks).
      if (isNewParticipant) this.broadcast('STATE_UPDATED', this.getPublicRoomState());

      return sendAck(true, {
        room: this.getPublicRoomState(),
        participant: {
          publicId: participant.publicId,
          name: participant.name,
          franchiseId: participant.franchiseId,
          isHost: participant.isHost
        }
      });
    }

    // Authenticate session from WebSocket attachment
    if (!session?.tokenHash) {
      return sendAck(false, 'Join this room before performing actions');
    }

    const participant = this.room.participants.get(session.tokenHash);
    if (!participant) {
      return sendAck(false, 'Unauthorized session');
    }

    if (participant.activeConnId && session.connId && participant.activeConnId !== session.connId) {
      return sendAck(false, 'This session was opened on another connection. Refresh to reconnect.');
    }

    // Actions are authenticated by the joined connection. A token in the payload is optional,
    // but if present it must be this participant's own token.
    for (const field of ['participantToken', 'hostToken']) {
      const v = payload[field];
      if (v !== undefined && (typeof v !== 'string' || !isValidToken(v) || hashToken(v, this.env) !== session.tokenHash)) {
        return sendAck(false, 'Unauthorized');
      }
    }

    const isHost = this.isHostHash(session.tokenHash);
    const myHash = session.tokenHash;

    switch (type) {
      case 'LEAVE_ROOM': {
        // Explicit leave: keep the participant, franchise and all auction data; just release
        // this connection so nothing reconnects it.
        const snapshot = this.cloneRoomStateForRollback();
        if (participant.activeConnId === session.connId) participant.activeConnId = null;
        this.addAuditLog('PARTICIPANT_LEFT', `${participant.name} left the room.`);
        try {
          this.saveToStorage();
        } catch (err) {
          this.restoreRoomStateSnapshot(snapshot);
          return sendAck(false, { code: 'STORAGE_UNAVAILABLE', error: 'Storage temporarily unavailable.' });
        }
        sendAck(true, {});
        try { ws.close(1000, 'Left room'); } catch { /* already closed */ }
        return;
      }

      case 'SELECT_FRANCHISE': {
        if (this.room.status !== 'lobby') {
          return sendAck(false, 'Franchise selection is locked once auction begins');
        }
        const { franchiseId } = payload;
        const franchise = this.room.franchises[franchiseId];
        if (!franchise) return sendAck(false, 'Invalid franchise selected');
        if (franchise.isClaimed && franchise.ownerTokenHash !== myHash) {
          return sendAck(false, `${franchise.name} has already been chosen by ${franchise.ownerName}`);
        }

        const snapshot = this.cloneRoomStateForRollback();
        // Release old franchise if held
        for (const f of Object.values(this.room.franchises)) {
          if (f.ownerTokenHash === myHash && f.id !== franchiseId) {
            f.isClaimed = false;
            f.ownerTokenHash = null;
            f.ownerId = null;
            f.ownerName = null;
          }
        }

        franchise.isClaimed = true;
        franchise.ownerTokenHash = myHash;
        franchise.ownerId = participant.publicId;
        franchise.ownerName = participant.name;
        participant.franchiseId = franchiseId;

        this.addAuditLog('FRANCHISE_SELECTED', `${participant.name} selected ${franchise.name} (${franchise.code})`);
        try {
          this.saveToStorage();
        } catch (err) {
          this.restoreRoomStateSnapshot(snapshot);
          return sendAck(false, { code: 'STORAGE_UNAVAILABLE', error: 'Storage temporarily unavailable; franchise selection was not saved.' });
        }
        this.broadcast('STATE_UPDATED', this.getPublicRoomState());
        return sendAck(true, { franchiseId });
      }

      case 'UPDATE_CONFIG': {
        if (!isHost) return sendAck(false, 'Only the host can perform this action');
        if (this.room.status !== 'lobby') return sendAck(false, 'Settings can only be modified before starting');
        const checked = validateConfig(payload.config || {}, this.room.config);
        if (!checked.ok) return sendAck(false, { error: checked.errors.join('; '), errors: checked.errors });

        const snapshot = this.cloneRoomStateForRollback();
        this.room.config = checked.config;
        this.room.max_squad_size = checked.config.maxSquadSize;
        this.room.max_overseas_players = checked.config.maxOverseas;
        for (const f of Object.values(this.room.franchises)) {
          f.initialPurse = checked.config.basePurse || 120.0;
          if ((f.squad || []).length === 0) {
            f.remainingPurse = checked.config.basePurse || 120.0;
          }
        }
        this.addAuditLog('CONFIG_UPDATED', 'Host updated auction configuration.');
        try {
          this.saveToStorage();
        } catch (err) {
          this.restoreRoomStateSnapshot(snapshot);
          return sendAck(false, { code: 'STORAGE_UNAVAILABLE', error: 'Storage temporarily unavailable; configuration was not saved.' });
        }
        this.broadcast('STATE_UPDATED', this.getPublicRoomState());
        return sendAck(true, { config: this.room.config });
      }

      case 'UPDATE_PLAYING_XI': {
        const { franchiseId, playingXI, captainId, viceCaptainId, wicketKeeperId, impactPlayerId, isConfirmed = true } = payload;
        const franchise = this.room.franchises[franchiseId];
        if (!franchise || !franchise.isClaimed || franchise.ownerTokenHash !== myHash || participant.franchiseId !== franchiseId) {
          return sendAck(false, { error: PLAYING_XI_FORBIDDEN, code: 'FORBIDDEN' });
        }

        const validated = validateAndBuildPlayingXI(this.room, franchiseId, {
          playingXI,
          captainId,
          viceCaptainId,
          wicketKeeperId,
          impactPlayerId,
          isConfirmed
        });
        if (!validated.success) {
          return sendAck(false, { error: validated.error, code: validated.code });
        }

        const snapshot = this.cloneRoomStateForRollback();
        Object.assign(franchise, validated.cleaned);
        if (!this.room.playingXIConfigurations) this.room.playingXIConfigurations = {};
        this.room.playingXIConfigurations[franchiseId] = {
          franchiseId,
          ...validated.cleaned,
          confirmedAt: new Date().toISOString()
        };

        this.addAuditLog('PLAYING_XI_UPDATED', `${franchise.name} confirmed their Playing XI (${validated.cleaned.playingXI.length}/11)`);
        try {
          this.saveToStorage();
        } catch (err) {
          this.restoreRoomStateSnapshot(snapshot);
          return sendAck(false, { code: 'STORAGE_UNAVAILABLE', error: 'Storage temporarily unavailable; Playing XI was not saved.' });
        }
        this.broadcast('STATE_UPDATED', this.getPublicRoomState());
        return sendAck(true, {
          franchise: this.getPublicFranchises()[franchiseId],
          configuration: this.room.playingXIConfigurations[franchiseId]
        });
      }

      case 'START_AUCTION': {
        if (!isHost) return sendAck(false, 'Only the host can start the auction');
        if (this.room.status !== 'lobby') return sendAck(false, 'Auction has already started');

        const claimedFranchises = Object.values(this.room.franchises).filter(f => f.isClaimed);
        const minParticipants = this.room.config?.minParticipants ?? DEFAULT_CONFIG.minParticipants;
        if (claimedFranchises.length < minParticipants) {
          return sendAck(false, `At least ${minParticipants} human participants must select franchises to start.`);
        }

        const snapshot = this.cloneRoomStateForRollback();
        applyFixedRulesToLobbyRoom(this.room);

        // Shuffle catalogue within sets ONCE per auction; never re-shuffled on reconnect/restart
        if (!this.room.auctionOrder) {
          shuffleWithinSets(this.room.playersCatalog);
          this.room.auctionOrder = {
            mode: 'shuffled-within-sets',
            generatedAt: new Date().toISOString(),
            locked: true
          };
          this.addAuditLog('AUCTION_ORDER_LOCKED', `Lot order generated (players shuffled within each set) and locked for ${this.room.playersCatalog.length} players.`);
        }

        this.room.status = 'active';
        this.room.startedAt = new Date().toISOString();
        this.room.storageFailure = null;
        this.addAuditLog('AUCTION_STARTED', `Auction started with ${claimedFranchises.length} active teams.`);

        // Persist lobby -> active + first lot atomically inside presentNextLot BEFORE broadcasting
        const pres = await this.presentNextLot({ broadcast: false, rollbackSnapshot: snapshot, holdOnFailure: false });
        if (pres && pres.ok === false) {
          this.restoreRoomStateSnapshot(snapshot);
          await this.safeDeleteAlarm();
          return sendAck(false, pres);
        }

        this.broadcast('STATE_UPDATED', this.getPublicRoomState());
        if (pres?.broadcastEvent) {
          this.broadcast(pres.broadcastEvent.type, pres.broadcastEvent.payload);
        }
        return sendAck(true, {});
      }

      case 'PLACE_BID': {
        if (this._closingLotNumber !== null) {
          return sendAck(false, 'Bidding is closed for this player');
        }
        const { franchiseId, bidAmount, expectedVersion } = payload;
        const franchise = this.room.franchises[franchiseId];
        if (!franchise || franchise.ownerTokenHash !== myHash || participant.franchiseId !== franchiseId) {
          return sendAck(false, 'You do not own this franchise');
        }

        const lot = this.room.currentLot;
        if (this.room.status !== 'active' || !lot || lot.hammerStatus !== 'OPEN' || !isLotOpen(lot)) {
          return sendAck(false, this.room.status === 'paused' ? 'Auction is paused' : 'Bidding is closed for this player');
        }

        const bidEpoch = Date.now();
        const activeDeadline = this.room.deadlineEpochMs || lot.deadlineEpochMs;
        if (activeDeadline && bidEpoch >= activeDeadline) {
          return sendAck(false, 'Bidding is closed for this player');
        }

        if (expectedVersion !== undefined && lot.stateVersion !== expectedVersion) {
          return sendAck(false, 'Outbid by another team. Please review the updated bid.');
        }

        const validation = validateBid({
          room: this.room,
          franchiseId,
          bidAmount,
          expectedVersion
        });
        if (!validation.valid) return sendAck(false, validation.error);

        const acceptedAmount = validation.validNextAmount;
        const nextValidBidAmount = calculateNextBid(acceptedAmount, lot.basePrice);
        const nextStateVersion = lot.stateVersion + 1;
        const timerSec = this.room.config?.timerDuration || DEFAULT_CONFIG.timerDuration;
        const nextDeadlineEpochMs = Date.now() + timerSec * 1000;
        const bidRecord = {
          id: 'bid_' + crypto.randomUUID().slice(0, 8),
          bidId: 'bid_' + crypto.randomUUID().slice(0, 8),
          roomCode: this.room.roomCode,
          lotNumber: lot.lotNumber || lot.number,
          playerId: lot.player.id,
          playerName: lot.player.name,
          franchiseId,
          franchiseCode: franchise.code,
          franchiseName: franchise.name,
          amount: acceptedAmount,
          bidAmount: acceptedAmount,
          participantName: participant.name,
          stateVersion: nextStateVersion,
          timestamp: new Date().toISOString()
        };

        const nextBidHistory = [...(lot.bidHistory || []), bidRecord];
        const proposedRecentBids = [...(this.room.recentBids || []), bidRecord].slice(-15);
        const proposedRoom = {
          ...this.room,
          deadlineEpochMs: nextDeadlineEpochMs,
          recentBids: proposedRecentBids,
          currentLot: {
            ...lot,
            highestBid: acceptedAmount,
            highestBidderFranchiseId: franchiseId,
            highestBidderName: franchise.name,
            bidder: franchiseId,
            bidCount: lot.bidCount + 1,
            nextValidBid: nextValidBidAmount,
            bidHistory: nextBidHistory,
            stateVersion: nextStateVersion,
            countdown: timerSec,
            timerDuration: timerSec,
            hammerStatus: 'OPEN',
            deadlineEpochMs: nextDeadlineEpochMs
          }
        };

        // Atomic SQLite commit before in-memory mutation or broadcast
        if (this.ctx.storage?.sql) {
          try {
            const executeWrites = () => {
              this.ctx.storage.sql.exec(
                `INSERT INTO bids (bid_id, room_code, lot_number, player_id, franchise_id, amount_cr, state_version, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                bidRecord.id,
                bidRecord.roomCode,
                bidRecord.lotNumber,
                bidRecord.playerId,
                bidRecord.franchiseId,
                bidRecord.amount,
                bidRecord.stateVersion,
                bidRecord.timestamp
              );

              const copy = { ...proposedRoom };
              copy.participants = Object.fromEntries(this.room.participants.entries());
              const { maxSquadSize: metaMaxSq, maxOverseas: metaMaxOs } = getRoomSquadLimits(this.room);
              this.ctx.storage.sql.exec(
                `INSERT INTO room_meta (room_code, state_json, deadline_epoch_ms, updated_at, max_squad_size, max_overseas_players)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(room_code) DO UPDATE SET
                   state_json = excluded.state_json,
                   deadline_epoch_ms = excluded.deadline_epoch_ms,
                   updated_at = excluded.updated_at,
                   max_squad_size = excluded.max_squad_size,
                   max_overseas_players = excluded.max_overseas_players`,
                this.room.roomCode,
                JSON.stringify(copy),
                nextDeadlineEpochMs,
                new Date().toISOString(),
                metaMaxSq,
                metaMaxOs
              );
            };

            if (typeof this.ctx.storage.transactionSync === 'function') {
              this.ctx.storage.transactionSync(executeWrites);
            } else {
              executeWrites();
            }
          } catch (sqlErr) {
            console.error('[Bid persistence failure - rejecting bid]');
            return sendAck(false, { code: 'STORAGE_UNAVAILABLE', error: 'Failed to persist bid to durable storage' });
          }
        }

        // Persistence succeeded -> commit in-memory state
        lot.highestBid = acceptedAmount;
        lot.highestBidderFranchiseId = franchiseId;
        lot.highestBidderName = franchise.name;
        lot.bidder = franchiseId;
        lot.bidCount++;
        lot.nextValidBid = nextValidBidAmount;
        lot.bidHistory = nextBidHistory;
        lot.stateVersion = nextStateVersion;
        lot.countdown = timerSec;
        lot.timerDuration = timerSec;
        lot.hammerStatus = 'OPEN';
        lot.deadlineEpochMs = nextDeadlineEpochMs;
        this.room.deadlineEpochMs = nextDeadlineEpochMs;
        this.room.recentBids = proposedRecentBids;
        this.addAuditLog('BID_ACCEPTED', `${franchise.code} placed bid of ₹${acceptedAmount.toFixed(2)} Cr on ${lot.player.name}`);

        await this.safeSetAlarm(nextDeadlineEpochMs);

        this.broadcast('BID_ACCEPTED', {
          bid: bidRecord,
          currentLot: {
            ...lot,
            deadlineEpochMs: nextDeadlineEpochMs
          },
          nextValidBid: nextValidBidAmount,
          deadlineEpochMs: nextDeadlineEpochMs
        });

        return sendAck(true, { bidRecord });
      }

      case 'PAUSE_AUCTION': {
        if (!isHost) return sendAck(false, 'Only the host can pause the auction');
        if (this.room.status !== 'active') return sendAck(false, 'Auction is not active');

        const snapshot = this.cloneRoomStateForRollback();
        this.room.status = 'paused';
        const rem = this.room.deadlineEpochMs
          ? Math.max(1, Math.ceil((this.room.deadlineEpochMs - Date.now()) / 1000))
          : (this.room.config?.timerDuration || DEFAULT_CONFIG.timerDuration);
        this.room.remainingSecondsOnPause = rem;
        this.room.deadlineEpochMs = null;
        if (this.room.currentLot) {
          this.room.currentLot.deadlineEpochMs = null;
          this.room.currentLot.countdown = rem;
        }
        this.addAuditLog('AUCTION_PAUSED', 'Auction was paused by the host.');

        try {
          this.saveToStorage();
        } catch (err) {
          this.restoreRoomStateSnapshot(snapshot);
          return sendAck(false, { code: 'STORAGE_UNAVAILABLE', error: 'Storage temporarily unavailable; could not pause auction.' });
        }

        await this.safeDeleteAlarm();
        this.broadcast('STATE_UPDATED', this.getPublicRoomState());
        return sendAck(true, { status: this.room.status });
      }

      case 'RESUME_AUCTION': {
        if (!isHost) return sendAck(false, 'Only the host can resume the auction');
        if (this.room.status !== 'paused') return sendAck(false, 'Auction is not paused');

        const snapshot = this.cloneRoomStateForRollback();
        const failureHold = this.room.storageFailure;
        this.room.storageFailure = null;
        this.room.status = 'active';
        this.addAuditLog('AUCTION_RESUMED', failureHold ? 'Host retried auction after storage hold.' : 'Auction was resumed by the host.');

        if (failureHold?.operation === 'CLOSE_LOT' && this.room.currentLot && isLotOpen(this.room.currentLot)) {
          const closeRes = await this.closeCurrentLot(this.room.currentLot.lotNumber || this.room.currentLot.number);
          if (closeRes && closeRes.ok === false) return sendAck(false, closeRes);
          this.broadcast('STATE_UPDATED', this.getPublicRoomState());
          return sendAck(true, { status: this.room.status, recovered: true });
        }

        if (failureHold?.operation === 'FINISH_AUCTION') {
          const finRes = await this.finishAuction({ rollbackSnapshot: snapshot });
          if (finRes && finRes.ok === false) return sendAck(false, finRes);
          return sendAck(true, { status: this.room.status, recovered: true });
        }

        if (failureHold?.operation === 'PRESENT_NEXT_LOT' || (this.room.currentLot && !isLotOpen(this.room.currentLot))) {
          const pres = await this.presentNextLot({ broadcast: false, rollbackSnapshot: snapshot });
          if (pres && pres.ok === false) return sendAck(false, pres);
          this.broadcast('STATE_UPDATED', this.getPublicRoomState());
          if (pres?.broadcastEvent) {
            this.broadcast(pres.broadcastEvent.type, pres.broadcastEvent.payload);
          }
          return sendAck(true, { status: this.room.status, recovered: !!failureHold });
        }

        const rem = this.room.remainingSecondsOnPause || this.room.config?.timerDuration || DEFAULT_CONFIG.timerDuration;
        this.room.deadlineEpochMs = Date.now() + rem * 1000;
        if (this.room.currentLot) {
          this.room.currentLot.deadlineEpochMs = this.room.deadlineEpochMs;
          this.room.currentLot.countdown = rem;
        }

        try {
          this.saveToStorage();
        } catch (err) {
          this.restoreRoomStateSnapshot(snapshot);
          const holdRes = await this.enterStorageFailureHold('RESUME_AUCTION', err);
          return sendAck(false, holdRes);
        }

        await this.safeSetAlarm(this.room.deadlineEpochMs);
        this.broadcast('STATE_UPDATED', this.getPublicRoomState());
        return sendAck(true, { status: this.room.status, recovered: !!failureHold });
      }

      case 'ADVANCE_LOT': {
        if (!isHost) return sendAck(false, 'Only the host can advance the lot');
        const recoveringHold = this.room.status === 'paused' && !!this.room.storageFailure;
        if (this.room.status !== 'active' && !recoveringHold) {
          return sendAck(false, 'Auction is not active');
        }
        if (recoveringHold) {
          this.room.status = 'active';
          this.room.storageFailure = null;
        }

        let res;
        if (this.room.currentLot && isLotOpen(this.room.currentLot)) {
          res = await this.closeCurrentLot();
        } else {
          res = await this.presentNextLot();
        }
        if (res && res.ok === false) return sendAck(false, res);
        if (recoveringHold) this.broadcast('STATE_UPDATED', this.getPublicRoomState());
        return sendAck(true, res || {});
      }

      case 'SKIP_SET': {
        if (!isHost) return sendAck(false, 'Only the host can skip the set');
        if (this.room.status !== 'active') return sendAck(false, 'Auction is not active');

        const currentLot = this.room.currentLot;
        if (!currentLot || !currentLot.player) return sendAck(false, 'No active lot');

        const currentSetKey = currentLot.player.categorySet || currentLot.player.setName || currentLot.player.set;
        const currentSetName = currentLot.player.setName || currentSetKey;
        if (!currentSetKey) return sendAck(false, 'No active player set to skip');

        const snapshot = this.cloneRoomStateForRollback();

        let skippedCount = 0;
        for (let i = Math.max(0, this.room.currentPlayerIndex); i < this.room.playersCatalog.length; i++) {
          const p = this.room.playersCatalog[i];
          const pSetKey = p.categorySet || p.setName || p.set;
          if ((pSetKey === currentSetKey || p.setName === currentSetName) && !FINAL_PLAYER_STATUSES.includes(p.status)) {
            p.status = 'SKIPPED';
            skippedCount++;
            this.room.history.unshift({
              lotNumber: p.overallLot || (i + 1),
              player: p,
              status: 'SKIPPED',
              winningFranchiseId: null,
              winningFranchiseName: null,
              winningFranchiseCode: null,
              finalBid: 0,
              bidsCount: 0,
              timestamp: new Date().toISOString()
            });
          }
        }

        this.addAuditLog('SET_SKIPPED', `Host skipped remaining players in set "${currentSetName}". (${skippedCount} player(s) marked as SKIPPED)`);

        let nextIdx = -1;
        for (let i = Math.max(0, this.room.currentPlayerIndex); i < this.room.playersCatalog.length; i++) {
          const p = this.room.playersCatalog[i];
          if (!FINAL_PLAYER_STATUSES.includes(p.status)) {
            nextIdx = i;
            break;
          }
        }

        const setSkippedPayload = {
          skippedSetName: currentSetName,
          skippedCount,
          playersCatalog: this.room.playersCatalog,
          history: this.room.history
        };

        // Persist complete updated state BEFORE any SET_SKIPPED / LOT_PRESENTED / AUCTION_COMPLETED broadcast
        let followUp;
        if (nextIdx === -1) {
          followUp = await this.finishAuction({ broadcast: false, rollbackSnapshot: snapshot });
        } else {
          this.room.currentPlayerIndex = nextIdx - 1;
          followUp = await this.presentNextLot({ broadcast: false, rollbackSnapshot: snapshot });
        }

        if (followUp && followUp.ok === false) {
          return sendAck(false, followUp);
        }

        this.broadcast('SET_SKIPPED', setSkippedPayload);
        if (followUp?.broadcastEvent) {
          this.broadcast(followUp.broadcastEvent.type, followUp.broadcastEvent.payload);
        }
        return sendAck(true, { skippedCount, skippedSetName: currentSetName });
      }

      case 'FINISH_AUCTION': {
        if (!isHost) return sendAck(false, 'Only the host can finish the auction');
        const finRes = await this.finishAuction();
        if (finRes && finRes.ok === false) return sendAck(false, finRes);
        return sendAck(true, finRes || {});
      }

      case 'REQUEST_AI_ANALYSIS': {
        if (this.room.status !== 'completed') {
          return sendAck(false, 'AI analysis is available only after the auction has finished');
        }
        return sendAck(true, {
          status: 'unavailable',
          message: 'AI analysis is not configured on this server. The rule-based analysis is shown instead.',
          analysis: this.room.analysis
        });
      }

      default:
        return sendAck(false, `Unknown message type: ${type}`);
    }
  }

  // Durable Object Alarm: Authoritative Deadline Expiry & Post-Lot Advancement
  async alarm() {
    if (this.env?.DATABASE_URL) {
      try {
        await this.syncOutboxToNeon(this.env);
      } catch (err) {
        console.error('[alarm outbox sync error]');
      }
    }

    if (!this.room || this.room.status !== 'active' || this.room.storageFailure) return;

    const lot = this.room.currentLot;
    if (!lot) return;

    const now = Date.now();
    const activeDeadline = this.room.deadlineEpochMs || lot.deadlineEpochMs;

    // 1. Open lot expiry check
    if (lot.hammerStatus === 'OPEN') {
      if (activeDeadline && now < activeDeadline) {
        await this.safeSetAlarm(activeDeadline);
        return;
      }

      await this.closeCurrentLot(lot.lotNumber || lot.number);
      return;
    }

    // 2. Closed lot post-hammer pause expiry check -> advance to next player
    if (lot.hammerStatus === 'SOLD' || lot.hammerStatus === 'UNSOLD') {
      const pauseDeadline = this.room.deadlineEpochMs || lot.advanceDeadlineEpochMs;
      if (pauseDeadline && now < pauseDeadline) {
        await this.safeSetAlarm(pauseDeadline);
        return;
      }

      await this.presentNextLot();
    }
  }

  async closeCurrentLot(expectedLotNumber = null) {
    if (!this.room) return { ok: false, error: 'Room not initialized' };
    if (this._closingLotNumber !== null) {
      return { ok: false, duplicate: true, error: 'Lot closure already in progress' };
    }

    const lot = this.room.currentLot;
    if (!lot || !isLotOpen(lot)) {
      return { ok: true, alreadyClosed: true };
    }
    const lotNumber = lot.lotNumber || lot.number;
    if (expectedLotNumber !== null && lotNumber !== expectedLotNumber) {
      return { ok: true, alreadyClosed: true };
    }

    this._closingLotNumber = lotNumber;
    const snapshot = this.cloneRoomStateForRollback();

    try {
      // Idempotency guard against SQLite: refuse duplicate sale processing if already persisted
      if (this.ctx.storage?.sql) {
        try {
          const existingRows = Array.from(this.ctx.storage.sql.exec(
            `SELECT status, final_bid_cr, winning_franchise_id FROM lot_results WHERE room_code = ? AND lot_number = ? LIMIT 1`,
            this.room.roomCode,
            lotNumber
          ));
          if (existingRows.length > 0) {
            lot.closed = true;
            if (existingRows[0].status === 'SOLD' || existingRows[0].status === 'UNSOLD') {
              lot.hammerStatus = existingRows[0].status;
            }
            return { ok: true, alreadyPersisted: true, result: existingRows[0].status };
          }
        } catch (sqlErr) {
          console.error('[SQLite pre-close verification error]');
          this.restoreRoomStateSnapshot(snapshot);
          return await this.enterStorageFailureHold('CLOSE_LOT', sqlErr, { lotNumber });
        }
      }

      lot.closed = true;

      const catalogPlayer = this.room.playersCatalog.find(p => p.id === lot.player.id);
      const winnerId = lot.highestBidderFranchiseId || lot.bidder;
      const winner = winnerId ? this.room.franchises[winnerId] : null;
      const bidAmount = lot.highestBid;

      const eliminatedBefore = new Set(Object.values(this.room.franchises).filter(f => f.isEliminated).map(f => f.id));
      let canFinalizeSale = !!(winner && bidAmount >= lot.basePrice && bidAmount > 0);
      let invariantFailure = null;

      const { maxSquadSize, maxOverseas } = getRoomSquadLimits(this.room);
      // Authoritative invariant verification before finalizing sale (prevents overseas/purse/duplicate bugs)
      if (canFinalizeSale) {
        if (winner.isEliminated) {
          canFinalizeSale = false;
          invariantFailure = 'Franchise is financially eliminated';
        } else if (winner.squad.length >= maxSquadSize) {
          canFinalizeSale = false;
          invariantFailure = 'Squad limit reached!';
        } else if (winner.squad.some(p => p.id === lot.player.id)) {
          canFinalizeSale = false;
          invariantFailure = 'Player already in franchise squad';
        } else if (lot.player.isOverseas && (winner.overseasCount || 0) >= maxOverseas) {
          canFinalizeSale = false;
          invariantFailure = 'Overseas player limit reached!';
        } else if (toLakh(winner.remainingPurse) < toLakh(bidAmount)) {
          canFinalizeSale = false;
          invariantFailure = 'Insufficient purse balance';
        }
      }

      let historyEntry;

      if (canFinalizeSale) {
        lot.hammerStatus = 'SOLD';
        const priceLakh = toLakh(bidAmount);
        winner.remainingPurse = fromLakh(toLakh(winner.remainingPurse) - priceLakh);
        winner.totalSpent = fromLakh(toLakh(winner.totalSpent || 0) + priceLakh);

        const acquiredPlayer = {
          ...lot.player,
          status: 'sold',
          soldTo: winnerId,
          soldPrice: bidAmount,
          boughtPrice: bidAmount
        };
        winner.squad.push(acquiredPlayer);
        if (lot.player.isOverseas) {
          winner.overseasCount = (winner.overseasCount || 0) + 1;
        }

        if (catalogPlayer) {
          catalogPlayer.status = 'sold';
          catalogPlayer.soldTo = winnerId;
          catalogPlayer.soldPrice = bidAmount;
          catalogPlayer.boughtPrice = bidAmount;
        }
        lot.player.status = 'sold';
        lot.player.soldTo = winnerId;
        lot.player.soldPrice = bidAmount;
        lot.player.boughtPrice = bidAmount;

        // Update financial elimination status across claimed teams
        for (const f of Object.values(this.room.franchises)) {
          if (f.isClaimed && !f.isEliminated) {
            const elimCheck = checkFinancialElimination(f, this.room.config, reserveFloorLakh(this.room));
            if (elimCheck.isEliminated) {
              f.isEliminated = true;
              f.eliminationReason = elimCheck.reason;
              this.addAuditLog('FINANCIAL_ELIMINATION', `${f.name} is FINANCIALLY ELIMINATED: ${elimCheck.reason}`);
            }
          }
        }

        historyEntry = {
          lotNumber,
          player: lot.player,
          finalBid: bidAmount,
          winningFranchiseId: winnerId,
          winningFranchiseName: winner.name,
          winningFranchiseCode: winner.code,
          bidsCount: (lot.bidHistory || []).length || lot.bidCount || 0,
          status: 'SOLD',
          timestamp: new Date().toISOString()
        };
        this.room.history.unshift(historyEntry);

        this.addAuditLog('PLAYER_SOLD', `SOLD! ${lot.player.name} bought by ${winner.name} for ₹${bidAmount.toFixed(2)} Cr`);
      } else {
        lot.hammerStatus = 'UNSOLD';
        if (catalogPlayer) {
          catalogPlayer.status = 'unsold';
        }
        lot.player.status = 'unsold';

        if (invariantFailure) {
          this.addAuditLog('SALE_INVARIANT_BLOCKED', `Prevented invalid sale of ${lot.player.name}: ${invariantFailure}`);
        } else {
          this.addAuditLog('PLAYER_UNSOLD', `${lot.player.name} went UNSOLD at base price ₹${lot.basePrice} Cr`);
        }

        historyEntry = {
          lotNumber,
          player: lot.player,
          finalBid: 0,
          winningFranchiseId: null,
          winningFranchiseName: null,
          winningFranchiseCode: null,
          bidsCount: 0,
          status: 'UNSOLD',
          timestamp: new Date().toISOString()
        };
        this.room.history.unshift(historyEntry);
      }

      const advanceDelayMs = Math.round((this.room.config?.autoAdvanceDelay ?? DEFAULT_CONFIG.autoAdvanceDelay) * 1000);
      lot.advanceDeadlineEpochMs = Date.now() + advanceDelayMs;
      this.room.deadlineEpochMs = lot.advanceDeadlineEpochMs;
      this.room.storageFailure = null;

      // Atomically commit lot_results + outbox + room_meta BEFORE any alarm or broadcast
      if (this.ctx.storage?.sql) {
        const commitLotSql = () => {
          this.ctx.storage.sql.exec(
            `INSERT INTO lot_results (room_code, lot_number, player_id, status, final_bid_cr, winning_franchise_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(room_code, lot_number) DO UPDATE SET
               status = excluded.status,
               final_bid_cr = excluded.final_bid_cr,
               winning_franchise_id = excluded.winning_franchise_id`,
            this.room.roomCode,
            historyEntry.lotNumber,
            historyEntry.player.id,
            historyEntry.status,
            historyEntry.finalBid,
            historyEntry.winningFranchiseId,
            historyEntry.timestamp
          );

          this.ctx.storage.sql.exec(
            `INSERT INTO outbox (room_code, event_type, payload_json, status, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            this.room.roomCode,
            canFinalizeSale ? 'LOT_SOLD' : 'LOT_UNSOLD',
            JSON.stringify(historyEntry),
            'pending',
            historyEntry.timestamp
          );

          this.writeRoomMetaSql();
        };

        try {
          if (typeof this.ctx.storage.transactionSync === 'function') {
            this.ctx.storage.transactionSync(commitLotSql);
          } else {
            commitLotSql();
          }
        } catch (sqlErr) {
          console.error('[SQLite lot result insert error - rolling back sale]');
          this.restoreRoomStateSnapshot(snapshot);
          return await this.enterStorageFailureHold('CLOSE_LOT', sqlErr, { lotNumber });
        }

        if (this.env?.DATABASE_URL) {
          if (this.ctx.waitUntil) {
            this.ctx.waitUntil(this.syncOutboxToNeon(this.env));
          } else {
            this.syncOutboxToNeon(this.env).catch(() => {});
          }
        }
      }

      await this.safeSetAlarm(lot.advanceDeadlineEpochMs);

      // Delta broadcast: only franchises whose purse/squad/elimination changed
      const pub = this.getPublicFranchises();
      const franchiseUpdates = {};
      if (canFinalizeSale && winnerId) franchiseUpdates[winnerId] = pub[winnerId];
      for (const f of Object.values(this.room.franchises)) {
        if (f.isEliminated && !eliminatedBefore.has(f.id)) franchiseUpdates[f.id] = pub[f.id];
      }
      try {
        this.broadcast('LOT_COMPLETED', {
          result: historyEntry.status,
          lot,
          historyEntry,
          franchiseUpdates,
          playerUpdate: { id: lot.player.id, status: lot.player.status, soldTo: lot.player.soldTo || null, soldPrice: lot.player.soldPrice || 0 }
        });
      } catch (broadcastErr) {
        console.error('[Post-commit LOT_COMPLETED broadcast warning]');
        return { ok: true, persisted: true, result: historyEntry.status, broadcastError: broadcastErr?.message || 'broadcast failed' };
      }

      return { ok: true, persisted: true, result: historyEntry.status };
    } finally {
      this._closingLotNumber = null;
    }
  }

  async presentNextLot({ broadcast = true, rollbackSnapshot = null, holdOnFailure = true } = {}) {
    const snapshot = rollbackSnapshot || this.cloneRoomStateForRollback();

    do {
      this.room.currentPlayerIndex++;
    } while (
      this.room.currentPlayerIndex < this.room.playersCatalog.length &&
      FINAL_PLAYER_STATUSES.includes(this.room.playersCatalog[this.room.currentPlayerIndex]?.status)
    );

    if (this.room.currentPlayerIndex >= this.room.playersCatalog.length) {
      return await this.finishAuction({ broadcast, rollbackSnapshot: snapshot });
    }

    const player = this.room.playersCatalog[this.room.currentPlayerIndex];
    player.status = 'in_auction';

    const basePrice = player.basePriceCr || player.basePrice || 2.0;
    const timerSec = this.room.config?.timerDuration || DEFAULT_CONFIG.timerDuration;
    const deadline = Date.now() + timerSec * 1000;
    const lotNumber = this.room.currentPlayerIndex + 1;

    const completedInSet = (player.lotInSet || 1) - 1;
    const remainingInSet = Math.max(1, (player.setTotal || 6) - completedInSet);
    const remainingInAuction = this.room.playersCatalog.filter((p, i) =>
      i >= this.room.currentPlayerIndex && p && !FINAL_PLAYER_STATUSES.includes(p.status)
    ).length;
    const currentRound = player.round;
    const currentProfile = player.profile;
    const remainingInRound = this.room.playersCatalog.filter((p, i) =>
      i >= this.room.currentPlayerIndex && p &&
      (currentRound === undefined || p.round === currentRound) &&
      (currentProfile === undefined || p.profile === currentProfile) &&
      !FINAL_PLAYER_STATUSES.includes(p.status)
    ).length;
    const nextPlayerObj = this.room.playersCatalog[this.room.currentPlayerIndex + 1] || null;

    this.room.currentLot = {
      number: lotNumber,
      lotNumber,
      totalLots: this.room.playersCatalog.length,
      player,
      profile: player.profile || 'standard',
      profileTitle: player.profileTitle || 'AUCTION',
      round: player.round || 1,
      category: player.category,
      categoryTitle: player.categoryTitle,
      setName: player.setName,
      setNumber: player.setNumber,
      lotInSet: player.lotInSet,
      setTotal: player.setTotal,
      completedInSet,
      remainingInSet,
      remainingInRound,
      remainingInAuction,
      nextPlayer: nextPlayerObj ? {
        id: nextPlayerObj.id,
        name: nextPlayerObj.name,
        category: nextPlayerObj.category,
        role: nextPlayerObj.role,
        imageUrl: nextPlayerObj.imageUrl
      } : null,
      basePrice,
      highestBid: 0,
      highestBidderFranchiseId: null,
      highestBidderName: null,
      bidder: null,
      bidCount: 0,
      nextValidBid: basePrice,
      countdown: timerSec,
      timerDuration: timerSec,
      hammerStatus: 'OPEN',
      closed: false,
      stateVersion: 1,
      bidHistory: [],
      deadlineEpochMs: deadline,
      advanceDeadlineEpochMs: null
    };

    this.room.deadlineEpochMs = deadline;
    this.room.storageFailure = null;
    this.addAuditLog('LOT_PRESENTED', `Lot #${lotNumber}: ${player.name} (${player.category} - ${player.setName || ''}) presented with base price ₹${basePrice} Cr`);

    try {
      this.saveToStorage();
    } catch (sqlErr) {
      this.restoreRoomStateSnapshot(snapshot);
      if (!holdOnFailure) {
        return {
          ok: false,
          code: 'STORAGE_UNAVAILABLE',
          error: 'Storage temporarily unavailable; could not present next lot.'
        };
      }
      return await this.enterStorageFailureHold('PRESENT_NEXT_LOT', sqlErr, { lotNumber });
    }

    await this.safeSetAlarm(this.room.deadlineEpochMs);

    const pubState = this.getPublicRoomState();
    const broadcastEvent = {
      type: 'LOT_PRESENTED',
      payload: {
        roomCode: pubState.roomCode,
        status: pubState.status,
        currentPlayerIndex: pubState.currentPlayerIndex,
        lotNumber: pubState.lotNumber,
        totalLots: pubState.totalLots,
        currentLot: pubState.currentLot,
        deadlineEpochMs: this.room.deadlineEpochMs,
        partial: true
      }
    };

    if (broadcast) {
      this.broadcast(broadcastEvent.type, broadcastEvent.payload);
    }
    return { ok: true, persisted: true, broadcastEvent };
  }

  async finishAuction({ broadcast = true, rollbackSnapshot = null } = {}) {
    if (this.room.currentLot && isLotOpen(this.room.currentLot)) {
      const closeRes = await this.closeCurrentLot();
      if (closeRes && closeRes.ok === false) return closeRes;
    }

    const snapshot = rollbackSnapshot || this.cloneRoomStateForRollback();

    this.room.status = 'completed';
    this.room.currentLot = null;
    this.room.deadlineEpochMs = null;
    this.room.storageFailure = null;
    this.room.completedAt = new Date().toISOString();

    // Run deterministic Cricket Mastermind
    try {
      this.room.analysis = evaluateAuction(this.room);
    } catch (err) {
      console.error('[Mastermind evaluation error]');
    }

    const winnerName = this.room.analysis?.verdict?.winnerFranchiseName || 'Evaluation ready';
    this.addAuditLog('AUCTION_FINISHED', `Auction complete! Winner: ${winnerName}`);

    if (this.ctx.storage?.sql) {
      const commitFinishSql = () => {
        this.ctx.storage.sql.exec(
          `INSERT INTO outbox (room_code, event_type, payload_json, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          this.room.roomCode,
          'AUCTION_COMPLETED',
          JSON.stringify({
            roomCode: this.room.roomCode,
            completedAt: this.room.completedAt,
            analysis: this.room.analysis
          }),
          'pending',
          this.room.completedAt
        );
        this.writeRoomMetaSql();
      };

      try {
        if (typeof this.ctx.storage.transactionSync === 'function') {
          this.ctx.storage.transactionSync(commitFinishSql);
        } else {
          commitFinishSql();
        }
      } catch (sqlErr) {
        console.error('[SQLite finish commit error - rolling back completion]');
        this.restoreRoomStateSnapshot(snapshot);
        return await this.enterStorageFailureHold('FINISH_AUCTION', sqlErr);
      }

      if (this.env?.DATABASE_URL) {
        if (this.ctx.waitUntil) {
          this.ctx.waitUntil(this.syncOutboxToNeon(this.env));
        } else {
          this.syncOutboxToNeon(this.env).catch(() => {});
        }
      }
    }

    await this.safeDeleteAlarm();

    const broadcastEvent = {
      type: 'AUCTION_COMPLETED',
      payload: this.getPublicRoomState()
    };
    if (broadcast) {
      this.broadcast(broadcastEvent.type, broadcastEvent.payload);
    }
    return { ok: true, persisted: true, broadcastEvent };
  }

  // Real Cloudflare-Compatible Synchronizer to Neon via Serverless HTTP Query (only active when DATABASE_URL is explicitly configured)
  async syncOutboxToNeon(env = this.env) {
    if (!this.ctx.storage?.sql) return { synced: 0, status: 'no_sql' };
    const dbUrl = env?.DATABASE_URL;
    if (!dbUrl) {
      return { synced: 0, status: 'neon_not_configured', authoritative: 'sqlite' };
    }

    try {
      const cursor = this.ctx.storage.sql.exec(
        `SELECT id, room_code, event_type, payload_json FROM outbox WHERE status = 'pending' ORDER BY id ASC LIMIT 50`
      );
      const rows = Array.from(cursor);
      if (rows.length === 0) return { synced: 0, status: 'up_to_date' };

      const match = dbUrl.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^/:]+)(?::\d+)?\/(.+)$/);
      if (!match) {
        return { synced: 0, status: 'invalid_database_url' };
      }

      const [, , password, host] = match;
      const neonSqlEndpoint = `https://${host}/sql`;

      let syncedCount = 0;
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json);

        let query = '';
        let params = [];

        if (row.event_type === 'LOT_SOLD' || row.event_type === 'LOT_UNSOLD') {
          query = `
            INSERT INTO lot_results (room_code, lot_number, player_id, status, final_bid_cr, winning_franchise_id, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (room_code, lot_number) DO UPDATE SET
              status = EXCLUDED.status,
              final_bid_cr = EXCLUDED.final_bid_cr,
              winning_franchise_id = EXCLUDED.winning_franchise_id;
          `;
          params = [
            row.room_code,
            payload.lotNumber,
            payload.player?.id || 'unknown',
            payload.status,
            payload.finalBid || 0,
            payload.winningFranchiseId || null,
            payload.timestamp || new Date().toISOString()
          ];
        } else if (row.event_type === 'AUCTION_COMPLETED') {
          query = `
            UPDATE rooms SET
              status = 'completed',
              updated_at = NOW()
            WHERE room_code = $1;
          `;
          params = [row.room_code];
        }

        if (query) {
          const res = await fetch(neonSqlEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${password}`
            },
            body: JSON.stringify({ query, params })
          });

          if (!res.ok) {
            if (this.ctx.storage?.setAlarm) {
              await this.ctx.storage.setAlarm(Date.now() + 30000);
            }
            return { synced: syncedCount, status: 'retry_scheduled', error: `HTTP ${res.status}` };
          }
        }

        this.ctx.storage.sql.exec(
          `UPDATE outbox SET status = 'delivered' WHERE id = ?`,
          row.id
        );
        syncedCount++;
      }

      return { synced: syncedCount, status: 'success' };
    } catch (err) {
      if (this.ctx.storage?.setAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 30000);
      }
      return { synced: 0, status: 'error', error: err.message };
    }
  }

  async flushOutbox(targetSyncFn) {
    if (!this.ctx.storage?.sql) return { deliveredCount: 0 };
    try {
      const cursor = this.ctx.storage.sql.exec(
        `SELECT id, room_code, event_type, payload_json FROM outbox WHERE status = 'pending' ORDER BY id ASC LIMIT 50`
      );
      const rows = Array.from(cursor);
      let deliveredCount = 0;
      for (const row of rows) {
        if (targetSyncFn) {
          await targetSyncFn(row.event_type, JSON.parse(row.payload_json));
        }
        this.ctx.storage.sql.exec(
          `UPDATE outbox SET status = 'delivered' WHERE id = ?`,
          row.id
        );
        deliveredCount++;
      }
      return { deliveredCount };
    } catch (err) {
      console.error('[DO outbox flush error]');
      return { deliveredCount: 0, error: err.message };
    }
  }

  broadcast(type, payload) {
    const sockets = this.ctx.getWebSockets ? this.ctx.getWebSockets() : [];
    const msg = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch (err) {
        // closed or errored socket
      }
    }
  }

  addAuditLog(type, message) {
    appendAuditEntry(this.room, type, message);
  }

  getPublicFranchises() {
    const out = {};
    for (const [id, f] of Object.entries(this.room.franchises)) {
      // eslint-disable-next-line no-unused-vars
      const { ownerToken, ownerTokenHash, ownerSocketId, ...pub } = f;
      out[id] = pub;
    }
    return out;
  }

  getPublicRoomState() {
    if (!this.room) return null;
    const isActive = this.room.status === 'active';
    const { maxSquadSize, maxOverseas } = getRoomSquadLimits(this.room);
    return {
      roomCode: this.room.roomCode,
      createdAt: this.room.createdAt,
      startedAt: this.room.startedAt,
      completedAt: this.room.completedAt,
      status: this.room.status,
      hostName: this.room.hostName,
      config: this.room.config,
      max_squad_size: maxSquadSize,
      max_overseas_players: maxOverseas,
      franchises: this.getPublicFranchises(),
      playingXIConfigurations: this.room.playingXIConfigurations || {},
      playersCatalog: this.room.playersCatalog,
      currentPlayerIndex: this.room.currentPlayerIndex,
      lotNumber: this.room.currentLot?.lotNumber || this.room.currentLot?.number || 0,
      totalLots: this.room.playersCatalog?.length || 0,
      currentLot: this.room.currentLot ? {
        ...this.room.currentLot,
        deadlineEpochMs: isActive ? this.room.deadlineEpochMs : null,
        countdown: isActive && this.room.deadlineEpochMs
          ? Math.max(0, Math.ceil((this.room.deadlineEpochMs - Date.now()) / 1000))
          : this.room.currentLot.countdown
      } : null,
      history: this.room.history,
      recentBids: this.room.recentBids,
      auditLog: (this.room.auditLog || []).slice(0, 30),
      analysis: this.room.analysis,
      aiAnalysis: this.room.aiAnalysis,
      storageFailure: this.room.storageFailure || null
    };
  }
}
