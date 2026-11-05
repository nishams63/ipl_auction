import React, { useState, useEffect } from 'react';
import { socket, getUserSession, saveUserSession } from './utils/socket';
import { playGavel, playBidPing, playSoldFanfare, playUnsold } from './utils/audio';
import Navbar from './components/Navbar';
import LandingView from './components/LandingView';
import LobbyView from './components/LobbyView';
import LiveAuctionView from './components/LiveAuctionView';
import FinalResultsView from './components/FinalResultsView';
import FranchiseDashboardModal from './components/FranchiseDashboardModal';
import AuctionHistoryModal from './components/AuctionHistoryModal';

export default function App() {
  const [session, setSession] = useState(getUserSession());
  const [room, setRoom] = useState(null);
  const [participant, setParticipant] = useState(null);
  const [isSquadModalOpen, setIsSquadModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [inspectFranchiseId, setInspectFranchiseId] = useState(null);

  // Auto reconnect to room if stored in session
  useEffect(() => {
    if (session.lastRoom && session.name) {
      socket.emit('join_room', {
        roomCode: session.lastRoom,
        participantName: session.name,
        participantToken: session.token
      }, (res) => {
        if (res?.success) {
          setRoom(res.room);
          setParticipant(res.participant);
        }
      });
    }
  }, []);

  // Listen to server socket events
  useEffect(() => {
    socket.on('state_updated', (updatedRoom) => {
      setRoom(updatedRoom);
      // Synchronize my participant state
      if (updatedRoom && session.token) {
        const found = Object.values(updatedRoom.franchises).find(f => f.ownerToken === session.token);
        if (found) {
          setParticipant(prev => prev ? { ...prev, franchiseId: found.id } : null);
        }
      }
    });

    socket.on('lot_presented', (updatedRoom) => {
      setRoom(updatedRoom);
      playGavel();
    });

    socket.on('bid_accepted', ({ bid, currentLot, nextValidBid, franchises }) => {
      playBidPing();
      setRoom(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          currentLot,
          franchises,
          recentBids: [...(prev.recentBids || []), bid].slice(-15)
        };
      });
    });

    socket.on('lot_completed', ({ result, lot, historyEntry, franchises }) => {
      if (result === 'SOLD') {
        playSoldFanfare();
      } else {
        playUnsold();
      }
      setRoom(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          currentLot: lot,
          franchises,
          history: [historyEntry, ...(prev.history || [])]
        };
      });
    });

    socket.on('timer_tick', ({ countdown, hammerStatus, stateVersion }) => {
      setRoom(prev => {
        if (!prev || !prev.currentLot) return prev;
        return {
          ...prev,
          currentLot: {
            ...prev.currentLot,
            countdown,
            hammerStatus,
            stateVersion
          }
        };
      });
    });

    socket.on('auction_completed', (updatedRoom) => {
      setRoom(updatedRoom);
    });

    return () => {
      socket.off('state_updated');
      socket.off('lot_presented');
      socket.off('bid_accepted');
      socket.off('lot_completed');
      socket.off('timer_tick');
      socket.off('auction_completed');
    };
  }, [session.token]);

  // Actions
  const handleCreateRoom = async ({ hostName, basePurse }) => {
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostName,
          hostToken: session.token,
          config: { basePurse }
        })
      });
      const data = await res.json();
      if (data.roomCode) {
        saveUserSession({ name: hostName, roomCode: data.roomCode });
        setSession(prev => ({ ...prev, name: hostName, lastRoom: data.roomCode }));

        socket.emit('join_room', {
          roomCode: data.roomCode,
          participantName: hostName,
          participantToken: session.token
        }, (joinRes) => {
          if (joinRes?.success) {
            setRoom(joinRes.room);
            setParticipant(joinRes.participant);
          }
        });
      }
    } catch (err) {
      console.error("Room creation error:", err);
    }
  };

  const handleJoinRoom = ({ participantName, roomCode }) => {
    socket.emit('join_room', {
      roomCode,
      participantName,
      participantToken: session.token
    }, (res) => {
      if (res?.success) {
        saveUserSession({ name: participantName, roomCode });
        setSession(prev => ({ ...prev, name: participantName, lastRoom: roomCode }));
        setRoom(res.room);
        setParticipant(res.participant);
      } else {
        alert(res?.error || "Could not join room");
      }
    });
  };

  const handleSelectFranchise = (franchiseId) => {
    if (!room) return;
    socket.emit('select_franchise', {
      roomCode: room.roomCode,
      participantToken: session.token,
      franchiseId
    }, (res) => {
      if (!res?.success) {
        alert(res?.error || "Could not select franchise");
      }
    });
  };

  const handleStartAuction = () => {
    if (!room) return;
    socket.emit('start_auction', {
      roomCode: room.roomCode,
      hostToken: session.token
    }, (res) => {
      if (!res?.success) {
        alert(res?.error || "Could not start auction");
      }
    });
  };

  const handleUpdateConfig = (config) => {
    if (!room) return;
    socket.emit('update_config', {
      roomCode: room.roomCode,
      hostToken: session.token,
      config
    });
  };

  const handlePlaceBid = ({ franchiseId, bidAmount, expectedVersion }, callback) => {
    if (!room) return;
    socket.emit('place_bid', {
      roomCode: room.roomCode,
      participantToken: session.token,
      franchiseId,
      bidAmount,
      expectedVersion
    }, callback);
  };

  const handleAdvanceLot = () => {
    if (!room) return;
    socket.emit('advance_lot', {
      roomCode: room.roomCode,
      hostToken: session.token
    });
  };

  const handlePauseResume = () => {
    if (!room) return;
    if (room.status === 'paused') {
      socket.emit('resume_auction', {
        roomCode: room.roomCode,
        hostToken: session.token
      });
    } else {
      socket.emit('pause_auction', {
        roomCode: room.roomCode,
        hostToken: session.token
      });
    }
  };

  const handleFinishAuction = () => {
    if (!room) return;
    if (window.confirm("Are you sure you want to conclude the auction and calculate final standings?")) {
      socket.emit('finish_auction', {
        roomCode: room.roomCode,
        hostToken: session.token
      });
    }
  };

  const myFranchise = room && participant?.franchiseId
    ? room.franchises[participant.franchiseId]
    : (room && Object.values(room.franchises).find(f => f.ownerToken === session.token));

  const openSquadModal = (franchiseId) => {
    setInspectFranchiseId(franchiseId || myFranchise?.id);
    setIsSquadModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-[#050a18] text-slate-100 flex flex-col selection:bg-amber-500 selection:text-slate-950">
      <Navbar
        room={room}
        participant={participant}
        myFranchise={myFranchise}
        onOpenSquad={() => openSquadModal(myFranchise?.id)}
        onOpenHistory={() => setIsHistoryModalOpen(true)}
        onOpenHostControls={() => {}}
      />

      <main className="flex-1">
        {!room ? (
          <LandingView
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
          />
        ) : room.status === 'lobby' ? (
          <LobbyView
            room={room}
            participant={participant}
            onSelectFranchise={handleSelectFranchise}
            onStartAuction={handleStartAuction}
            onUpdateConfig={handleUpdateConfig}
          />
        ) : room.status === 'completed' ? (
          <FinalResultsView
            room={room}
            onInspectSquad={openSquadModal}
            onBackToLobby={() => setRoom(null)}
          />
        ) : (
          <LiveAuctionView
            room={room}
            participant={participant}
            myFranchise={myFranchise}
            onPlaceBid={handlePlaceBid}
            onAdvanceLot={handleAdvanceLot}
            onPauseResume={handlePauseResume}
            onFinishAuction={handleFinishAuction}
            onOpenSquad={() => openSquadModal(myFranchise?.id)}
          />
        )}
      </main>

      {/* Modals */}
      {room && (
        <>
          <FranchiseDashboardModal
            room={room}
            isOpen={isSquadModalOpen}
            onClose={() => setIsSquadModalOpen(false)}
            initialFranchiseId={inspectFranchiseId || myFranchise?.id}
          />

          <AuctionHistoryModal
            room={room}
            isOpen={isHistoryModalOpen}
            onClose={() => setIsHistoryModalOpen(false)}
          />
        </>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-[#040814] py-6 px-4 text-center text-xs text-slate-500">
        IPL Multiplayer Real-Time Auction Simulator • 290 Verified Candidate Players • Server-Authoritative Engine
      </footer>
    </div>
  );
}
