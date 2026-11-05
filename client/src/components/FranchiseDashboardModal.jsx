import React, { useState } from 'react';
import { X, Users, Globe, Shield, DollarSign, Award, ChevronRight } from 'lucide-react';

export default function FranchiseDashboardModal({
  room,
  isOpen,
  onClose,
  initialFranchiseId
}) {
  const [selectedId, setSelectedId] = useState(initialFranchiseId || Object.keys(room.franchises)[0]);

  if (!isOpen) return null;

  const franchise = room.franchises[selectedId] || Object.values(room.franchises)[0];
  const squad = franchise.squad || [];

  const batters = squad.filter(p => p.category === 'BAT');
  const fastBowlers = squad.filter(p => p.category === 'FAST');
  const spinBowlers = squad.filter(p => p.category === 'SPIN');
  const allRounders = squad.filter(p => p.category === 'AR');
  const wicketKeepers = squad.filter(p => p.category === 'WK');
  const overseas = squad.filter(p => p.isOverseas);
  const domestic = squad.filter(p => !p.isOverseas);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xl flex items-center justify-center p-4">
      <div className="glass-panel border-glow-gold rounded-3xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header with franchise selector tabs */}
        <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2 overflow-x-auto py-1 max-w-[85%]">
            {Object.values(room.franchises).map(f => (
              <button
                key={f.id}
                onClick={() => setSelectedId(f.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold transition flex items-center gap-1.5 flex-shrink-0 cursor-pointer ${
                  selectedId === f.id
                    ? 'gold-btn text-slate-950 shadow-md font-black'
                    : 'bg-slate-900/80 hover:bg-slate-800 text-slate-300 border border-white/10'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: f.primaryColor }}
                />
                {f.code}
              </button>
            ))}
          </div>

          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Franchise Header Banner */}
        <div className="p-6 bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-950 border-b border-slate-800">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center font-black text-2xl shadow-xl border border-white/10"
                style={{ backgroundColor: franchise.primaryColor, color: franchise.textColor }}
              >
                {franchise.code}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-2xl font-black text-white">{franchise.name}</h2>
                  {franchise.isEliminated && (
                    <span className="text-xs font-bold text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-0.5 rounded-full">
                      Financially Eliminated
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Owner: <strong className="text-slate-200">{franchise.ownerName || 'Unclaimed'}</strong> • {franchise.homeGround}
                </p>
              </div>
            </div>

            {/* Financial Overview */}
            <div className="flex gap-4">
              <div className="bg-slate-950/60 p-3 rounded-2xl border border-slate-800 text-right">
                <span className="text-[10px] text-slate-400 uppercase font-bold block">Remaining Purse</span>
                <span className="text-lg font-black font-mono text-emerald-400">
                  ₹{franchise.remainingPurse.toFixed(2)} Cr
                </span>
              </div>
              <div className="bg-slate-950/60 p-3 rounded-2xl border border-slate-800 text-right">
                <span className="text-[10px] text-slate-400 uppercase font-bold block">Total Spent</span>
                <span className="text-lg font-black font-mono text-amber-400">
                  ₹{franchise.totalSpent.toFixed(2)} Cr
                </span>
              </div>
            </div>
          </div>

          {/* Role Counts breakdown pill strip */}
          <div className="mt-5 pt-4 border-t border-slate-800/80 grid grid-cols-2 sm:grid-cols-7 gap-2 text-center text-xs">
            <div className="bg-slate-800/40 p-2 rounded-xl">
              <span className="text-slate-400 block text-[10px] font-semibold">Total Squad</span>
              <strong className="text-white text-sm font-mono">{squad.length} / {room.config.maxSquadSize}</strong>
            </div>
            <div className="bg-slate-800/40 p-2 rounded-xl">
              <span className="text-slate-400 block text-[10px] font-semibold">Batters</span>
              <strong className="text-white text-sm font-mono">{batters.length}</strong>
            </div>
            <div className="bg-slate-800/40 p-2 rounded-xl">
              <span className="text-slate-400 block text-[10px] font-semibold">Fast Bowlers</span>
              <strong className="text-white text-sm font-mono">{fastBowlers.length}</strong>
            </div>
            <div className="bg-slate-800/40 p-2 rounded-xl">
              <span className="text-slate-400 block text-[10px] font-semibold">Spinners</span>
              <strong className="text-white text-sm font-mono">{spinBowlers.length}</strong>
            </div>
            <div className="bg-slate-800/40 p-2 rounded-xl">
              <span className="text-slate-400 block text-[10px] font-semibold">All-Rounders</span>
              <strong className="text-white text-sm font-mono">{allRounders.length}</strong>
            </div>
            <div className="bg-slate-800/40 p-2 rounded-xl">
              <span className="text-slate-400 block text-[10px] font-semibold">Wicketkeepers</span>
              <strong className="text-white text-sm font-mono">{wicketKeepers.length}</strong>
            </div>
            <div className="bg-slate-800/40 p-2 rounded-xl">
              <span className="text-slate-400 block text-[10px] font-semibold">Overseas</span>
              <strong className="text-blue-400 text-sm font-mono">{overseas.length} / {room.config.maxOverseas}</strong>
            </div>
          </div>
        </div>

        {/* Squad list body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-3">
          {squad.length === 0 ? (
            <div className="text-center py-16 text-slate-500">
              <Users className="w-12 h-12 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No players acquired by this franchise yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {squad.map((p, index) => (
                <div
                  key={p.id + index}
                  className="bg-slate-900/70 border border-slate-800 p-3 rounded-2xl flex items-center justify-between gap-3 hover:border-slate-700 transition"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-slate-800 border border-slate-700 overflow-hidden flex items-center justify-center font-bold text-amber-400 text-xs flex-shrink-0">
                      {p.initials}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-extrabold text-white text-sm">{p.name}</span>
                        {p.isOverseas && (
                          <span className="text-[10px] text-blue-400 font-bold bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                            OS
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400">
                        {p.category} • {p.role}
                      </div>
                    </div>
                  </div>

                  <div className="text-right flex-shrink-0">
                    <span className="text-xs font-mono font-bold text-emerald-400 block">
                      ₹{p.boughtPrice?.toFixed(2) || p.basePrice.toFixed(2)} Cr
                    </span>
                    <span className="text-[10px] text-slate-500 font-medium">
                      OVR: <strong className="text-amber-400">{p.rating}</strong>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
