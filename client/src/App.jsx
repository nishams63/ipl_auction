import React, { useState, useEffect, useRef } from 'react';
import { socket, getUserSession, saveUserSession, SERVER_URL } from './utils/socket';
import { playGavel, playBidPing, playSoldFanfare, playUnsold } from './utils/audio';
import Navbar from './components/Navbar';
import LandingView from './components/LandingView';
import LobbyView from './components/LobbyView';
import LiveAuctionView from './components/LiveAuctionView';
import FinalResultsView from './components/FinalResultsView';
import FranchiseDashboardModal from './components/FranchiseDashboardModal';
import AuctionHistoryModal from './components/AuctionHistoryModal';
import CinematicAuctionOverlay from './components/CinematicAuctionOverlay';


export default function App() {
  const [session, setSession] = useState(getUserSession());
  const [room, setRoom] = useState(null);
  const [participant, setParticipant] = useState(null);
  const [isSquadModalOpen, setIsSquadModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [inspectFranchiseId, setInspectFranchiseId] = useState(null);
  const [completedLotEvent, setCompletedLotEvent] = useState(null);
  const [sessionReplaced, setSessionReplaced] = useState(false);

  // Latest values for socket handlers registered once
  const sessionRef = useRef(session);
  const participantRef = useRef(participant);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { participantRef.current = participant; }, [participant]);

  // (Re)join the stored room on every socket connect: first load, and after any
  // network drop / server restart, since a new socket is not in the room channel.
  useEffect(() => {
    const rejoin = () => {
      const s = sessionRef.current;
      if (!s.lastRoom || !s.name) return;
      socket.emit('join_room', {
        roomCode: s.lastRoom,
        participantName: s.name,
        participantToken: s.token
      }, (res) => {
        if (res?.success) {
          setSessionReplaced(false);
          setRoom(res.room);
          setParticipant(res.participant);
        }
      });
    };
    socket.on('connect', rejoin);
    if (socket.connected) rejoin();
    const onReplaced = () => setSessionReplaced(true);
    socket.on('session_replaced', onReplaced);
    return () => {
      socket.off('connect', rejoin);
      socket.off('session_replaced', onReplaced);
    };
  }, []);

  // Listen to server socket events
  useEffect(() => {
    socket.on('state_updated', (updatedRoom) => {
      setRoom(updatedRoom);
      // Synchronize my franchise via my public id (tokens are never broadcast)
      const me = participantRef.current;
      if (updatedRoom && me?.publicId) {
        const found = Object.values(updatedRoom.franchises).find(f => f.ownerId === me.publicId);
        setParticipant(prev => prev ? { ...prev, franchiseId: found ? found.id : null } : prev);
      }
    });

    socket.on('lot_presented', (updatedRoom) => {
      setRoom(updatedRoom);
      setCompletedLotEvent(null);
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

    socket.on('lot_completed', (data) => {
      const { result, lot, historyEntry, franchises, playersCatalog } = data;
      setCompletedLotEvent(data);
      if (result === 'SOLD') {
        playSoldFanfare();
      } else {
        playUnsold();
      }
      setRoom(prev => {
        if (!prev) return prev;
        const updatedCatalog = playersCatalog || (prev.playersCatalog || []).map(p => {
          if (p.id === lot?.player?.id) {
            return {
              ...p,
              status: result === 'SOLD' ? 'sold' : 'unsold',
              soldTo: result === 'SOLD' ? (lot.highestBidderFranchiseId || historyEntry?.winningFranchiseCode) : null,
              soldPrice: result === 'SOLD' ? lot.highestBid : 0
            };
          }
          return p;
        });
        return {
          ...prev,
          currentLot: lot,
          franchises,
          playersCatalog: updatedCatalog,
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

    // Post-auction: the AI analysis started, finished or failed (scores never change)
    socket.on('analysis_updated', (updatedRoom) => {
      setRoom(updatedRoom);
    });

    socket.on('set_skipped', (data) => {
      setRoom(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          playersCatalog: data.playersCatalog || prev.playersCatalog,
          history: data.history || prev.history
        };
      });
    });

    return () => {
      socket.off('state_updated');
      socket.off('lot_presented');
      socket.off('bid_accepted');
      socket.off('lot_completed');
      socket.off('timer_tick');
      socket.off('auction_completed');
      socket.off('analysis_updated');
      socket.off('set_skipped');
    };
  }, [session.token]);

  // Actions
  const handleCreateRoom = async ({ hostName, basePurse }) => {
    const createReq = () => fetch(`${SERVER_URL}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostName,
        hostToken: session.token,
        config: { basePurse }
      })
    });

    let res;
    try {
      res = await createReq();
    } catch (firstErr) {
      // Free-tier Render instances sleep after inactivity and take ~50s to wake up.
      // If the edge dropped the first preflight while booting, wait 3 seconds and retry once.
      console.warn("First create room request failed, retrying in 3s...", firstErr);
      await new Promise(r => setTimeout(r, 3000));
      try {
        res = await createReq();
      } catch (secondErr) {
        console.error("Second create room request failed:", secondErr);
        throw new Error(
          "Unable to reach the backend server. The free-tier server on Render may be waking up from sleep (~50s). Please wait a few seconds and try again."
        );
      }
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = data.errors?.join('\n') || data.error || `Server error (${res.status})`;
      throw new Error(msg);
    }
    const data = await res.json();
    if (data.roomCode) {
      saveUserSession({ name: hostName, roomCode: data.roomCode });
      setSession(prev => ({ ...prev, name: hostName, lastRoom: data.roomCode }));

      if (!socket.connected) socket.connect();
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
  };

  const handleJoinRoom = ({ participantName, roomCode }) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Join request timed out. The backend server may be waking up. Please retry in a moment."));
      }, 15000);

      if (!socket.connected) socket.connect();
      socket.emit('join_room', {
        roomCode,
        participantName,
        participantToken: session.token
      }, (res) => {
        clearTimeout(timer);
        if (res?.success) {
          saveUserSession({ name: participantName, roomCode });
          setSession(prev => ({ ...prev, name: participantName, lastRoom: roomCode }));
          setRoom(res.room);
          setParticipant(res.participant);
          resolve();
        } else {
          reject(new Error(res?.error || "Could not join room"));
        }
      });
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
    }, (res) => {
      if (!res?.success) {
        alert(res?.errors?.join('\n') || res?.error || 'Settings were not saved');
      }
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

  // Ask the server for AI reports (server-side; the browser never sees an API key)
  const handleRequestAiAnalysis = (force, callback) => {
    if (!room) return;
    socket.emit('request_ai_analysis', { roomCode: room.roomCode, force: !!force }, (res) => {
      if (callback) callback(res);
    });
  };

  const handleSkipSet = () => {
    if (!room) return;
    socket.emit('skip_set', {
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

  const [activeNavTab, setActiveNavTab] = useState('home');

  const myFranchise = room && participant?.franchiseId
    ? room.franchises[participant.franchiseId]
    : (room && participant?.publicId && Object.values(room.franchises).find(f => f.ownerId === participant.publicId));

  const openSquadModal = (franchiseId) => {
    setInspectFranchiseId(franchiseId || myFranchise?.id);
    setIsSquadModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-[#050a1b] text-slate-100 flex flex-col selection:bg-amber-400 selection:text-slate-950">
      <Navbar
        room={room}
        participant={participant}
        myFranchise={myFranchise}
        onOpenSquad={() => openSquadModal(myFranchise?.id)}
        onOpenHistory={() => setIsHistoryModalOpen(true)}
        onOpenHostControls={() => {}}
        onNavigateTab={(tab) => {
          setActiveNavTab(tab);
          if (tab === 'home' && room) {
            // Optional: don't leave room, but can show toast or keep state
          }
        }}
      />

      {sessionReplaced && (
        <div role="alert" className="bg-amber-500/15 border-b border-amber-500/40 text-amber-200 text-sm px-4 py-2 flex items-center justify-center gap-3">
          <span>This room was opened in another tab or device. This tab can no longer bid.</span>
          <button
            className="font-bold underline"
            onClick={() => {
              const s = sessionRef.current;
              socket.emit('join_room', { roomCode: s.lastRoom, participantName: s.name, participantToken: s.token }, (res) => {
                if (res?.success) { setSessionReplaced(false); setRoom(res.room); setParticipant(res.participant); }
              });
            }}
          >
            Use this tab
          </button>
        </div>
      )}

      <main className="flex-1">
        {!room ? (
          <LandingView
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
            activeSection={activeNavTab}
            onCloseSection={() => setActiveNavTab('home')}
          />
        ) : room.status === 'lobby' ? (
          <LobbyView
            room={room}
            participant={participant}
            onSelectFranchise={handleSelectFranchise}
            onStartAuction={handleStartAuction}
            onUpdateConfig={handleUpdateConfig}
            onOpenSquad={openSquadModal}
          />
        ) : room.status === 'completed' ? (
          <FinalResultsView
            room={room}
            participant={participant}
            onInspectSquad={openSquadModal}
            onBackToLobby={() => setRoom(null)}
            onRequestAiAnalysis={handleRequestAiAnalysis}
          />
        ) : (
          <LiveAuctionView
            room={room}
            participant={participant}
            myFranchise={myFranchise}
            onPlaceBid={handlePlaceBid}
            onAdvanceLot={handleAdvanceLot}
            onSkipSet={handleSkipSet}
            onPauseResume={handlePauseResume}
            onFinishAuction={handleFinishAuction}
            onOpenSquad={() => openSquadModal(myFranchise?.id)}
          />
        )}
      </main>

      {/* Modals & Overlays */}


      <CinematicAuctionOverlay
        eventData={completedLotEvent}
        onDismiss={() => setCompletedLotEvent(null)}
      />

      {room && (
        <>
          <FranchiseDashboardModal
            room={room}
            isOpen={isSquadModalOpen}
            onClose={() => setIsSquadModalOpen(false)}
            initialFranchiseId={inspectFranchiseId || myFranchise?.id}
            myFranchise={myFranchise}
            participant={participant}
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
        IPL Multiplayer Real-Time Auction Simulator • 409 Verified Candidate Players • Server-Authoritative Engine
      </footer>
    </div>
  );
}
