import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { RoomManager } from './roomManager.js';
import { IPL_FRANCHISES } from './data/franchises.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

const roomManager = new RoomManager(io);

// API Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/franchises', (req, res) => {
  res.json(IPL_FRANCHISES);
});

// Create Room
app.post('/api/rooms', (req, res) => {
  const { hostName, hostToken, config } = req.body;
  if (!hostName || !hostToken) {
    return res.status(400).json({ error: 'hostName and hostToken are required' });
  }

  const room = roomManager.createRoom({
    hostName,
    hostToken,
    configOverrides: config || {}
  });

  res.json({
    roomCode: room.roomCode,
    room: roomManager.getPublicRoomState(room)
  });
});

// Get Room State
app.get('/api/rooms/:code', (req, res) => {
  const room = roomManager.getRoom(req.params.code);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json(roomManager.getPublicRoomState(room));
});

// Socket.io Real-Time Event Handlers
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Join Room
  socket.on('join_room', ({ roomCode, participantName, participantToken }, callback) => {
    const result = roomManager.joinRoom({
      roomCode,
      participantName,
      participantToken,
      socketId: socket.id
    });

    if (result.success) {
      socket.join(roomCode.toUpperCase());
      socket.data.roomCode = roomCode.toUpperCase();
      socket.data.participantToken = participantToken;

      // Broadcast updated room state to all in room
      const room = roomManager.getRoom(roomCode);
      roomManager.broadcastRoomState(room, 'state_updated');

      if (callback) callback({ success: true, room: result.room, participant: result.participant });
    } else {
      if (callback) callback({ success: false, error: result.error });
    }
  });

  // Select Franchise
  socket.on('select_franchise', ({ roomCode, participantToken, franchiseId }, callback) => {
    const result = roomManager.selectFranchise({ roomCode, participantToken, franchiseId });
    if (result.success) {
      const room = roomManager.getRoom(roomCode);
      roomManager.broadcastRoomState(room, 'state_updated');
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, error: result.error });
    }
  });

  // Update Playing XI
  socket.on('update_playing_xi', ({ roomCode, participantToken, franchiseId, playingXI, captainId, viceCaptainId, wicketKeeperId, impactPlayerId }, callback) => {
    const result = roomManager.updatePlayingXI({
      roomCode,
      participantToken,
      franchiseId,
      playingXI,
      captainId,
      viceCaptainId,
      wicketKeeperId,
      impactPlayerId
    });
    if (callback) callback(result);
  });

  // Host Update Config
  socket.on('update_config', ({ roomCode, hostToken, config }, callback) => {
    const result = roomManager.updateConfig({ roomCode, hostToken, newConfig: config });
    if (result.success) {
      const room = roomManager.getRoom(roomCode);
      roomManager.broadcastRoomState(room, 'state_updated');
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, error: result.error });
    }
  });

  // Host Start Auction
  socket.on('start_auction', ({ roomCode, hostToken }, callback) => {
    const result = roomManager.startAuction({ roomCode, hostToken });
    if (result.success) {
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, error: result.error });
    }
  });

  // Host Pause
  socket.on('pause_auction', ({ roomCode, hostToken }, callback) => {
    const result = roomManager.pauseAuction({ roomCode, hostToken });
    if (result.success) {
      const room = roomManager.getRoom(roomCode);
      roomManager.broadcastRoomState(room, 'state_updated');
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, error: result.error });
    }
  });

  // Host Resume
  socket.on('resume_auction', ({ roomCode, hostToken }, callback) => {
    const result = roomManager.resumeAuction({ roomCode, hostToken });
    if (result.success) {
      const room = roomManager.getRoom(roomCode);
      roomManager.broadcastRoomState(room, 'state_updated');
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, error: result.error });
    }
  });

  // Place Automatic Bid
  socket.on('place_bid', ({ roomCode, participantToken, franchiseId, bidAmount, expectedVersion }, callback) => {
    const result = roomManager.placeBid({
      roomCode,
      participantToken,
      franchiseId,
      bidAmount,
      expectedVersion
    });

    if (callback) callback(result);
  });

  // Host Advance Lot
  socket.on('advance_lot', ({ roomCode, hostToken }, callback) => {
    const result = roomManager.skipOrAdvanceLot({ roomCode, hostToken });
    if (callback) callback(result);
  });

  // Host Force Finish Auction
  socket.on('finish_auction', ({ roomCode, hostToken }, callback) => {
    const room = roomManager.getRoom(roomCode);
    if (room && room.hostToken === hostToken) {
      roomManager.finishAuction(room);
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, error: 'Unauthorized' });
    }
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

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`IPL Auction Backend Server running on http://localhost:${PORT}`);
});
