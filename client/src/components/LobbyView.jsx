import React, { useState } from 'react';
import { Copy, Check, Play, Settings, Users, Shield, Sparkles, AlertCircle } from 'lucide-react';
import { IPL_FRANCHISES } from '../../../server/data/franchises';

export default function LobbyView({
  room,
  participant,
  onSelectFranchise,
  onStartAuction,
  onUpdateConfig
}) {
  const [copied, setCopied] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  // Configuration state
  const [basePurse, setBasePurse] = useState(room.config.basePurse || 120);
  const [timerDuration, setTimerDuration] = useState(room.config.timerDuration || 15);
  const [minSquadSize, setMinSquadSize] = useState(room.config.minSquadSize || 11);
  const [maxSquadSize, setMaxSquadSize] = useState(room.config.maxSquadSize || 15);
  const [maxOverseas, setMaxOverseas] = useState(room.config.maxOverseas || 8);

  const copyRoomCode = () => {
    navigator.clipboard.writeText(room.roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveConfig = (e) => {
    e.preventDefault();
    onUpdateConfig({
      basePurse: Number(basePurse),
      timerDuration: Number(timerDuration),
      minSquadSize: Number(minSquadSize),
      maxSquadSize: Number(maxSquadSize),
      maxOverseas: Number(maxOverseas)
    });
    setShowConfig(false);
  };

  const activeFranchises = Object.values(room.franchises).filter(f => f.isClaimed);
  const activeCount = activeFranchises.length;
  const currentPurse = activeCount > 0 ? activeFranchises[0].initialPurse : (room.config.basePurse || 120);
  const canStart = participant?.isHost && activeCount >= room.config.minParticipants;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      {/* Lobby Hero & Room Code */}
      <div className="glass-panel rounded-3xl p-6 lg:p-8 border-glow-gold relative overflow-hidden shadow-2xl">
        <div className="absolute top-0 right-0 w-96 h-96 bg-amber-500/10 rounded-full blur-3xl -z-10 pointer-events-none" />
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-300 bg-amber-500/15 border border-amber-500/30 px-3 py-1 rounded-full shadow-sm">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Private Auction Room
              </span>
              {participant?.isHost && (
                <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-3 py-1 rounded-full">
                  <Shield className="w-3.5 h-3.5" /> Room Host
                </span>
              )}
            </div>
            <h1 className="text-3xl lg:text-4xl font-black text-white tracking-tight">
              Pre-Auction Waiting Lobby
            </h1>
            <p className="text-slate-300 text-sm mt-1 max-w-xl">
              Each participant must select an IPL franchise. Share the room code with friends to assemble at least {room.config.minParticipants} teams before starting.
            </p>
          </div>

          {/* Room Code Card (Stadium Gold Border) */}
          <div className="flex flex-col items-center sm:items-end gap-2 w-full sm:w-auto">
            <div className="text-xs font-bold text-amber-400/90 tracking-widest uppercase">
              Room Code
            </div>
            <div className="flex items-center gap-3 bg-slate-950/90 border border-amber-400/60 rounded-2xl px-5 py-2.5 shadow-xl shadow-amber-500/10">
              <span className="text-3xl font-black tracking-widest text-amber-400 font-mono">
                {room.roomCode}
              </span>
              <button
                onClick={copyRoomCode}
                className="p-2 hover:bg-white/10 rounded-xl transition text-slate-300 hover:text-white cursor-pointer"
                title="Copy Room Code"
              >
                {copied ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5" />}
              </button>
            </div>
            <span className="text-[11px] text-slate-400">Share this code with fellow bidders</span>
          </div>
        </div>

        {/* Dynamic Purse Banner */}
        <div className="mt-6 pt-6 border-t border-white/10 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="glass-card rounded-2xl p-4 border border-white/10">
            <span className="text-xs text-slate-400 uppercase font-bold tracking-wider">Dynamic Purse Formula</span>
            <div className="text-sm text-slate-200 font-mono mt-1 font-bold">
              Base (₹{room.config.basePurse} Cr) × ({activeCount} Active / 10)
            </div>
            <div className="text-xs text-amber-300/90 mt-1">
              Scales automatically based on participating franchises
            </div>
          </div>

          <div className="glass-card rounded-2xl p-4 border border-white/10">
            <span className="text-xs text-slate-400 uppercase font-bold tracking-wider">Purse Per Franchise</span>
            <div className="text-2xl font-black text-emerald-400 font-mono mt-0.5">
              ₹{currentPurse.toFixed(2)} Cr
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Locked when host launches the auction
            </div>
          </div>

          <div className="glass-card rounded-2xl p-4 border border-white/10 flex items-center justify-between">
            <div>
              <span className="text-xs text-slate-400 uppercase font-bold tracking-wider">Active Human Owners</span>
              <div className="text-2xl font-black text-white font-mono mt-0.5">
                {activeCount} / 10
              </div>
              <div className="text-xs text-slate-400 mt-1">
                Min {room.config.minParticipants} required to start
              </div>
            </div>

            {participant?.isHost && (
              <button
                onClick={() => setShowConfig(!showConfig)}
                className="px-3.5 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-xs font-bold text-slate-200 flex items-center gap-1.5 border border-white/10 transition cursor-pointer"
              >
                <Settings className="w-4 h-4 text-amber-400" />
                Settings
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Host Settings Modal */}
      {showConfig && participant?.isHost && (
        <form onSubmit={handleSaveConfig} className="glass-panel p-6 rounded-3xl border border-amber-500/30 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-lg text-white flex items-center gap-2">
              <Settings className="w-5 h-5 text-amber-400" /> Configure Auction Rules
            </h3>
            <span className="text-xs text-amber-400/80 font-medium">Rules lock once the auction begins</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Base Purse (₹ Cr)</label>
              <input
                type="number"
                min="20"
                max="250"
                value={basePurse}
                onChange={e => setBasePurse(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-sm focus:border-amber-400 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Bid Timer (Seconds)</label>
              <input
                type="number"
                min="10"
                max="90"
                value={timerDuration}
                onChange={e => setTimerDuration(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-sm focus:border-amber-400 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Min Squad Size</label>
              <input
                type="number"
                min="5"
                max="25"
                value={minSquadSize}
                onChange={e => setMinSquadSize(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-sm focus:border-amber-400 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Max Squad Size</label>
              <input
                type="number"
                min="15"
                max="30"
                value={maxSquadSize}
                onChange={e => setMaxSquadSize(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-sm focus:border-amber-400 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Max Overseas</label>
              <input
                type="number"
                min="4"
                max="10"
                value={maxOverseas}
                onChange={e => setMaxOverseas(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-sm focus:border-amber-400 outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowConfig(false)}
              className="px-4 py-2 rounded-xl text-xs font-bold text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-black transition shadow-lg shadow-amber-500/20"
            >
              Save Configuration
            </button>
          </div>
        </form>
      )}

      {/* Franchise Selection Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-extrabold text-white">Select Your Franchise</h2>
            <p className="text-xs text-slate-400">
              Only one real participant can own each franchise.
            </p>
          </div>
          <div className="text-xs font-bold text-slate-400">
            {activeCount} / 10 Franchises Claimed
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {Object.values(room.franchises).map(f => {
            const isMine = f.ownerToken === participant?.token;
            const isClaimedByOther = f.isClaimed && !isMine;

            return (
              <div
                key={f.id}
                className={`relative rounded-2xl p-4 transition duration-200 border flex flex-col justify-between min-h-[195px] shadow-lg ${
                  isMine
                    ? 'border-amber-400 bg-slate-900/90 shadow-amber-500/20 ring-2 ring-amber-400/60'
                    : isClaimedByOther
                    ? 'border-white/5 bg-slate-950/40 opacity-70'
                    : 'border-white/10 bg-slate-900/50 hover:border-amber-400/40 hover:bg-slate-900/80'
                }`}
              >
                {/* Header with color stripe and badge */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm shadow-md"
                      style={{ backgroundColor: f.primaryColor, color: f.textColor }}
                    >
                      {f.code}
                    </div>
                    {f.titles > 0 && (
                      <span className="text-[10px] font-extrabold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-2.5 py-0.5 rounded-full shadow-sm">
                        ★ {f.titles} {f.titles === 1 ? 'Title' : 'Titles'}
                      </span>
                    )}
                  </div>

                  <h3 className="font-black text-white text-sm leading-snug">
                    {f.name}
                  </h3>
                  <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                    {f.homeGround.split(',')[0]}
                  </div>
                </div>

                {/* Owner status and claim button */}
                <div className="mt-4 pt-3 border-t border-white/10">
                  {isMine ? (
                    <div className="flex items-center justify-between bg-amber-500/10 px-2.5 py-1.5 rounded-xl border border-amber-500/20">
                      <span className="text-xs font-black text-amber-300 flex items-center gap-1.5">
                        <Check className="w-3.5 h-3.5 text-amber-400" /> Your Franchise
                      </span>
                      <span className="text-[10px] text-amber-400 font-mono font-bold uppercase tracking-wider">Owner</span>
                    </div>
                  ) : isClaimedByOther ? (
                    <div>
                      <span className="text-[11px] text-slate-400 block font-medium">Claimed by:</span>
                      <span className="text-xs font-bold text-slate-200 truncate block">
                        {f.ownerName}
                      </span>
                    </div>
                  ) : (
                    <button
                      onClick={() => onSelectFranchise(f.id)}
                      className="w-full py-2 rounded-xl bg-slate-800/80 hover:bg-amber-400 hover:text-slate-950 text-slate-200 text-xs font-bold border border-white/10 transition cursor-pointer"
                    >
                      Claim Franchise
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Start Auction Floating Action Bar for Host */}
      <div className="glass-panel p-5 rounded-3xl border-glow-gold flex flex-col sm:flex-row items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-amber-500/15 flex items-center justify-center text-amber-400">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">
              {participant?.franchiseId
                ? `You represent ${room.franchises[participant.franchiseId]?.name}`
                : "You have not chosen a franchise yet. Please claim one above."}
            </div>
            <div className="text-xs text-slate-300">
              {activeCount >= room.config.minParticipants
                ? `Ready to begin! ${activeCount} teams assembled.`
                : `Waiting for at least ${room.config.minParticipants} participants to claim franchises.`}
            </div>
          </div>
        </div>

        {participant?.isHost ? (
          <button
            onClick={onStartAuction}
            disabled={!canStart}
            className={`px-8 py-3.5 rounded-full font-black text-sm flex items-center gap-2 transition shadow-xl ${
              canStart
                ? 'gold-btn text-slate-950 cursor-pointer'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-white/10'
            }`}
          >
            <Play className="w-4 h-4 fill-current" />
            Start Live Auction Now
          </button>
        ) : (
          <div className="text-xs text-slate-300 bg-slate-950/80 px-4 py-2.5 rounded-full border border-white/10">
            Waiting for host <strong className="text-amber-400">{room.hostName}</strong> to launch the auction...
          </div>
        )}
      </div>
    </div>
  );
}
