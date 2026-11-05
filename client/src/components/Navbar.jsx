import React, { useState } from 'react';
import { Volume2, VolumeX, Shield, Users, Trophy, Layers, PlayCircle, History, Home, User, Gavel, BarChart2, Radio } from 'lucide-react';
import { isSoundEnabled, setSoundEnabled } from '../utils/audio';

export default function Navbar({
  room,
  participant,
  myFranchise,
  onOpenSquad,
  onOpenHistory,
  onOpenHostControls,
  onNavigateTab
}) {
  const [sound, setSound] = useState(isSoundEnabled());
  const [activeTab, setActiveTab] = useState(room ? 'auction' : 'home');

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
  };

  const handleTabClick = (tab) => {
    setActiveTab(tab);
    if (tab === 'squads' && onOpenSquad) {
      onOpenSquad();
    } else if (tab === 'history' && onOpenHistory) {
      onOpenHistory();
    } else if (onNavigateTab) {
      onNavigateTab(tab);
    }
  };

  return (
    <header className="sticky top-0 z-50 bg-[#050b25]/95 backdrop-blur-xl border-b border-white/10 px-4 lg:px-8 py-2.5">
      <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-4">
        {/* Brand Logo & Name */}
        <div 
          onClick={() => handleTabClick('lobby')}
          className="flex items-center gap-2.5 cursor-pointer group select-none flex-shrink-0"
        >
          {/* Batsman Silhouette Badge */}
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 via-amber-500 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-slate-950 font-black" aria-hidden="true">
              <path d="M14.5 2a2.5 2.5 0 0 0-2.45 2.05l-4.5 4.5 1.41 1.41 3.54-3.54V11h2V4.5A2.5 2.5 0 0 0 14.5 2M7.05 9.95L2 15l7 7 5.05-5.05-7-7M5.5 16.5l3.5 3.5-1.5 1.5-3.5-3.5 1.5-1.5z"/>
            </svg>
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="font-black text-xl tracking-tight text-white leading-none">
                IPL
              </span>
              <span className="font-bold text-[11px] uppercase tracking-[0.2em] text-slate-300 leading-none">
                AUCTION
              </span>
            </div>
            <span className="font-extrabold text-[9px] uppercase tracking-[0.28em] text-amber-400 leading-none mt-0.5">
              SIMULATOR
            </span>
          </div>
        </div>

        {/* Center Navigation Links (Matching Reference Image) */}
        {room ? (
          <nav className="hidden md:flex items-center gap-2 bg-[#091130] p-1.5 rounded-full border border-white/10 shadow-inner">
            <button
              onClick={() => handleTabClick('lobby')}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
                room.status === 'lobby'
                  ? 'border border-amber-400 bg-amber-500/20 text-amber-300 shadow-sm'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <Home className="w-3.5 h-3.5" />
              <span>Lobby</span>
            </button>

            <button
              onClick={() => handleTabClick('auction')}
              className={`px-5 py-1.5 rounded-full text-xs font-black transition flex items-center gap-1.5 cursor-pointer border ${
                room.status === 'active' || room.status === 'paused'
                  ? 'border-amber-400 bg-gradient-to-r from-amber-500/25 via-yellow-500/20 to-amber-500/10 text-amber-300 shadow-md shadow-amber-500/20 ring-1 ring-amber-400/40'
                  : 'border-transparent text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <Gavel className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
              <span>Auction</span>
            </button>

            <button
              onClick={() => handleTabClick('squads')}
              className="px-4 py-1.5 rounded-full text-xs font-bold text-slate-300 hover:text-white hover:bg-white/5 transition flex items-center gap-1.5 cursor-pointer"
            >
              <Users className="w-3.5 h-3.5 text-blue-400" />
              <span>Squads</span>
            </button>

            <button
              onClick={() => handleTabClick('history')}
              className="px-4 py-1.5 rounded-full text-xs font-bold text-slate-300 hover:text-white hover:bg-white/5 transition flex items-center gap-1.5 cursor-pointer"
            >
              <History className="w-3.5 h-3.5 text-purple-400" />
              <span>History</span>
            </button>

            <button
              onClick={() => handleTabClick('squads')}
              className="px-4 py-1.5 rounded-full text-xs font-bold text-slate-300 hover:text-white hover:bg-white/5 transition flex items-center gap-1.5 cursor-pointer"
            >
              <BarChart2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Analytics</span>
            </button>
          </nav>
        ) : (
          <nav className="hidden md:flex items-center gap-1.5 bg-slate-950/40 p-1 rounded-full border border-white/10 shadow-inner">
            <button
              onClick={() => handleTabClick('home')}
              className="px-4 py-1.5 rounded-full text-xs font-bold transition flex items-center gap-1.5 border-glow-gold bg-gradient-to-r from-amber-500/20 to-yellow-500/10 text-amber-300"
            >
              <Home className="w-3.5 h-3.5 text-amber-400" />
              <span>Home</span>
            </button>
          </nav>
        )}

        {/* Right Action Icons & Controls (Reference Image Design) */}
        <div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
          {/* Quick mobile buttons for Squads & History when in room */}
          {room && (
            <div className="flex md:hidden items-center gap-1">
              <button
                onClick={() => onOpenSquad && onOpenSquad()}
                className="p-1.5 rounded-lg bg-blue-500/20 text-blue-300 border border-blue-400/30 text-xs font-bold"
                title="Squads & Teams"
              >
                <Users className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onOpenHistory && onOpenHistory()}
                className="p-1.5 rounded-lg bg-purple-500/20 text-purple-300 border border-purple-400/30 text-xs font-bold"
                title="Auction History"
              >
                <History className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Live Auction Red Pill Indicator */}
          {room && (
            <div className="hidden sm:flex items-center gap-1.5 bg-red-600/90 text-white font-black text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1 sm:py-1.5 rounded-full shadow-lg shadow-red-600/30 border border-red-400/40 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-white" />
              <span>LIVE</span>
            </div>
          )}

          {/* Sound Toggle (Circular Pill) */}
          <button
            onClick={toggleSound}
            className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-[#0a1437] hover:bg-slate-800 border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition shadow cursor-pointer"
            title={sound ? "Mute Sound Effects" : "Enable Sound Effects"}
          >
            {sound ? <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" /> : <VolumeX className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500" />}
          </button>

          {/* User Profile Avatar (Blue Glowing Pill) */}
          <div
            className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 border border-blue-400/50 text-white flex items-center justify-center font-bold text-xs shadow-md shadow-blue-500/30 select-none cursor-pointer"
            title={participant?.name || "Player Profile"}
          >
            <User className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />
          </div>
        </div>
      </div>
    </header>
  );
}
