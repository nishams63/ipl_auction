import React, { useState, useEffect } from 'react';
import { Volume2, VolumeX, Shield, Users, Radio, Award, History } from 'lucide-react';
import { isSoundEnabled, setSoundEnabled } from '../utils/audio';

export default function Navbar({
  room,
  participant,
  myFranchise,
  onOpenSquad,
  onOpenHistory,
  onOpenHostControls
}) {
  const [sound, setSound] = useState(isSoundEnabled());

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
  };

  return (
    <header className="sticky top-0 z-50 bg-[#070d1e]/90 backdrop-blur-md border-b border-slate-800 px-4 lg:px-8 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-500 to-amber-300 flex items-center justify-center font-black text-slate-950 text-xl shadow-lg shadow-amber-500/20">
            IPL
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold tracking-wider text-white text-base lg:text-lg">
                AUCTION SIMULATOR
              </span>
              <span className="text-[10px] uppercase font-bold tracking-widest bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full">
                LIVE MULTIPLAYER
              </span>
            </div>
            {room && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span>Room: <strong className="text-amber-400 font-mono tracking-widest">{room.roomCode}</strong></span>
                <span>•</span>
                <span className="capitalize">{room.status === 'active' ? '🔴 Live Bidding' : room.status}</span>
              </div>
            )}
          </div>
        </div>

        {/* Center Franchise Badge (if user has claimed one) */}
        {myFranchise && (
          <div
            onClick={onOpenSquad}
            className="hidden md:flex items-center gap-2.5 px-3.5 py-1.5 rounded-xl border border-slate-700 bg-slate-900/80 hover:border-amber-400/50 cursor-pointer transition shadow-md"
            title="Click to view full squad dashboard"
          >
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center font-black text-xs shadow"
              style={{ backgroundColor: myFranchise.primaryColor, color: myFranchise.textColor }}
            >
              {myFranchise.code}
            </div>
            <div className="text-left text-xs leading-tight">
              <div className="font-bold text-white flex items-center gap-1.5">
                {myFranchise.name}
                {myFranchise.isEliminated && (
                  <span className="bg-red-500/20 text-red-400 text-[10px] px-1.5 rounded border border-red-500/30">
                    Eliminated
                  </span>
                )}
              </div>
              <div className="text-slate-400 text-[11px]">
                Purse: <span className="font-mono text-emerald-400 font-bold">₹{myFranchise.remainingPurse.toFixed(2)} Cr</span> | Squad: <span className="text-amber-400 font-semibold">{myFranchise.squad.length}</span>
              </div>
            </div>
          </div>
        )}

        {/* Right actions */}
        <div className="flex items-center gap-2">
          {room && (
            <>
              <button
                onClick={onOpenSquad}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition"
              >
                <Users className="w-3.5 h-3.5 text-blue-400" />
                <span className="hidden sm:inline">Squads</span>
              </button>

              <button
                onClick={onOpenHistory}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition"
              >
                <History className="w-3.5 h-3.5 text-amber-400" />
                <span className="hidden sm:inline">History</span>
              </button>

              {participant?.isHost && (
                <button
                  onClick={onOpenHostControls}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-xs font-semibold text-amber-300 flex items-center gap-1.5 transition"
                >
                  <Shield className="w-3.5 h-3.5 text-amber-400" />
                  <span>Host</span>
                </button>
              )}
            </>
          )}

          {/* Sound Toggle */}
          <button
            onClick={toggleSound}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
            title={sound ? "Mute Sound Effects" : "Enable Sound Effects"}
          >
            {sound ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4 text-slate-500" />}
          </button>
        </div>
      </div>
    </header>
  );
}
