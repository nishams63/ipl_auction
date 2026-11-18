import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { RoomManager } from './roomManager.js';
import { IPL_FRANCHISES } from './data/franchises.js';
import { isValidToken, cleanName, isValidRoomCode } from './security.js';
import { ConfigValidationError } from './config.js';
import { createStorageFromEnv } from './persistence/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 100 * 1024 // no legitimate client message is anywhere near this
});

app.use(cors());
app.use(express.json({ limit: '20kb' }));

// Storage authority: JSON file (default) or PostgreSQL (PERSISTENCE=postgres + DATABASE_URL).
// PostgreSQL rooms are fully restored BEFORE the server starts listening. Any storage startup
// error stops the process: there is no silent fallback to another authority.
let storage;
try {
  storage = await createStorageFromEnv(process.env);
} catch (err) {
  console.error(`[storage] FATAL: ${err.message}`);
  process.exit(1);
}
for (const w of storage.warnings) console.warn(`[storage] ${w}`);
const roomManager = new RoomManager(io, storage.store ? { store: storage.store } : {});

/**
 * PostgreSQL: become the single writer, then restore. If another instance holds the writer
 * lease (e.g. the previous release during a Render deploy), wait in STANDBY: /api/health
 * answers 200 with status "standby", room traffic gets 503 / "starting", and the lease is
 * polled until the other instance releases it (graceful stop) or it expires (crash).
 */
async function becomeActive() {
  const store = storage.store;
  let waitingLogged = false;
  for (;;) {
    const { acquired, holder } = await store.tryAcquireLease();
    if (acquired) break;
    if (!waitingLogged) {
      console.warn(`[storage] STANDBY: another instance (${holder}) holds the writer lease. Waiting for it to stop or for the lease to expire.`);
      waitingLogged = true;
    }
    await new Promise(r => setTimeout(r, Math.min(2000, Math.max(250, Math.floor(store.leaseTtlMs / 10)))));
    if (shuttingDown) return;
  }
  await roomManager.init();
  console.log(`[storage] ACTIVE: PostgreSQL (${store.status.database}) is the durable storage authority; this instance holds the writer lease and has restored all rooms.`);
}

const STARTING_MSG = 'The server is starting up. Please retry in a few seconds.';
const NOT_SAVED_MSG = 'The server could not save this action to the database. The auction is on hold until saving works again; your action is kept and will appear once it has been saved.';
const HOLD_MSG = 'Saving to the database is temporarily unavailable, so this room is on hold. Please retry shortly.';

// Acknowledge a successful change only after it is durably committed (JSON mode: at once)
async function ackDurably(room, result, callback, success = r => r) {
  if (!result || !result.success) return callback(result);
  if (await roomManager.persisted(room)) return callback(success(result));
  callback({ success: false, code: 'STORAGE_UNAVAILABLE', error: NOT_SAVED_MSG });
}

// API Endpoints
app.get('/api/health', (req, res) => {
  // storage.kind is 'json-file' (durable: false) or 'postgres' (durable: true). Never contains
  // credentials: the database is described as host:port/dbname only.
  // HTTP 200 in every state (a restart loop would make things worse); read `status`.
  const storage = roomManager.storageStatus;
  let status = 'ok';
  if (storage.kind === 'postgres') {
    if (storage.role !== 'active' || !roomManager.ready) status = storage.role === 'standby' ? 'standby' : 'starting';
    else if (storage.leaseLost || storage.conflicts.length > 0 || storage.roomsOnHold.length > 0 ||
      !storage.connected || (storage.lastError && storage.pendingWrites > 0)) status = 'degraded';
  }
  res.json({ status, time: new Date().toISOString(), storage });
});

app.get('/api/franchises', (req, res) => {
  res.json(IPL_FRANCHISES);
});

// Create Room
app.post('/api/rooms', async (req, res) => {
  const { hostName, hostToken, config } = req.body || {};
  const name = cleanName(hostName);
  if (!name || !isValidToken(hostToken)) {
    return res.status(400).json({ error: 'A valid hostName and hostToken are required' });
  }

  if (!roomManager.ready) return res.status(503).json({ error: STARTING_MSG });
  let room;
  try {
    room = roomManager.createRoom({ hostName: name, hostToken, configOverrides: config });
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return res.status(400).json({ error: 'Invalid auction configuration', errors: err.errors });
    }
    throw err;
  }

  if (!(await roomManager.persisted(room))) {
    roomManager.discardUnsavedRoom(room.roomCode); // never announced, so nothing is lost
    return res.status(503).json({ error: 'The room could not be saved to the database. Please try again.' });
  }
  res.json({
    roomCode: room.roomCode,
    room: roomManager.getPublicRoomState(room)
  });
});

// Get Room State (public view: contains no tokens)
// Post-auction analysis (deterministic snapshot + AI reports). Same visibility as the room state.
app.get('/api/rooms/:code/analysis', async (req, res) => {
  if (!roomManager.ready) return res.status(503).json({ error: STARTING_MSG });
  const room = roomManager.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status !== 'completed') return res.status(409).json({ error: 'The auction has not finished yet' });
  if (roomManager.storageBlocked(room) || !(await roomManager.persisted(room))) {
    return res.status(503).json({ error: HOLD_MSG });
  }
  const state = roomManager.getPublicRoomState(room);
  res.json({ roomCode: room.roomCode, analysis: state.analysis, aiAnalysis: state.aiAnalysis });
});

app.get('/api/rooms/:code', async (req, res) => {
  if (!roomManager.ready) return res.status(503).json({ error: STARTING_MSG });
  const room = roomManager.getRoom(req.params.code);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  // Only committed state is served
  if (roomManager.storageBlocked(room) || !(await roomManager.persisted(room))) {
    return res.status(503).json({ error: HOLD_MSG });
  }
  res.json(roomManager.getPublicRoomState(room));
});

/**
 * Resolves who is acting from the SERVER-SIDE session bound at join_room.
 * Client-supplied tokens are never trusted on their own:
 *  - the socket must have joined this room,
 *  - it must still be the participant's current connection,
 *  - if the payload carries a token anyway, it must match the session.
 */
function resolveSession(socket, payload = {}, { requireHost = false } = {}) {
  const code = typeof payload.roomCode === 'string' ? payload.roomCode.toUpperCase() : null;
  const token = socket.data.participantToken;
  if (!token || !code || socket.data.roomCode !== code) {
    return { error: 'Join this room before performing actions' };
  }
  const room = roomManager.getRoom(code);
  if (!room) return { error: 'Room not found' };
  if (roomManager.storageBlocked(room)) return { error: HOLD_MSG, code: 'STORAGE_UNAVAILABLE' };
  const participant = room.participants.get(token);
  if (!participant || participant.socketId !== socket.id) {
    return { error: 'This session was opened on another connection. Refresh to reconnect.' };
  }
  for (const field of ['participantToken', 'hostToken']) {
    if (payload[field] !== undefined && payload[field] !== token) {
      return { error: 'Unauthorized' };
    }
  }
  if (requireHost && room.hostToken !== token) {
    return { error: 'Only the host can perform this action' };
  }
  return { room, participant, token, code };
}

// Wrap every handler: bad payloads get an error ack instead of crashing the process
function on(socket, event, handler) {
  socket.on(event, (payload, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    Promise.resolve()
      .then(() => handler(payload && typeof payload === 'object' ? payload : {}, ack))
      .catch(err => {
        console.error(`Handler ${event} failed:`, err);
        ack({ success: false, error: 'Server error' });
      });
  });
}

// Socket.io Real-Time Event Handlers
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Join Room (also used for reconnection with the same private token)
  on(socket, 'join_room', async ({ roomCode, participantName, participantToken }, callback) => {
    const name = cleanName(participantName);
    if (!isValidRoomCode(roomCode)) return callback({ success: false, error: 'Invalid room code' });
    if (!isValidToken(participantToken)) return callback({ success: false, error: 'Invalid session token' });
    if (!name) return callback({ success: false, error: 'Name must be 1–30 characters' });

    if (!roomManager.ready) return callback({ success: false, code: 'STARTING', error: STARTING_MSG });
    const code = roomCode.toUpperCase();
    if (roomManager.storageBlocked(roomManager.getRoom(code))) return callback({ success: false, code: 'STORAGE_UNAVAILABLE', error: HOLD_MSG });
    const result = roomManager.joinRoom({
      roomCode: code,
      participantName: name,
      participantToken,
      socketId: socket.id
    });

    if (!result.success) return callback({ success: false, error: result.error });
    // The join (and the room state returned below) must be committed before it is confirmed
    if (!(await roomManager.persisted(roomManager.getRoom(code)))) {
      return callback({ success: false, code: 'STORAGE_UNAVAILABLE', error: HOLD_MSG });
    }

    // Leave any previously joined room on this socket
    if (socket.data.roomCode && socket.data.roomCode !== code) socket.leave(socket.data.roomCode);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.participantToken = participantToken;

    // Revoke the older connection for this participant (e.g. another tab or a stale socket)
    if (result.previousSocketId) {
      const old = io.sockets.sockets.get(result.previousSocketId);
      if (old) {
        old.emit('session_replaced', { roomCode: code });
        old.leave(code);
        old.data.roomCode = null;
        old.data.participantToken = null;
      }
    }

    const room = roomManager.getRoom(code);
    roomManager.broadcastRoomState(room, 'state_updated');
    callback({ success: true, room: roomManager.getPublicRoomState(room), participant: result.participant });
  });

  // Select Franchise
  on(socket, 'select_franchise', async (payload, callback) => {
    const s = resolveSession(socket, payload);
    if (s.error) return callback({ success: false, error: s.error });
    const result = roomManager.selectFranchise({ roomCode: s.code, participantToken: s.token, franchiseId: payload.franchiseId });
    if (!result.success) return callback({ success: false, error: result.error });
    roomManager.broadcastRoomState(s.room, 'state_updated'); // held until committed
    await ackDurably(s.room, result, callback, () => ({ success: true, franchiseId: payload.franchiseId }));
  });

  // Update Playing XI: franchise OWNER only (host has no override); enforced in
  // RoomManager.updatePlayingXI using the session-bound identity, never the payload.
  on(socket, 'update_playing_xi', async (payload, callback) => {
    const s = resolveSession(socket, payload);
    if (s.error) return callback({ success: false, error: s.error, code: 'FORBIDDEN' });
    const { franchiseId, playingXI, captainId, viceCaptainId, wicketKeeperId, impactPlayerId } = payload;
    if (playingXI !== undefined && !Array.isArray(playingXI)) {
      return callback({ success: false, error: 'Invalid Playing XI' });
    }
    await ackDurably(s.room, roomManager.updatePlayingXI({
      roomCode: s.code,
      participantToken: s.token,
      franchiseId,
      playingXI: playingXI || [],
      captainId,
      viceCaptainId,
      wicketKeeperId,
      impactPlayerId
    }), callback);
  });

  // Host Update Config
  on(socket, 'update_config', async (payload, callback) => {
    const s = resolveSession(socket, payload, { requireHost: true });
    if (s.error) return callback({ success: false, error: s.error });
    const result = roomManager.updateConfig({ roomCode: s.code, hostToken: s.token, newConfig: payload.config });
    if (!result.success) return callback({ success: false, error: result.error, errors: result.errors });
    roomManager.broadcastRoomState(s.room, 'state_updated');
    await ackDurably(s.room, result, callback, () => ({ success: true }));
  });

  // Host Start Auction
  on(socket, 'start_auction', async (payload, callback) => {
    const s = resolveSession(socket, payload, { requireHost: true });
    if (s.error) return callback({ success: false, error: s.error });
    const result = roomManager.startAuction({ roomCode: s.code, hostToken: s.token });
    if (!result.success) return callback({ success: false, error: result.error });
    await ackDurably(s.room, result, callback, () => ({ success: true }));
  });

  // Host Pause
  on(socket, 'pause_auction', async (payload, callback) => {
    const s = resolveSession(socket, payload, { requireHost: true });
    if (s.error) return callback({ success: false, error: s.error });
    const result = roomManager.pauseAuction({ roomCode: s.code, hostToken: s.token });
    if (!result.success) return callback({ success: false, error: result.error });
    roomManager.broadcastRoomState(s.room, 'state_updated');
    await ackDurably(s.room, result, callback, r => ({ success: true, room: r.room }));
  });

  // Host Resume
  on(socket, 'resume_auction', async (payload, callback) => {
    const s = resolveSession(socket, payload, { requireHost: true });
    if (s.error) return callback({ success: false, error: s.error });
    const result = roomManager.resumeAuction({ roomCode: s.code, hostToken: s.token });
    if (!result.success) return callback({ success: false, error: result.error });
    roomManager.broadcastRoomState(s.room, 'state_updated');
    await ackDurably(s.room, result, callback, r => ({ success: true, room: r.room }));
  });

  // Place Automatic Bid (amount is computed and validated on the server)
  on(socket, 'place_bid', async (payload, callback) => {
    const s = resolveSession(socket, payload);
    if (s.error) return callback({ success: false, error: s.error });
    await ackDurably(s.room, roomManager.placeBid({
      roomCode: s.code,
      participantToken: s.token,
      franchiseId: payload.franchiseId,
      bidAmount: payload.bidAmount,
      expectedVersion: payload.expectedVersion
    }), callback);
  });

  // Host Advance Lot
  on(socket, 'advance_lot', async (payload, callback) => {
    const s = resolveSession(socket, payload, { requireHost: true });
    if (s.error) return callback({ success: false, error: s.error });
    await ackDurably(s.room, roomManager.skipOrAdvanceLot({ roomCode: s.code, hostToken: s.token }), callback);
  });

  // Host Skip Current Player Set
  // Post-auction AI reports: any participant of THIS room (session-bound); regeneration host-only
  on(socket, 'request_ai_analysis', async (payload, callback) => {
    const s = resolveSession(socket, { roomCode: payload.roomCode });
    if (s.error) return callback({ success: false, error: s.error });
    const result = roomManager.requestAiAnalysis({ roomCode: s.code, participantToken: s.token, force: payload.force === true });
    callback(result);
  });

  on(socket, 'skip_set', async (payload, callback) => {
    const s = resolveSession(socket, payload, { requireHost: true });
    if (s.error) return callback({ success: false, error: s.error });
    await ackDurably(s.room, roomManager.skipCurrentSet({ roomCode: s.code, hostToken: s.token }), callback);
  });

  // Host Force Finish Auction
  on(socket, 'finish_auction', async (payload, callback) => {
    const s = resolveSession(socket, payload, { requireHost: true });
    if (s.error) return callback({ success: false, error: s.error });
    if (s.room.status !== 'active' && s.room.status !== 'paused') {
      return callback({ success: false, error: 'Auction is not running' });
    }
    roomManager.finishAuction(s.room);
    await ackDurably(s.room, { success: true }, callback);
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// Serve static build in production if available
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) {
      res.send('IPL Multiplayer Auction Server Running. Vite client dev server is on port 5173.');
    }
  });
});

// Flush pending room saves when Render stops or redeploys the instance
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Bounded wait so a hung database cannot block the platform's stop sequence forever
    const guard = setTimeout(() => {
      console.error('[storage] shutdown flush timed out; exiting (unsaved changes are reported above)');
      process.exit(1);
    }, 8000);
    try {
      await roomManager.shutdown(); // stops timers, flushes pending saves
      if (storage.store) await storage.store.close();
    } catch (err) {
      console.error('[storage] error during shutdown flush:', err.message);
    }
    clearTimeout(guard);
    process.exit(0);
  });
}

const PORT = process.env.PORT || 4000;
if (storage.store) {
  becomeActive().catch(err => {
    console.error(`[storage] FATAL: could not restore rooms from PostgreSQL: ${err.message}`);
    process.exit(1);
  });
}
server.listen(PORT, '0.0.0.0', () => {
  console.log(`IPL Auction Backend Server running on port ${PORT}`);
  const st = roomManager.storageStatus;
  if (st.kind === 'postgres') console.log(`[storage] PostgreSQL (${st.database}) selected; JSON file storage is disabled. Room traffic is accepted once this instance holds the writer lease.`);
  else console.warn(`[storage] ${st.warning}`);
});
