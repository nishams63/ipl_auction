// In-Memory Authoritative Room Manager for Real-Time IPL Auction
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { IPL_FRANCHISES } from './data/franchises.js';
import {
  DEFAULT_CONFIG,
  calculateDynamicPurse,
  calculateNextBid,
  validateBid,
  checkFinancialElimination,
  evaluateFranchiseSquad,
  rankFranchises
} from './auctionEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the 290 deduplicated players
const playersRaw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'players.json'), 'utf-8')
);

const STORAGE_FILE = path.join(__dirname, 'data', 'persisted_rooms.json');

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomCode -> roomState
    this.timerIntervals = new Map(); // roomCode -> intervalId
    this.loadFromStorage();
  }

  saveToStorage() {
    try {
      const serializableRooms = {};
      for (const [code, r] of this.rooms.entries()) {
        serializableRooms[code] = {
          ...r,
          participants: Array.from(r.participants ? r.participants.entries() : [])
        };
      }
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(serializableRooms, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save rooms to disk:', err.message);
    }
  }

  loadFromStorage() {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        for (const [code, r] of Object.entries(data)) {
          r.participants = new Map(r.participants || []);
          if (!r.playingXIConfigurations) {
            r.playingXIConfigurations = {};
            for (const f of IPL_FRANCHISES) {
              const franchise = r.franchises?.[f.id];
              r.playingXIConfigurations[f.id] = {
                franchiseId: f.id,
                playingXI: franchise?.playingXI || [],
                captainId: franchise?.captainId || null,
                viceCaptainId: franchise?.viceCaptainId || null,
                wicketKeeperId: franchise?.wicketKeeperId || null,
                impactPlayerId: franchise?.impactPlayerId || null,
                isConfirmed: !!(franchise?.playingXI && franchise.playingXI.length === 11),
                confirmedAt: null
              };
            }
          }
          this.rooms.set(code, r);
        }
        console.log(`Loaded ${this.rooms.size} persistent room(s) from disk.`);
      }
    } catch (err) {
      console.error('Failed to load rooms from disk:', err.message);
    }
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  createRoom({ hostName, hostToken, configOverrides = {} }) {
    let roomCode = this.generateRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = this.generateRoomCode();
    }

    const config = {
      ...DEFAULT_CONFIG,
      ...configOverrides
    };

    // Deep clone players list for this room
    const catalog = JSON.parse(JSON.stringify(playersRaw));

    // Initialize all 10 franchises with flat ₹120.0 Crore purse and Playing XI management
    const franchises = {};
    for (const f of IPL_FRANCHISES) {
      franchises[f.id] = {
        ...f,
        ownerToken: null,
        ownerName: null,
        ownerSocketId: null,
        isClaimed: false,
        initialPurse: config.basePurse || 120.0,
        remainingPurse: config.basePurse || 120.0,
        totalSpent: 0,
        squad: [],
        overseasCount: 0,
        isEliminated: false,
        eliminationReason: null,
        playingXI: [], // 11 players in batting order
        captainId: null, // Exactly 1
        viceCaptainId: null, // Exactly 1
        wicketKeeperId: null, // At least 1
        impactPlayerId: null // From bench
      };
    }

    // Independent, dedicated Playing XI configuration store for all franchises
    const playingXIConfigurations = {};
    for (const f of IPL_FRANCHISES) {
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

    const room = {
      roomCode,
      createdAt: new Date().toISOString(),
      hostToken,
      hostName,
      status: 'lobby', // 'lobby' | 'active' | 'paused' | 'completed'
      config,
      playersCatalog: catalog,
      currentPlayerIndex: -1,
      currentLot: null,
      franchises,
      playingXIConfigurations,
      participants: new Map(), // token -> { token, name, socketId, franchiseId, isHost }
      history: [], // List of completed lots { player, winningFranchise, finalBid, bidsCount, status }
      allBids: [], // Complete audit log of every bid placed
      auditLog: [
        {
          timestamp: new Date().toISOString(),
          type: 'ROOM_CREATED',
          message: `Room ${roomCode} created by host "${hostName}"`
        }
      ],
      evaluationResults: null
    };

    this.rooms.set(roomCode, room);
    this.saveToStorage();
    return room;
  }

  getRoom(roomCode) {
    if (!roomCode) return null;
    return this.rooms.get(roomCode.toUpperCase()) || null;
  }

  joinRoom({ roomCode, participantName, participantToken, socketId }) {
    const room = this.getRoom(roomCode);
    if (!room) {
      return { success: false, error: 'Auction room not found' };
    }

    // Check if participant is reconnecting
    let participant = room.participants.get(participantToken);
    if (participant) {
      // Reconnection
      participant.socketId = socketId;
      participant.name = participantName || participant.name;
      if (participant.franchiseId && room.franchises[participant.franchiseId]) {
        room.franchises[participant.franchiseId].ownerSocketId = socketId;
      }
      this.addAuditLog(room, 'PARTICIPANT_RECONNECTED', `${participant.name} reconnected.`);
      return { success: true, room: this.getPublicRoomState(room), participant };
    }

    // New participant joining
    if (room.status !== 'lobby') {
      return {
        success: false,
        error: 'Auction has already started. New participants cannot join an active room.'
      };
    }

    const isHost = room.hostToken === participantToken;
    participant = {
      token: participantToken,
      name: participantName,
      socketId,
      franchiseId: null,
      isHost
    };

    room.participants.set(participantToken, participant);
    this.addAuditLog(room, 'PARTICIPANT_JOINED', `${participantName} joined the lobby.`);

    this.recalculateLobbyPurses(room);

    return { success: true, room: this.getPublicRoomState(room), participant };
  }

  selectFranchise({ roomCode, participantToken, franchiseId }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };

    if (room.status !== 'lobby') {
      return { success: false, error: 'Franchise selection is locked once auction begins' };
    }

    const participant = room.participants.get(participantToken);
    if (!participant) return { success: false, error: 'Participant not registered in room' };

    const targetFranchise = room.franchises[franchiseId];
    if (!targetFranchise) return { success: false, error: 'Invalid franchise selected' };

    // Check if already claimed by someone else
    if (targetFranchise.isClaimed && targetFranchise.ownerToken !== participantToken) {
      return { success: false, error: `${targetFranchise.name} has already been chosen by ${targetFranchise.ownerName}` };
    }

    // Free previously selected franchise if any
    if (participant.franchiseId && participant.franchiseId !== franchiseId) {
      const prev = room.franchises[participant.franchiseId];
      if (prev && prev.ownerToken === participantToken) {
        prev.isClaimed = false;
        prev.ownerToken = null;
        prev.ownerName = null;
        prev.ownerSocketId = null;
      }
    }

    // Claim new franchise
    targetFranchise.isClaimed = true;
    targetFranchise.ownerToken = participantToken;
    targetFranchise.ownerName = participant.name;
    targetFranchise.ownerSocketId = participant.socketId;
    participant.franchiseId = franchiseId;

    this.recalculateLobbyPurses(room);

    this.addAuditLog(
      room,
      'FRANCHISE_SELECTED',
      `${participant.name} selected ${targetFranchise.name} (${targetFranchise.code})`
    );

    return { success: true, room: this.getPublicRoomState(room) };
  }

  recalculateLobbyPurses(room) {
    // Every IPL franchise starts with exactly ₹120 Crore (Total across 10 franchises = ₹1,200 Cr)
    const flatPurse = room.config.basePurse || 120.0;
    for (const f of Object.values(room.franchises)) {
      f.initialPurse = flatPurse;
      if (f.squad.length === 0) {
        f.remainingPurse = flatPurse;
      }
    }
  }

  updatePlayingXI({ roomCode, participantToken, franchiseId, playingXI = [], captainId = null, viceCaptainId = null, wicketKeeperId = null, impactPlayerId = null, isConfirmed = true }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };

    const franchise = room.franchises[franchiseId];
    if (!franchise) return { success: false, error: 'Franchise not found' };

    // Ownership or Host check: franchise owner or host can edit and confirm Playing XI
    const isOwner = franchise.ownerToken === participantToken;
    const isHost = room.hostToken === participantToken;
    if (!isOwner && !isHost) {
      return { success: false, error: 'Only the franchise owner or host can configure this Playing XI' };
    }

    // Build recognized player map from catalog and purchased squad
    const playerLookup = new Map();
    (room.playersCatalog || []).forEach(p => playerLookup.set(p.id, p));
    (franchise.squad || []).forEach(p => playerLookup.set(p.id, p));

    // Validate player existence
    for (const pid of playingXI) {
      if (!playerLookup.has(pid)) {
        return { success: false, error: 'Selected player is not recognized in this auction room' };
      }
    }

    // Max 11 players in Playing XI
    if (playingXI.length > 11) {
      return { success: false, error: 'Playing XI cannot have more than 11 players' };
    }

    // Overseas limit in Playing XI (Max 4 overseas)
    const overseasInXI = playingXI.filter(pid => playerLookup.get(pid)?.isOverseas).length;
    if (overseasInXI > 4) {
      return {
        success: false,
        error: `Maximum 4 overseas players allowed in Playing XI (Current: ${overseasInXI})`
      };
    }

    // Impact Player validation: must be recognized, not in starting XI
    if (impactPlayerId) {
      if (!playerLookup.has(impactPlayerId)) {
        return { success: false, error: 'Impact player must be a recognized candidate or squad player' };
      }
      if (playingXI.includes(impactPlayerId)) {
        return { success: false, error: 'Impact player cannot also be in the starting Playing XI' };
      }
    }

    // Captain and Vice-Captain assignment checks
    if (captainId && !playingXI.includes(captainId)) {
      return { success: false, error: 'Captain must be selected from the Playing XI' };
    }
    if (viceCaptainId && !playingXI.includes(viceCaptainId)) {
      return { success: false, error: 'Vice-Captain must be selected from the Playing XI' };
    }
    if (captainId && viceCaptainId && captainId === viceCaptainId) {
      return { success: false, error: 'Captain and Vice-Captain must be two distinct players' };
    }

    // If XI is fully populated (11 players), enforce mandatory roles
    if (playingXI.length === 11) {
      const wkCount = playingXI.filter(pid => playerLookup.get(pid)?.category === 'WK').length;
      if (wkCount < 1) {
        return { success: false, error: 'Playing XI must have at least 1 Wicketkeeper' };
      }
      if (!captainId) {
        return { success: false, error: 'Playing XI must have exactly 1 Captain assigned' };
      }
      if (!viceCaptainId) {
        return { success: false, error: 'Playing XI must have exactly 1 Vice-Captain assigned' };
      }
    }

    // Update franchise state
    franchise.playingXI = [...playingXI];
    franchise.captainId = captainId;
    franchise.viceCaptainId = viceCaptainId;
    franchise.wicketKeeperId = wicketKeeperId || (playingXI.find(pid => playerLookup.get(pid)?.category === 'WK') || null);
    franchise.impactPlayerId = impactPlayerId;
    franchise.isConfirmed = !!isConfirmed;

    // Independent persistent data structure
    if (!room.playingXIConfigurations) room.playingXIConfigurations = {};
    room.playingXIConfigurations[franchiseId] = {
      franchiseId,
      playingXI: [...playingXI],
      captainId,
      viceCaptainId,
      wicketKeeperId: franchise.wicketKeeperId,
      impactPlayerId,
      isConfirmed: !!isConfirmed,
      confirmedAt: new Date().toISOString()
    };

    this.saveToStorage();
    this.addAuditLog(room, 'PLAYING_XI_UPDATED', `${franchise.name} confirmed their Playing XI (${playingXI.length}/11)`);
    this.broadcastRoomState(room, 'state_updated');

    return {
      success: true,
      franchise,
      configuration: room.playingXIConfigurations[franchiseId]
    };
  }

  updateConfig({ roomCode, hostToken, newConfig }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };
    if (room.hostToken !== hostToken) return { success: false, error: 'Only the host can configure auction settings' };
    if (room.status !== 'lobby') return { success: false, error: 'Settings can only be modified before starting' };

    if (newConfig.basePurse && newConfig.basePurse > 0) {
      room.config.basePurse = Number(newConfig.basePurse);
    }
    if (newConfig.minSquadSize && newConfig.minSquadSize >= 1) {
      room.config.minSquadSize = Number(newConfig.minSquadSize);
    }
    if (newConfig.maxSquadSize && newConfig.maxSquadSize >= room.config.minSquadSize) {
      room.config.maxSquadSize = Number(newConfig.maxSquadSize);
    }
    if (newConfig.maxOverseas !== undefined) {
      room.config.maxOverseas = Number(newConfig.maxOverseas);
    }
    if (newConfig.timerDuration && newConfig.timerDuration >= 10) {
      room.config.timerDuration = Number(newConfig.timerDuration);
    }

    this.recalculateLobbyPurses(room);
    this.addAuditLog(room, 'CONFIG_UPDATED', `Host updated auction configuration.`);
    return { success: true, room: this.getPublicRoomState(room) };
  }

  startAuction({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };
    if (room.hostToken !== hostToken) return { success: false, error: 'Only host can start the auction' };

    const claimedFranchises = Object.values(room.franchises).filter(f => f.isClaimed);
    if (claimedFranchises.length < room.config.minParticipants) {
      return {
        success: false,
        error: `At least ${room.config.minParticipants} human participants must select franchises to start.`
      };
    }

    // Lock dynamic purse allocation permanently
    this.recalculateLobbyPurses(room);
    room.status = 'active';

    this.addAuditLog(
      room,
      'AUCTION_STARTED',
      `Auction started with ${claimedFranchises.length} active teams. Purse locked at ₹${claimedFranchises[0].initialPurse} Cr each.`
    );

    // Present first player
    this.nextPlayer(room);

    return { success: true, room: this.getPublicRoomState(room) };
  }

  pauseAuction({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room || room.hostToken !== hostToken) return { success: false, error: 'Unauthorized' };

    if (room.status === 'active') {
      room.status = 'paused';
      this.clearRoomTimer(roomCode);
      this.addAuditLog(room, 'AUCTION_PAUSED', 'Auction was paused by the host.');
      return { success: true, room: this.getPublicRoomState(room) };
    }
    return { success: false, error: 'Auction is not active' };
  }

  resumeAuction({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room || room.hostToken !== hostToken) return { success: false, error: 'Unauthorized' };

    if (room.status === 'paused') {
      room.status = 'active';
      this.startRoomTimer(room);
      this.addAuditLog(room, 'AUCTION_RESUMED', 'Auction was resumed by the host.');
      return { success: true, room: this.getPublicRoomState(room) };
    }
    return { success: false, error: 'Auction is not paused' };
  }

  nextPlayer(room) {
    this.clearRoomTimer(room.roomCode);

    room.currentPlayerIndex++;
    if (room.currentPlayerIndex >= room.playersCatalog.length) {
      // Completed all players!
      this.finishAuction(room);
      return;
    }

    const player = room.playersCatalog[room.currentPlayerIndex];
    player.status = 'in_auction';

    const completedInSet = (player.lotInSet || 1) - 1;
    const remainingInSet = (player.setTotal || 8) - completedInSet;
    const nextPlayerObj = room.playersCatalog[room.currentPlayerIndex + 1] || null;

    room.currentLot = {
      player,
      lotNumber: room.currentPlayerIndex + 1,
      totalLots: room.playersCatalog.length,
      category: player.category,
      categoryTitle: player.categoryTitle,
      setName: player.setName,
      setNumber: player.setNumber,
      lotInSet: player.lotInSet,
      setTotal: player.setTotal,
      completedInSet,
      remainingInSet,
      nextPlayer: nextPlayerObj ? {
        id: nextPlayerObj.id,
        name: nextPlayerObj.name,
        category: nextPlayerObj.category,
        role: nextPlayerObj.role,
        imageUrl: nextPlayerObj.imageUrl
      } : null,
      highestBid: 0,
      highestBidderFranchiseId: null,
      highestBidderName: null,
      nextValidBid: player.basePrice,
      countdown: room.config.timerDuration,
      stateVersion: 1,
      bidHistory: [],
      hammerStatus: 'OPEN' // 'OPEN' | 'GOING_ONCE' | 'GOING_TWICE' | 'SOLD' | 'UNSOLD'
    };

    this.addAuditLog(
      room,
      'LOT_PRESENTED',
      `Lot #${room.currentLot.lotNumber}: ${player.name} (${player.category} - ${player.setName}) presented with base price ₹${player.basePrice} Cr`
    );

    this.broadcastRoomState(room, 'lot_presented');
    this.startRoomTimer(room);
  }

  startRoomTimer(room) {
    this.clearRoomTimer(room.roomCode);

    const intervalId = setInterval(() => {
      if (room.status !== 'active') return;

      const lot = room.currentLot;
      if (!lot) return;

      lot.countdown--;

      // Hammer callouts at thresholds for 15-second countdown
      if (lot.highestBid > 0) {
        if (lot.countdown === 7) lot.hammerStatus = 'GOING_ONCE';
        if (lot.countdown === 3) lot.hammerStatus = 'GOING_TWICE';
      }

      if (lot.countdown <= 0) {
        this.closeCurrentLot(room);
      } else {
        // Emit ticking countdown to clients
        this.io.to(room.roomCode).emit('timer_tick', {
          countdown: lot.countdown,
          hammerStatus: lot.hammerStatus,
          stateVersion: lot.stateVersion
        });
      }
    }, 1000);

    this.timerIntervals.set(room.roomCode, intervalId);
  }

  clearRoomTimer(roomCode) {
    if (this.timerIntervals.has(roomCode)) {
      clearInterval(this.timerIntervals.get(roomCode));
      this.timerIntervals.delete(roomCode);
    }
  }

  placeBid({ roomCode, participantToken, franchiseId, bidAmount, expectedVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };

    const participant = room.participants.get(participantToken);
    if (!participant || participant.franchiseId !== franchiseId) {
      return { success: false, error: 'You can only bid for your own assigned franchise' };
    }

    // Atomic bid validation
    const validation = validateBid({
      room,
      franchiseId,
      bidAmount,
      expectedVersion
    });

    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const lot = room.currentLot;
    const franchise = room.franchises[franchiseId];

    // Concurrency lock: Update lot state version atomically
    lot.stateVersion++;
    lot.highestBid = validation.validNextAmount;
    lot.highestBidderFranchiseId = franchiseId;
    lot.highestBidderName = franchise.name;
    lot.nextValidBid = calculateNextBid(lot.highestBid, lot.player.basePrice);
    lot.countdown = room.config.timerDuration; // Reset countdown
    lot.hammerStatus = 'OPEN';

    const bidRecord = {
      bidId: `BID_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      lotNumber: lot.lotNumber,
      playerId: lot.player.id,
      playerName: lot.player.name,
      franchiseId,
      franchiseCode: franchise.code,
      franchiseName: franchise.name,
      bidAmount: lot.highestBid,
      timestamp: new Date().toISOString(),
      participantName: participant.name,
      stateVersion: lot.stateVersion
    };

    lot.bidHistory.push(bidRecord);
    room.allBids.push(bidRecord);

    this.addAuditLog(
      room,
      'BID_ACCEPTED',
      `${franchise.code} placed bid of ₹${lot.highestBid.toFixed(2)} Cr on ${lot.player.name}`
    );

    // Broadcast bid accepted event immediately to all clients with sound trigger
    this.io.to(room.roomCode).emit('bid_accepted', {
      bid: bidRecord,
      currentLot: lot,
      nextValidBid: lot.nextValidBid,
      franchises: room.franchises
    });

    return { success: true };
  }

  closeCurrentLot(room) {
    this.clearRoomTimer(room.roomCode);

    const lot = room.currentLot;
    if (!lot) return;

    const player = lot.player;

    if (lot.highestBidderFranchiseId && lot.highestBid > 0) {
      // SOLD!
      lot.hammerStatus = 'SOLD';
      player.status = 'sold';
      player.soldTo = lot.highestBidderFranchiseId;
      player.soldPrice = lot.highestBid;

      const winningFranchise = room.franchises[lot.highestBidderFranchiseId];
      winningFranchise.remainingPurse = Math.round((winningFranchise.remainingPurse - lot.highestBid) * 100) / 100;
      winningFranchise.totalSpent = Math.round((winningFranchise.totalSpent + lot.highestBid) * 100) / 100;

      winningFranchise.squad.push({
        ...player,
        boughtPrice: lot.highestBid
      });

      if (player.isOverseas) {
        winningFranchise.overseasCount++;
      }

      // Check financial elimination for all claimed franchises
      for (const f of Object.values(room.franchises)) {
        if (f.isClaimed && !f.isEliminated) {
          const elimCheck = checkFinancialElimination(f, room.config);
          if (elimCheck.isEliminated) {
            f.isEliminated = true;
            f.eliminationReason = elimCheck.reason;
            this.addAuditLog(
              room,
              'FINANCIAL_ELIMINATION',
              `${f.name} is FINANCIALLY ELIMINATED: ${elimCheck.reason}`
            );
          }
        }
      }

      const historyEntry = {
        lotNumber: lot.lotNumber,
        player,
        status: 'SOLD',
        winningFranchiseId: winningFranchise.id,
        winningFranchiseName: winningFranchise.name,
        winningFranchiseCode: winningFranchise.code,
        finalBid: lot.highestBid,
        bidsCount: lot.bidHistory.length,
        timestamp: new Date().toISOString()
      };

      room.history.unshift(historyEntry);

      this.addAuditLog(
        room,
        'PLAYER_SOLD',
        `SOLD! ${player.name} bought by ${winningFranchise.name} for ₹${lot.highestBid.toFixed(2)} Cr`
      );

      this.io.to(room.roomCode).emit('lot_completed', {
        result: 'SOLD',
        lot: lot,
        historyEntry,
        franchises: room.franchises,
        playersCatalog: room.playersCatalog
      });
    } else {
      // UNSOLD
      lot.hammerStatus = 'UNSOLD';
      player.status = 'unsold';

      const historyEntry = {
        lotNumber: lot.lotNumber,
        player,
        status: 'UNSOLD',
        winningFranchiseId: null,
        winningFranchiseName: null,
        finalBid: 0,
        bidsCount: 0,
        timestamp: new Date().toISOString()
      };

      room.history.unshift(historyEntry);

      this.addAuditLog(room, 'PLAYER_UNSOLD', `${player.name} went UNSOLD at base price ₹${player.basePrice} Cr`);

      this.io.to(room.roomCode).emit('lot_completed', {
        result: 'UNSOLD',
        lot: lot,
        historyEntry,
        franchises: room.franchises,
        playersCatalog: room.playersCatalog
      });
    }

    // Auto advance to next player after configured delay (e.g. 4 seconds)
    setTimeout(() => {
      if (room.status === 'active') {
        this.nextPlayer(room);
      }
    }, room.config.autoAdvanceDelay * 1000);
  }

  finishAuction(room) {
    this.clearRoomTimer(room.roomCode);
    room.status = 'completed';
    room.currentLot = null;

    // Run deterministic squad evaluations
    const activeFranchises = Object.values(room.franchises).filter(f => f.isClaimed);
    const initialPurse = activeFranchises[0]?.initialPurse || room.config.basePurse;

    const evaluations = activeFranchises.map(f =>
      evaluateFranchiseSquad(f, room.config, initialPurse)
    );

    const rankingResult = rankFranchises(evaluations);
    room.evaluationResults = rankingResult;

    this.addAuditLog(
      room,
      'AUCTION_FINISHED',
      `Auction complete! Winner: ${rankingResult.podium[0]?.franchiseName || 'No eligible team'}`
    );

    this.broadcastRoomState(room, 'auction_completed');
  }

  skipOrAdvanceLot({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room || room.hostToken !== hostToken) return { success: false, error: 'Unauthorized' };

    if (room.currentLot && room.status === 'active') {
      this.closeCurrentLot(room);
      return { success: true };
    }
    return { success: false, error: 'Cannot advance lot right now' };
  }

  skipCurrentSet({ roomCode, hostToken }) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };
    if (room.hostToken !== hostToken) return { success: false, error: 'Only the auction host can skip player sets' };
    if (room.status !== 'active') return { success: false, error: 'Auction is not currently active' };

    if (room.isSkippingSet) {
      return { success: false, error: 'Set skip is already in progress' };
    }
    room.isSkippingSet = true;

    try {
      const currentLot = room.currentLot;
      if (!currentLot || !currentLot.player) {
        room.isSkippingSet = false;
        return { success: false, error: 'No active player set to skip' };
      }

      // Stop current timer immediately
      this.clearRoomTimer(room.roomCode);

      const currentSetKey = currentLot.player.categorySet || currentLot.player.setName;
      const currentSetName = currentLot.player.setName || currentSetKey;

      let skippedCount = 0;
      const skippedPlayers = [];

      // Mark current player and all remaining unauctioned players in this set as SKIPPED
      for (let i = room.currentPlayerIndex; i < room.playersCatalog.length; i++) {
        const p = room.playersCatalog[i];
        const pSetKey = p.categorySet || p.setName;
        if (pSetKey === currentSetKey || p.setName === currentSetName) {
          if (p.status !== 'sold' && p.status !== 'unsold' && p.status !== 'SKIPPED') {
            p.status = 'SKIPPED';
            skippedCount++;
            skippedPlayers.push(p);

            const historyEntry = {
              lotNumber: p.overallLot || (i + 1),
              player: p,
              status: 'SKIPPED',
              winningFranchiseId: null,
              winningFranchiseName: null,
              finalBid: 0,
              bidsCount: 0,
              timestamp: new Date().toISOString()
            };
            room.history.unshift(historyEntry);
          }
        }
      }

      this.addAuditLog(
        room,
        'SET_SKIPPED',
        `Host skipped remaining players in set "${currentSetName}". (${skippedCount} player(s) marked as SKIPPED)`
      );

      // Find next player index with a different set that is still available
      let nextIdx = -1;
      for (let i = room.currentPlayerIndex; i < room.playersCatalog.length; i++) {
        const p = room.playersCatalog[i];
        if (p.status !== 'sold' && p.status !== 'unsold' && p.status !== 'SKIPPED') {
          nextIdx = i;
          break;
        }
      }

      this.saveToStorage();

      // Emit set_skipped event to all clients so UI updates immediately
      this.io.to(room.roomCode).emit('set_skipped', {
        skippedSetName: currentSetName,
        skippedCount,
        playersCatalog: room.playersCatalog,
        history: room.history
      });

      if (nextIdx === -1) {
        room.isSkippingSet = false;
        this.finishAuction(room);
        return {
          success: true,
          skippedSet: currentSetKey,
          skippedSetName: currentSetName,
          skippedCount,
          message: 'All sets completed. Auction concluded.'
        };
      } else {
        room.currentPlayerIndex = nextIdx - 1;
        room.isSkippingSet = false;
        this.nextPlayer(room);
        return {
          success: true,
          skippedSet: currentSetKey,
          skippedSetName: currentSetName,
          skippedCount
        };
      }
    } catch (err) {
      room.isSkippingSet = false;
      return { success: false, error: err.message };
    }
  }

  addAuditLog(room, type, message) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message
    };
    room.auditLog.unshift(entry);
    if (room.auditLog.length > 200) room.auditLog.pop();
  }

  broadcastRoomState(room, event = 'state_updated') {
    const publicState = this.getPublicRoomState(room);
    this.io.to(room.roomCode).emit(event, publicState);
  }

  getPublicRoomState(room) {
    return {
      roomCode: room.roomCode,
      status: room.status,
      hostName: room.hostName,
      config: room.config,
      franchises: room.franchises,
      playingXIConfigurations: room.playingXIConfigurations || {},
      currentLot: room.currentLot,
      lotNumber: room.currentLot?.lotNumber || 0,
      totalLots: room.playersCatalog.length,
      currentPlayerIndex: room.currentPlayerIndex,
      playersCatalog: room.playersCatalog,
      history: room.history,
      recentBids: room.allBids.slice(-15),
      auditLog: room.auditLog.slice(0, 30),
      evaluationResults: room.evaluationResults
    };
  }
}
