import React, { useState } from 'react';
import { Trophy, Shield, Users, Sparkles, ArrowRight, Gavel, Play, CheckCircle } from 'lucide-react';

export default function LandingView({
  onCreateRoom,
  onJoinRoom
}) {
  const [mode, setMode] = useState(null); // null | 'create' | 'join'
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [basePurse, setBasePurse] = useState(120);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
    <div className="max-w-6xl mx-auto px-4 py-12 lg:py-20 space-y-16">
      {/* Hero Section */}
      <div className="text-center space-y-6 max-w-3xl mx-auto">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 font-extrabold text-xs uppercase tracking-widest shadow-lg">
          <Sparkles className="w-3.5 h-3.5" /> Real-Time Multiplayer Cricket Auction
        </div>

        <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight leading-tight">
          Experience the Thrill of the <span className="bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-500 bg-clip-text text-transparent">IPL Mega Auction</span>
        </h1>

        <p className="text-slate-400 text-base sm:text-lg leading-relaxed">
          Create a private room, claim your favorite IPL franchise, and compete live with friends using server-authoritative bid increments, dynamic purse allocation, and transparent team rankings.
        </p>

        {/* Primary CTA Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
          <button
            onClick={() => { setMode('create'); setError(null); }}
            className="w-full sm:w-auto px-8 py-4 rounded-2xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-base transition shadow-xl shadow-amber-500/25 flex items-center justify-center gap-2 cursor-pointer transform hover:scale-[1.02]"
          >
            <Shield className="w-5 h-5" />
            Create Private Auction Room
          </button>

          <button
            onClick={() => { setMode('join'); setError(null); }}
            className="w-full sm:w-auto px-8 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-black text-base border border-slate-700 transition flex items-center justify-center gap-2 cursor-pointer shadow-lg"
          >
            <Users className="w-5 h-5 text-amber-400" />
            Join with Room Code
          </button>
        </div>
      </div>

      {/* Interactive Modal Popup for Create / Join */}
      {mode && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="glass-panel p-8 rounded-3xl max-w-md w-full border border-slate-700 shadow-2xl relative">
            <h2 className="text-2xl font-black text-white mb-1">
              {mode === 'create' ? 'Create Private Auction Room' : 'Join Auction Room'}
            </h2>
            <p className="text-xs text-slate-400 mb-6">
              {mode === 'create'
                ? 'You will receive a unique 6-character room code to share with friends.'
                : 'Enter your room code to enter the waiting lobby.'}
            </p>

            {error && (
              <div className="p-3 mb-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                {error}
              </div>
            )}

            <form onSubmit={mode === 'create' ? handleCreateSubmit : handleJoinSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">Your Display Name</label>
                <input
                  type="text"
                  placeholder="e.g. Dhoni Fan, Akash, Rohit"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:border-amber-400 outline-none"
                  autoFocus
                />
              </div>

              {mode === 'join' && (
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1">Room Code</label>
                  <input
                    type="text"
                    placeholder="e.g. 7XKP9Q"
                    maxLength={6}
                    value={roomCode}
                    onChange={e => setRoomCode(e.target.value.toUpperCase())}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white text-base font-mono tracking-widest uppercase focus:border-amber-400 outline-none"
                  />
                </div>
              )}

              {mode === 'create' && (
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1">
                    Base Purse Per Franchise (Default ₹120 Cr)
                  </label>
                  <input
                    type="number"
                    min="30"
                    max="200"
                    value={basePurse}
                    onChange={e => setBasePurse(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm font-mono focus:border-amber-400 outline-none"
                  />
                  <span className="text-[11px] text-slate-500 mt-1 block">
                    Actual purse scales by active teams: Base × (N / 10)
                  </span>
                </div>
              )}

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setMode(null)}
                  className="flex-1 py-3 rounded-xl bg-slate-800 text-slate-300 font-bold text-xs hover:bg-slate-700 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs transition shadow-lg shadow-amber-500/20"
                >
                  {loading ? 'Processing...' : mode === 'create' ? 'Create & Enter' : 'Join Room'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Feature Pillars Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-panel p-6 rounded-3xl border border-slate-800/80 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center text-amber-400">
            <Gavel className="w-6 h-6" />
          </div>
          <h3 className="font-extrabold text-white text-lg">Automatic Bid Increments</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Strictly server-authoritative incremental bidding (+₹0.25 Cr to ₹10 Cr, +₹0.50 Cr to ₹15 Cr, +₹1.00 Cr above ₹15 Cr). No arbitrary price skipping.
          </p>
        </div>

        <div className="glass-panel p-6 rounded-3xl border border-slate-800/80 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-400">
            <Shield className="w-6 h-6" />
          </div>
          <h3 className="font-extrabold text-white text-lg">Financial Elimination Guardrails</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Protects minimum squad requirements (15 players, min 1 WK, max 8 overseas). Teams cannot exhaust purses recklessly without mathematical feasibility.
          </p>
        </div>

        <div className="glass-panel p-6 rounded-3xl border border-slate-800/80 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-400">
            <Trophy className="w-6 h-6" />
          </div>
          <h3 className="font-extrabold text-white text-lg">Deterministic Team Evaluation</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Transparent post-auction evaluation with weighted metrics across verified player quality, batting depth, bowling firepower, and budget efficiency.
          </p>
        </div>
      </div>
    </div>
  );
}
