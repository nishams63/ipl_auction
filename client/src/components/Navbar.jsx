import React, { useState } from 'react';
import { Volume2, VolumeX, Shield, Users, Trophy, Layers, PlayCircle, History, Home, User } from 'lucide-react';
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
  const [activeTab, setActiveTab] = useState('home');

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
  };

  const handleTabClick = (tab) => {
    setActiveTab(tab);
    if (onNavigateTab) {
      onNavigateTab(tab);
    }
  };

  return (
    <header className="sticky top-0 z-50 bg-[#060b1e]/90 backdrop-blur-xl border-b border-white/10 px-4 lg:px-8 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        {/* Brand Logo & Name */}
        <div 
          onClick={() => handleTabClick('home')}
          className="flex items-center gap-2.5 cursor-pointer group select-none"
        >
          {/* Batsman SVG Silhouette Badge */}
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-400 via-amber-500 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
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

          {room && (
            <div className="hidden sm:flex items-center gap-2 ml-4 pl-4 border-l border-white/15 text-xs text-slate-300">
              <span className="bg-amber-500/15 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full font-mono font-bold tracking-wider">
                {room.roomCode}
              </span>
              <span className="text-[11px] text-slate-400 capitalize">
                {room.status === 'active' ? '🔴 Live Bidding' : room.status}
              </span>
            </div>
          )}
        </div>

        {/* Center Navigation Links (Reference Image Design) */}
        {!room ? (
          <nav className="hidden md:flex items-center gap-1.5 bg-slate-950/40 p-1 rounded-full border border-white/10 shadow-inner">
            <button
              onClick={() => handleTabClick('home')}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'home'
                  ? 'border-glow-gold bg-gradient-to-r from-amber-500/20 to-yellow-500/10 text-amber-300'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <Home className="w-3.5 h-3.5 text-amber-400" />
              <span>Home</span>
            </button>

            <button
              onClick={() => handleTabClick('features')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'features'
                  ? 'border-glow-gold bg-amber-500/20 text-amber-300'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-slate-400" />
              <span>Features</span>
            </button>

            <button
              onClick={() => handleTabClick('how-it-works')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'how-it-works'
                  ? 'border-glow-gold bg-amber-500/20 text-amber-300'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <PlayCircle className="w-3.5 h-3.5 text-slate-400" />
              <span>How It Works</span>
            </button>

            <button
              onClick={() => handleTabClick('teams')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'teams'
                  ? 'border-glow-gold bg-amber-500/20 text-amber-300'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <Trophy className="w-3.5 h-3.5 text-slate-400" />
              <span>Teams</span>
            </button>
          </nav>
        ) : (
          /* When in an active room, show franchise badge */
          myFranchise && (
            <div
              onClick={onOpenSquad}
              className="hidden md:flex items-center gap-2.5 px-4 py-1.5 rounded-full border border-white/15 bg-slate-900/80 hover:border-amber-400/50 cursor-pointer transition shadow-lg"
              title="Click to view full squad dashboard"
            >
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center font-black text-[10px] shadow"
                style={{ backgroundColor: myFranchise.primaryColor, color: myFranchise.textColor }}
              >
                {myFranchise.code}
              </div>
              <div className="text-left text-xs leading-tight">
                <span className="font-bold text-white mr-2">{myFranchise.name}</span>
                <span className="font-mono text-emerald-400 font-bold">₹{myFranchise.remainingPurse.toFixed(2)} Cr</span>
                <span className="text-slate-400 text-[11px] ml-1.5">({myFranchise.squad.length} players)</span>
              </div>
            </div>
          )
        )}

        {/* Right Action Icons & Controls */}
        <div className="flex items-center gap-2.5">
          {room && (
            <>
              <button
                onClick={onOpenSquad}
                className="px-3 py-1.5 rounded-full bg-slate-800/80 hover:bg-slate-700 border border-white/10 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition"
              >
                <Users className="w-3.5 h-3.5 text-blue-400" />
                <span className="hidden sm:inline">Squads</span>
              </button>

              <button
                onClick={onOpenHistory}
                className="px-3 py-1.5 rounded-full bg-slate-800/80 hover:bg-slate-700 border border-white/10 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition"
              >
                <History className="w-3.5 h-3.5 text-amber-400" />
                <span className="hidden sm:inline">History</span>
              </button>

              {participant?.isHost && (
                <button
                  onClick={onOpenHostControls}
                  className="px-3 py-1.5 rounded-full bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-xs font-semibold text-amber-300 flex items-center gap-1.5 transition"
                >
                  <Shield className="w-3.5 h-3.5 text-amber-400" />
                  <span>Host</span>
                </button>
              )}
            </>
          )}

          {/* Sound Toggle (Circular Pill) */}
          <button
            onClick={toggleSound}
            className="w-9 h-9 rounded-full bg-slate-900/80 hover:bg-slate-800 border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition shadow cursor-pointer"
            title={sound ? "Mute Sound Effects" : "Enable Sound Effects"}
          >
            {sound ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4 text-slate-500" />}
          </button>

          {/* User Profile Avatar (Blue Glowing Pill from reference image) */}
          <div
            className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-700 to-indigo-500 border border-blue-400/40 text-white flex items-center justify-center font-bold text-xs shadow-md shadow-blue-500/25 select-none"
            title={participant?.name || "Player Profile"}
          >
            <User className="w-4 h-4 text-white" />
          </div>
        </div>
      </div>
    </header>
  );
}
