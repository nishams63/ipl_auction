import React, { useState } from 'react';
import {
  Trophy, Shield, Users, Gavel, BarChart3, Plus, ArrowRight,
  Zap, CheckCircle2, X, Sparkles, Radio, HelpCircle
} from 'lucide-react';
import auctionBg from '../assets/ipl_auction_arena_bg.jpg';
import trophyHeroImg from '../assets/ipl_trophy_hero.jpg';
import { IPL_FRANCHISES } from '../../../server/data/franchises';

export default function LandingView({
  onCreateRoom,
  onJoinRoom,
  activeSection = null,
  onCloseSection
}) {
  const [mode, setMode] = useState(null); // null | 'create' | 'join'
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [basePurse, setBasePurse] = useState(120);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Additional detail modals for Navbar navigation
  const [showTeamsModal, setShowTeamsModal] = useState(false);
  const [showHowItWorksModal, setShowHowItWorksModal] = useState(false);

  // Respond to activeSection prop if passed from parent/navbar
  React.useEffect(() => {
    if (activeSection === 'teams') setShowTeamsModal(true);
    if (activeSection === 'how-it-works') setShowHowItWorksModal(true);
    if (activeSection === 'features') {
      const el = document.getElementById('features-section');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeSection]);

  const handleCreateSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Please enter your display name");
      return;
    }
    setError(null);
    setLoading(true);
    onCreateRoom({ hostName: name.trim(), basePurse: Number(basePurse) });
  };

  const handleJoinSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Please enter your display name");
      return;
    }
    if (!roomCode.trim()) {
      setError("Please enter a valid room code");
      return;
    }
    setError(null);
    setLoading(true);
    onJoinRoom({
      participantName: name.trim(),
      roomCode: roomCode.trim().toUpperCase()
    });
  };

  return (
    <div className="relative min-h-[calc(100vh-65px)] flex flex-col justify-between overflow-x-hidden">
      {/* 1. CLEAN AUDITORIUM PHOTOGRAPH BACKGROUND (Venue & Lighting ONLY, NO text, NO UI elements) */}
      <div className="fixed inset-0 z-0 pointer-events-none select-none overflow-hidden">
        <img
          src={auctionBg}
          alt="IPL Auction Venue"
          className="w-full h-full object-cover object-center opacity-40 scale-105"
        />
        {/* Balanced gradient overlay: preserves auditorium visibility without making it pitch black */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#050a1b]/80 via-[#050a1b]/60 to-[#050a1b]/90" />
        <div className="absolute -top-32 left-1/4 w-[36rem] h-[36rem] bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute top-1/3 right-1/4 w-[32rem] h-[32rem] bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />
      </div>

      {/* 2. MAIN CONTENT (Hero Section & Feature Cards) */}
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 lg:pt-12 pb-8 w-full flex-1 flex flex-col justify-between">
        {/* TWO-COLUMN HERO COMPOSITION */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
          {/* LEFT COLUMN: Badge, Headline, Description, Action Buttons (7 cols) */}
          <div className="lg:col-span-7 space-y-6 text-left">
            {/* Small Badge */}
            <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/25 shadow-sm">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-[11px] font-black uppercase tracking-[0.2em] text-amber-300">
                REAL-TIME MULTIPLAYER AUCTION
              </span>
            </div>

            {/* Main Heading */}
            <div className="space-y-1">
              <h1 className="text-4xl sm:text-6xl lg:text-[4.2rem] font-black text-white tracking-tight leading-[1.05]">
                IPL AUCTION
              </h1>
              <div className="relative inline-block">
                <span className="text-4xl sm:text-6xl lg:text-[4.2rem] font-black gold-gradient-text tracking-tight leading-[1.05] drop-shadow-[0_4px_30px_rgba(245,158,11,0.5)]">
                  SIMULATOR
                </span>
                {/* Dynamic Golden Swoosh Accent */}
                <svg
                  className="absolute -bottom-2 sm:-bottom-3 left-0 w-full h-4 overflow-visible pointer-events-none"
                  viewBox="0 0 300 12"
                  fill="none"
                >
                  <path
                    d="M0 6 C 90 12, 190 2, 300 4"
                    stroke="url(#heroGoldSwoosh)"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                  />
                  <defs>
                    <linearGradient id="heroGoldSwoosh" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#fef08a" stopOpacity="0.3" />
                      <stop offset="35%" stopColor="#fbbf24" stopOpacity="1" />
                      <stop offset="75%" stopColor="#f59e0b" stopOpacity="0.9" />
                      <stop offset="100%" stopColor="#d97706" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            </div>

            {/* Short Description */}
            <p className="text-slate-300 text-base sm:text-lg leading-relaxed max-w-xl font-normal">
              Create a private auction room, pick your IPL franchise, bid for top players and build your dream squad in a realistic, multiplayer auction experience.
            </p>

            {/* Two Action Buttons */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 pt-2">
              {/* Create Private Room */}
              <button
                onClick={() => { setMode('create'); setError(null); }}
                className="gold-btn px-7 py-4 rounded-full text-slate-950 font-black text-sm tracking-wide flex items-center justify-center gap-2.5 cursor-pointer shadow-xl shadow-amber-500/25 hover:scale-[1.02] transition"
              >
                <div className="w-5 h-5 rounded-full bg-slate-950/20 flex items-center justify-center">
                  <Plus className="w-3.5 h-3.5 stroke-[3] text-slate-950" />
                </div>
                <span>Create Private Room</span>
              </button>

              {/* Join with Room Code */}
              <button
                onClick={() => { setMode('join'); setError(null); }}
                className="glass-pill px-7 py-4 rounded-full text-white hover:text-amber-300 font-bold text-sm tracking-wide border border-white/20 hover:border-amber-400/50 transition-all flex items-center justify-center gap-2.5 cursor-pointer shadow-lg hover:bg-slate-900/80 hover:scale-[1.02]"
              >
                <Users className="w-4 h-4 text-blue-400" />
                <span>Join with Room Code</span>
              </button>
            </div>
          </div>

          {/* RIGHT COLUMN: Premium IPL Trophy Visual (5 cols) */}
          <div className="lg:col-span-5 flex items-center justify-center relative mt-6 lg:mt-0">
            <div className="relative w-64 h-64 sm:w-80 sm:h-80 lg:w-[22rem] lg:h-[22rem] flex items-center justify-center">
              {/* Spotlight Glow Rings */}
              <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-blue-600/25 via-amber-500/20 to-purple-600/25 blur-2xl animate-pulse-glow pointer-events-none" />
              <div className="absolute inset-3 rounded-full border border-amber-400/30 shadow-[0_0_35px_rgba(245,158,11,0.2)] pointer-events-none" />

              {/* Clean Trophy Visual */}
              <img
                src={trophyHeroImg}
                alt="IPL Championship Trophy"
                className="w-full h-full object-contain relative z-10 drop-shadow-[0_15px_35px_rgba(0,0,0,0.8)] hover:scale-105 transition duration-500 rounded-3xl"
              />

              {/* Trophy Pedestal Tag */}
              <div className="absolute -bottom-3 z-20 px-4 py-1.5 rounded-full bg-slate-950/90 border border-amber-400/50 text-amber-300 text-[11px] font-black uppercase tracking-widest shadow-xl flex items-center gap-2 backdrop-blur-md">
                <Trophy className="w-3.5 h-3.5 text-amber-400" />
                <span>Championship Trophy</span>
              </div>
            </div>
          </div>
        </div>

        {/* 3. FOUR FEATURE CARDS (Dynamic Bidding, Squad Rules, Multiplayer Rooms, Team Analytics) */}
        <div id="features-section" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5 mt-12 sm:mt-16 mb-4">
          {/* Card 1: Dynamic Bidding */}
          <div className="glass-card rounded-2xl p-5 border-glow-gold relative overflow-hidden group hover:translate-y-[-3px] transition duration-200 flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center text-amber-400 mb-3 group-hover:scale-110 transition">
                <Gavel className="w-5 h-5" />
              </div>
              <h3 className="text-white font-extrabold text-base tracking-tight mb-1.5">
                Dynamic Bidding
              </h3>
              <p className="text-slate-300 text-xs leading-relaxed font-normal">
                Real-time, server-controlled bid increments just like the IPL. Automatic bidding logic with authentic timers.
              </p>
            </div>
          </div>

          {/* Card 2: Squad Rules */}
          <div className="glass-card rounded-2xl p-5 border-glow-blue relative overflow-hidden group hover:translate-y-[-3px] transition duration-200 flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-sky-500/15 flex items-center justify-center text-sky-400 mb-3 group-hover:scale-110 transition">
                <Shield className="w-5 h-5" />
              </div>
              <h3 className="text-white font-extrabold text-base tracking-tight mb-1.5">
                Squad Rules
              </h3>
              <p className="text-slate-300 text-xs leading-relaxed font-normal">
                Build balanced squads with real IPL constraints (minimum 15 players, minimum 1 WK, maximum 8 overseas).
              </p>
            </div>
          </div>

          {/* Card 3: Multiplayer Rooms */}
          <div className="glass-card rounded-2xl p-5 border-glow-purple relative overflow-hidden group hover:translate-y-[-3px] transition duration-200 flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-purple-500/15 flex items-center justify-center text-purple-400 mb-3 group-hover:scale-110 transition">
                <Users className="w-5 h-5" />
              </div>
              <h3 className="text-white font-extrabold text-base tracking-tight mb-1.5">
                Multiplayer Rooms
              </h3>
              <p className="text-slate-300 text-xs leading-relaxed font-normal">
                Play with friends in private rooms with unique room codes and fully synchronized real-time state.
              </p>
            </div>
          </div>

          {/* Card 4: Team Analytics */}
          <div className="glass-card rounded-2xl p-5 border-glow-emerald relative overflow-hidden group hover:translate-y-[-3px] transition duration-200 flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center text-emerald-400 mb-3 group-hover:scale-110 transition">
                <BarChart3 className="w-5 h-5" />
              </div>
              <h3 className="text-white font-extrabold text-base tracking-tight mb-1.5">
                Team Analytics
              </h3>
              <p className="text-slate-300 text-xs leading-relaxed font-normal">
                Track squad strength, budget usage, and deterministic team performance rankings in real time.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 4. BOTTOM INFORMATION STRIP */}
      <div className="relative z-10 w-full border-t border-white/10 bg-[#050a1b]/95 backdrop-blur-md py-3.5 px-4 sm:px-8 select-none">
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-center sm:justify-between gap-y-2 gap-x-6 text-xs text-slate-300 font-semibold">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-amber-400" />
            <span>Multiplayer Support</span>
          </div>
          <span className="hidden sm:inline text-white/20">•</span>

          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-400" />
            <span>10 IPL Teams</span>
          </div>
          <span className="hidden sm:inline text-white/20">•</span>

          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <span>Real-Time Auction</span>
          </div>
          <span className="hidden sm:inline text-white/20">•</span>

          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-amber-400" />
            <span>Authentic Auction Rules</span>
          </div>
        </div>
      </div>

      {/* 5. INTERACTIVE MODAL: CREATE / JOIN ROOM */}
      {mode && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xl flex items-center justify-center p-4">
          <div className="glass-panel p-6 sm:p-8 rounded-3xl max-w-md w-full border-glow-gold shadow-2xl relative animate-in fade-in zoom-in-95 duration-200">
            {/* Close Button */}
            <button
              onClick={() => setMode(null)}
              className="absolute top-5 right-5 p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center text-amber-400">
                {mode === 'create' ? <Plus className="w-4 h-4" /> : <Users className="w-4 h-4" />}
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-white">
                {mode === 'create' ? 'Create Private Auction Room' : 'Join Auction Room'}
              </h2>
            </div>

            <p className="text-xs text-slate-300 mb-6">
              {mode === 'create'
                ? 'Generate a unique 6-character room code to invite friends and host the auction.'
                : 'Enter your name and the 6-character code provided by the host.'}
            </p>

            {error && (
              <div className="p-3 mb-4 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-xs">
                {error}
              </div>
            )}

            <form onSubmit={mode === 'create' ? handleCreateSubmit : handleJoinSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-300 block mb-1.5">
                  Your Display Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Captain Cool, Rohit, ViratFan"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full bg-slate-950/80 border border-white/15 rounded-xl px-4 py-3 text-white text-sm focus:border-amber-400 outline-none transition"
                  autoFocus
                />
              </div>

              {mode === 'join' && (
                <div>
                  <label className="text-xs font-bold text-slate-300 block mb-1.5">
                    Room Code
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 7XKP9Q"
                    maxLength={6}
                    value={roomCode}
                    onChange={e => setRoomCode(e.target.value.toUpperCase())}
                    className="w-full bg-slate-950/80 border border-white/15 rounded-xl px-4 py-3 text-amber-400 text-lg font-mono tracking-widest uppercase focus:border-amber-400 outline-none transition"
                  />
                </div>
              )}

              {mode === 'create' && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-slate-300">
                      Base Purse Per Franchise
                    </label>
                    <span className="text-xs font-mono text-amber-400 font-bold">
                      ₹{basePurse} Cr
                    </span>
                  </div>
                  <input
                    type="range"
                    min="60"
                    max="180"
                    step="5"
                    value={basePurse}
                    onChange={e => setBasePurse(e.target.value)}
                    className="w-full accent-amber-400 cursor-pointer"
                  />
                  <div className="flex justify-between text-[11px] text-slate-400 mt-1">
                    <span>₹60 Cr</span>
                    <span>Standard: ₹120 Cr</span>
                    <span>₹180 Cr</span>
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setMode(null)}
                  className="flex-1 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 font-bold text-xs border border-white/10 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-3 rounded-xl gold-btn text-slate-950 font-black text-xs transition cursor-pointer flex items-center justify-center gap-1.5"
                >
                  {loading ? 'Processing...' : mode === 'create' ? 'Create & Enter' : 'Enter Lobby'}
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 6. TEAMS SHOWCASE MODAL */}
      {showTeamsModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xl flex items-center justify-center p-4">
          <div className="glass-panel p-6 rounded-3xl max-w-4xl w-full border border-white/15 max-h-[85vh] overflow-hidden flex flex-col shadow-2xl relative">
            <div className="flex items-center justify-between pb-4 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Trophy className="w-6 h-6 text-amber-400" />
                <div>
                  <h2 className="text-xl font-black text-white">10 Official IPL Franchises</h2>
                  <p className="text-xs text-slate-400">Claim your franchise inside any multiplayer auction room</p>
                </div>
              </div>
              <button
                onClick={() => { setShowTeamsModal(false); if (onCloseSection) onCloseSection(); }}
                className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto py-4 grid grid-cols-1 sm:grid-cols-2 gap-3.5 pr-1">
              {IPL_FRANCHISES.map(franchise => (
                <div
                  key={franchise.id}
                  className="p-4 rounded-2xl border border-white/10 bg-slate-950/60 flex items-center gap-4 hover:border-amber-400/40 transition"
                >
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center font-black text-base shadow-lg"
                    style={{ backgroundColor: franchise.primaryColor, color: franchise.textColor }}
                  >
                    {franchise.code}
                  </div>
                  <div className="flex-1">
                    <h4 className="text-white font-extrabold text-sm">{franchise.name}</h4>
                    <p className="text-slate-400 text-xs">{franchise.city} • Capacity: 25 Players</p>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-mono text-amber-400 font-bold bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                      ₹120 Cr
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 7. HOW IT WORKS MODAL */}
      {showHowItWorksModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xl flex items-center justify-center p-4">
          <div className="glass-panel p-6 sm:p-8 rounded-3xl max-w-2xl w-full border-glow-gold shadow-2xl relative">
            <div className="flex items-center justify-between pb-4 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Zap className="w-6 h-6 text-amber-400" />
                <h2 className="text-xl font-black text-white">How The Auction Works</h2>
              </div>
              <button
                onClick={() => { setShowHowItWorksModal(false); if (onCloseSection) onCloseSection(); }}
                className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-6 space-y-4">
              <div className="flex gap-4 items-start">
                <div className="w-8 h-8 rounded-full bg-amber-500 text-slate-950 font-black text-sm flex items-center justify-center flex-shrink-0">
                  1
                </div>
                <div>
                  <h4 className="text-white font-bold text-sm">Create or Join a Room</h4>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Host a private room and share the 6-character code with your friends, or join an existing lobby.
                  </p>
                </div>
              </div>

              <div className="flex gap-4 items-start">
                <div className="w-8 h-8 rounded-full bg-amber-500 text-slate-950 font-black text-sm flex items-center justify-center flex-shrink-0">
                  2
                </div>
                <div>
                  <h4 className="text-white font-bold text-sm">Select Your IPL Franchise</h4>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Pick your team (CSK, MI, RCB, KKR, etc.). Each team gets an identical purse scaled to active participants.
                  </p>
                </div>
              </div>

              <div className="flex gap-4 items-start">
                <div className="w-8 h-8 rounded-full bg-amber-500 text-slate-950 font-black text-sm flex items-center justify-center flex-shrink-0">
                  3
                </div>
                <div>
                  <h4 className="text-white font-bold text-sm">Bid Live & Build Your Championship Squad</h4>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Bid on 290 candidate players across 15 auction sets. Respect squad constraints (min 15 players, min 1 WK, max 8 overseas) to earn the highest team rating!
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-2 text-center">
              <button
                onClick={() => { setShowHowItWorksModal(false); setMode('create'); }}
                className="gold-btn px-6 py-2.5 rounded-full text-slate-950 font-black text-xs cursor-pointer"
              >
                Get Started Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
