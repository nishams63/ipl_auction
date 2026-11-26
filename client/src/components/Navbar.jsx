import React, { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, Users, History, User, LogOut, DoorOpen, Copy, Check, Wifi, WifiOff, Home, HelpCircle, Shield } from 'lucide-react';
import { isSoundEnabled, setSoundEnabled } from '../utils/audio';

const STATUS_LABEL = { lobby: 'LOBBY', active: 'LIVE', paused: 'PAUSED', completed: 'RESULTS' };

export default function Navbar({
  room,
  participant,
  myFranchise,
  playerName,
  link = 'offline',
  onOpenSquad,
  onOpenHistory,
  onLeaveRoom,
  onLogout,
  onNavigateTab
}) {
  const [sound, setSound] = useState(isSoundEnabled());
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
  };

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(room.roomCode); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard unavailable */ }
  };

  const displayName = participant?.name || playerName || '';
  const status = room ? STATUS_LABEL[room.status] || room.status?.toUpperCase() : null;
  const live = room?.status === 'active';

  return (
    <header className="sticky top-0 z-50 bg-[#050b25]/95 backdrop-blur-xl border-b border-white/10 px-3 sm:px-4 lg:px-8 py-2.5">
      <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-2 sm:gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2.5 select-none flex-shrink-0 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 via-amber-500 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/20 flex-shrink-0">
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-slate-950" aria-hidden="true">
              <path d="M14.5 2a2.5 2.5 0 0 0-2.45 2.05l-4.5 4.5 1.41 1.41 3.54-3.54V11h2V4.5A2.5 2.5 0 0 0 14.5 2M7.05 9.95L2 15l7 7 5.05-5.05-7-7M5.5 16.5l3.5 3.5-1.5 1.5-3.5-3.5 1.5-1.5z"/>
            </svg>
          </div>
          <div className="hidden sm:flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="font-black text-xl tracking-tight text-white leading-none">IPL</span>
              <span className="font-bold text-[11px] uppercase tracking-[0.2em] text-slate-300 leading-none">AUCTION</span>
            </div>
            <span className="font-extrabold text-[9px] uppercase tracking-[0.28em] text-amber-400 leading-none mt-0.5">SIMULATOR</span>
          </div>
        </div>

        {/* Center: room identity */}
        {room ? (
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <button
              onClick={copyCode}
              className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/40 px-2.5 sm:px-3 py-1.5 rounded-xl text-amber-300 font-bold text-xs"
              title="Copy room code"
              aria-label={`Room code ${room.roomCode}, copy`}
              data-testid="nav-room-code"
            >
              <span className="hidden sm:inline text-amber-400/80 text-[11px]">Room</span>
              <span className="font-mono tracking-wider font-extrabold">{room.roomCode}</span>
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <span className={`hidden sm:flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider px-2.5 py-1.5 rounded-xl border ${
              live ? 'bg-red-600/90 text-white border-red-400/40' : room.status === 'paused' ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'bg-slate-800 text-slate-300 border-slate-700'
            }`}>
              {live && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
              {status}
            </span>
            <span
              className={`flex items-center gap-1 text-[10px] font-bold px-2 py-1.5 rounded-xl border ${link === 'online' ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-300 border-amber-500/30 bg-amber-500/10'}`}
              title={link === 'online' ? 'Connected' : 'Reconnecting'}
              aria-label={link === 'online' ? 'Connected' : 'Reconnecting'}
              data-testid="nav-link-status"
            >
              {link === 'online' ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              <span className="hidden lg:inline">{link === 'online' ? 'Connected' : 'Reconnecting'}</span>
            </span>
          </div>
        ) : (
          <nav className="hidden md:flex items-center gap-1.5 bg-slate-950/40 p-1 rounded-full border border-white/10">
            <button onClick={() => onNavigateTab?.('home')} className="px-4 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 bg-gradient-to-r from-amber-500/20 to-yellow-500/10 text-amber-300">
              <Home className="w-3.5 h-3.5" /> Home
            </button>
            <button onClick={() => onNavigateTab?.('teams')} className="px-4 py-1.5 rounded-full text-xs font-bold text-slate-300 hover:text-white flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" /> Teams
            </button>
            <button onClick={() => onNavigateTab?.('how-it-works')} className="px-4 py-1.5 rounded-full text-xs font-bold text-slate-300 hover:text-white flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5" /> How it works
            </button>
          </nav>
        )}

        {/* Right controls */}
        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          {room && (
            <>
              <button onClick={onOpenSquad} className="w-9 h-9 sm:w-auto sm:px-3 rounded-xl bg-blue-500/15 text-blue-200 border border-blue-400/30 text-xs font-bold flex items-center justify-center gap-1.5" title="Squads & Playing XI" aria-label="Squads">
                <Users className="w-4 h-4" /><span className="hidden lg:inline">Squads</span>
              </button>
              <button onClick={onOpenHistory} className="w-9 h-9 sm:w-auto sm:px-3 rounded-xl bg-purple-500/15 text-purple-200 border border-purple-400/30 text-xs font-bold flex items-center justify-center gap-1.5" title="Auction history" aria-label="History">
                <History className="w-4 h-4" /><span className="hidden lg:inline">History</span>
              </button>
            </>
          )}

          <button
            onClick={toggleSound}
            className="w-9 h-9 rounded-full bg-[#0a1437] hover:bg-slate-800 border border-white/15 text-slate-300 hover:text-white flex items-center justify-center"
            title={sound ? 'Mute sound effects' : 'Enable sound effects'}
            aria-label={sound ? 'Mute sound effects' : 'Enable sound effects'}
          >
            {sound ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4 text-slate-500" />}
          </button>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              className="h-9 pl-1 pr-1 sm:pr-3 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 border border-blue-400/50 text-white flex items-center gap-2 font-bold text-xs"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Account menu"
              data-testid="account-menu"
            >
              <span className="w-7 h-7 rounded-full bg-white/15 flex items-center justify-center">
                <User className="w-4 h-4" />
              </span>
              {displayName && <span className="hidden sm:inline max-w-[110px] truncate">{displayName}</span>}
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 mt-2 w-60 rounded-2xl bg-[#0a1230] border border-slate-700 shadow-2xl p-2 text-sm">
                <div className="px-3 py-2 border-b border-slate-800 mb-1">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Signed in as</div>
                  <div className="font-bold text-white truncate">{displayName || 'Guest (no name yet)'}</div>
                  {myFranchise && <div className="text-xs text-amber-300 mt-0.5">{myFranchise.name}</div>}
                  {participant?.isHost && <div className="text-[10px] text-emerald-400 font-bold mt-0.5">ROOM HOST</div>}
                </div>
                {room && (
                  <button role="menuitem" onClick={() => { setMenuOpen(false); onLeaveRoom?.(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-slate-200 hover:bg-slate-800" data-testid="leave-room">
                    <DoorOpen className="w-4 h-4 text-amber-400" /> Leave room
                  </button>
                )}
                <button role="menuitem" onClick={() => { setMenuOpen(false); onLogout?.(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-red-300 hover:bg-red-500/10" data-testid="sign-out">
                  <LogOut className="w-4 h-4" /> Sign out on this device
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
