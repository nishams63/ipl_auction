import React, { useCallback, useState } from 'react';
import { useRoomSession } from './utils/useRoomSession';
import Navbar from './components/Navbar';
import LandingView from './components/LandingView';
import LobbyView from './components/LobbyView';
import LiveAuctionView from './components/LiveAuctionView';
import FinalResultsView from './components/FinalResultsView';
import FranchiseDashboardModal from './components/FranchiseDashboardModal';
import AuctionHistoryModal from './components/AuctionHistoryModal';
import CinematicAuctionOverlay from './components/CinematicAuctionOverlay';
import ConfirmDialog from './components/ConfirmDialog';
import { Loader2, WifiOff } from 'lucide-react';

export default function App() {
  const { state, controller, identity } = useRoomSession();
  const { room, participant, phase } = state;

  const [isSquadModalOpen, setIsSquadModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [inspectFranchiseId, setInspectFranchiseId] = useState(null);
  const [dismissedLot, setDismissedLot] = useState(null);
  const [confirm, setConfirm] = useState(null); // { title, body, confirmLabel, tone, onConfirm }
  const [toast, setToast] = useState(null);
  const [activeNavTab, setActiveNavTab] = useState('home');

  const showToast = useCallback((text, tone = 'error') => {
    setToast({ text, tone, id: Date.now() });
    setTimeout(() => setToast(t => (t && Date.now() - t.id >= 3900 ? null : t)), 4000);
  }, []);

  const inRoom = !!room && (phase === 'in_room' || phase === 'replaced');
  const myFranchise = inRoom && participant?.franchiseId ? room.franchises[participant.franchiseId] : null;

  const closeRoomUi = () => {
    setIsSquadModalOpen(false);
    setIsHistoryModalOpen(false);
    setInspectFranchiseId(null);
    setDismissedLot(null);
  };

  // ── room lifecycle ─────────────────────────────────────────
  const handleCreateRoom = ({ hostName, maxSquadSize, maxOverseas }) =>
    controller.createRoom({ hostName, maxSquadSize, maxOverseas }).then(() => closeRoomUi());
  const handleJoinRoom = ({ participantName, roomCode }) =>
    controller.joinRoom({ participantName, roomCode }).then(() => closeRoomUi());

  const requestLeave = () => setConfirm({
    title: 'Leave this room?',
    body: room?.status === 'active' || room?.status === 'paused'
      ? 'The auction keeps running. Your franchise stays yours and you can rejoin later with the room code on this device.'
      : 'You can rejoin later with the room code on this device. Your franchise selection is kept.',
    confirmLabel: 'Leave room',
    tone: 'danger',
    onConfirm: () => { closeRoomUi(); controller.leave(); }
  });

  const requestLogout = () => setConfirm({
    title: 'Sign out on this device?',
    body: 'This leaves the current room and forgets your name and device key. Rooms and results stay on the server, but this device will not be able to reclaim its franchises.',
    confirmLabel: 'Sign out',
    tone: 'danger',
    onConfirm: () => { closeRoomUi(); controller.logout(); }
  });

  // ── actions (server validates every one) ───────────────────
  const ack = (label) => (res) => { if (!res?.success) showToast(res?.errors?.join('\n') || res?.error || `${label} failed`); };
  const handleSelectFranchise = (franchiseId) => controller.emit('select_franchise', { franchiseId }, ack('Franchise selection'));
  const handleStartAuction = () => controller.emit('start_auction', {}, ack('Start auction'));
  const handleUpdateConfig = (config) => controller.emit('update_config', { config }, ack('Saving settings'));
  const handlePlaceBid = ({ franchiseId, bidAmount, expectedVersion }, callback) => {
    controller.emit('place_bid', { franchiseId, bidAmount, expectedVersion }, (res) => {
      if (!res?.success) controller.addActivity('rejected', `Your bid was rejected: ${res?.error || 'unknown reason'}`);
      callback?.(res);
    });
  };
  const handleAdvanceLot = () => controller.emit('advance_lot', {}, ack('Advance lot'));
  const handleSkipSet = (cb) => controller.emit('skip_set', {}, (res) => { ack('Skip set')(res); cb?.(res); });
  const handlePauseResume = () => controller.emit(room?.status === 'paused' ? 'resume_auction' : 'pause_auction', {}, ack('Pause/resume'));
  const handleFinishAuction = () => setConfirm({
    title: 'Conclude the auction?',
    body: 'The current lot is closed, remaining players are not auctioned and final standings are calculated for every franchise. This cannot be undone.',
    confirmLabel: 'Conclude auction',
    tone: 'danger',
    onConfirm: () => controller.emit('finish_auction', {}, ack('Finish auction'))
  });
  const handleRequestAiAnalysis = (force, callback) => controller.emit('request_ai_analysis', { force: !!force }, (res) => callback?.(res));
  const handleUpdatePlayingXI = (payload, callback) => controller.emit('update_playing_xi', payload, (res) => callback?.(res));

  const openSquadModal = (franchiseId) => {
    setInspectFranchiseId(franchiseId || myFranchise?.id || null);
    setIsSquadModalOpen(true);
  };

  const lastLot = state.lastLot && state.lastLot !== dismissedLot ? state.lastLot : null;
  const busy = phase === 'restoring';

  return (
    <div className="min-h-screen bg-[#050a1b] text-slate-100 flex flex-col selection:bg-amber-400 selection:text-slate-950">
      <Navbar
        room={inRoom ? room : null}
        participant={participant}
        myFranchise={myFranchise}
        playerName={identity?.name}
        link={state.link}
        onOpenSquad={() => openSquadModal(myFranchise?.id)}
        onOpenHistory={() => setIsHistoryModalOpen(true)}
        onLeaveRoom={requestLeave}
        onLogout={requestLogout}
        onNavigateTab={setActiveNavTab}
      />

      {phase === 'replaced' && (
        <div role="alert" className="bg-amber-500/15 border-b border-amber-500/40 text-amber-200 text-sm px-4 py-2 flex flex-wrap items-center justify-center gap-3">
          <span>This room was opened in another tab or window. This tab is paused and cannot bid.</span>
          <button className="font-bold underline" onClick={() => controller.takeOver()}>Use this tab</button>
          <button className="font-bold underline text-amber-300/80" onClick={() => controller.leave()}>Leave room here</button>
        </div>
      )}
      {inRoom && phase === 'in_room' && state.link === 'reconnecting' && (
        <div role="status" className="bg-slate-800/80 border-b border-slate-700 text-slate-200 text-xs px-4 py-1.5 flex items-center justify-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-amber-400" />
          <span>Connection lost — reconnecting to room {state.roomCode}…</span>
        </div>
      )}

      <main className="flex-1">
        {busy ? (
          <div className="max-w-md mx-auto px-4 py-28 text-center" data-testid="room-loading">
            <Loader2 className="w-10 h-10 text-amber-400 mx-auto animate-spin" />
            <p className="mt-4 text-slate-300 text-sm">
              {phase === 'restoring' ? `Reconnecting to room ${state.roomCode}…` : 'Opening room…'}
            </p>
            <button onClick={() => controller.leave()} className="mt-6 text-xs text-slate-400 underline hover:text-white">Cancel</button>
          </div>
        ) : !inRoom ? (
          <LandingView
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
            activeSection={activeNavTab}
            onCloseSection={() => setActiveNavTab('home')}
            onCancelPending={() => controller.leave()}
            defaultName={identity?.name || ''}
            resumeRoomCode={controller.store.getUserSession().lastRoom}
            notice={state.notice}
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
            onBackToLobby={() => { closeRoomUi(); controller.leave(); }}
            onRequestAiAnalysis={handleRequestAiAnalysis}
          />
        ) : (
          <LiveAuctionView
            room={room}
            participant={participant}
            myFranchise={myFranchise}
            activity={state.activity}
            link={state.link}
            canAct={phase === 'in_room'}
            onPlaceBid={handlePlaceBid}
            onAdvanceLot={handleAdvanceLot}
            onSkipSet={handleSkipSet}
            onPauseResume={handlePauseResume}
            onFinishAuction={handleFinishAuction}
            onOpenSquad={openSquadModal}
          />
        )}
      </main>

      {inRoom && (
        <CinematicAuctionOverlay eventData={lastLot} onDismiss={() => setDismissedLot(state.lastLot)} />
      )}

      {inRoom && (
        <>
          <FranchiseDashboardModal
            room={room}
            isOpen={isSquadModalOpen}
            onClose={() => setIsSquadModalOpen(false)}
            initialFranchiseId={inspectFranchiseId || myFranchise?.id}
            myFranchise={myFranchise}
            participant={participant}
            onUpdatePlayingXI={handleUpdatePlayingXI}
          />
          <AuctionHistoryModal room={room} isOpen={isHistoryModalOpen} onClose={() => setIsHistoryModalOpen(false)} />
        </>
      )}

      <ConfirmDialog
        open={!!confirm}
        {...(confirm || {})}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const fn = confirm?.onConfirm; setConfirm(null); fn?.(); }}
      />

      {toast && (
        <div role="alert" className={`fixed z-[70] left-1/2 -translate-x-1/2 bottom-24 lg:bottom-6 max-w-[92vw] px-4 py-2.5 rounded-xl text-sm shadow-2xl border ${
          toast.tone === 'error' ? 'bg-red-950/95 border-red-500/50 text-red-100' : 'bg-slate-900/95 border-slate-600 text-slate-100'
        }`}>
          {toast.text}
        </div>
      )}

      <footer className="border-t border-slate-900 bg-[#040814] py-6 px-4 text-center text-xs text-slate-500">
        IPL Multiplayer Real-Time Auction Simulator • 409 Verified Candidate Players • Server-Authoritative Engine
      </footer>
    </div>
  );
}
