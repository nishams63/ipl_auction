import React, { useEffect, useState } from 'react';
import confetti from 'canvas-confetti';
import {
  Trophy, Medal, Award, CheckCircle2, XCircle, ArrowLeft,
  ChevronDown, ChevronUp, BarChart2, Shield, Users, DollarSign
} from 'lucide-react';

export default function FinalResultsView({
  room,
  onInspectSquad,
  onBackToLobby
}) {
  const [expandedTeam, setExpandedTeam] = useState(null);
  const evaluation = room.evaluationResults;

  useEffect(() => {
    // Launch celebratory confetti for the champion!
    try {
      confetti({
        particleCount: 100,
        spread: 80,
        origin: { y: 0.6 }
      });
      const timer = setTimeout(() => {
        confetti({
          particleCount: 80,
          angle: 60,
          spread: 55,
          origin: { x: 0 }
        });
        confetti({
          particleCount: 80,
          angle: 120,
          spread: 55,
          origin: { x: 1 }
        });
      }, 400);
      return () => clearTimeout(timer);
    } catch (e) {}
  }, []);

  if (!evaluation) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center">
        <h2 className="text-2xl font-bold text-white">Calculating Final Standings...</h2>
      </div>
    );
  }

  const { podium, rankings } = evaluation;
  const champion = podium[0];
  const runnerUp = podium[1];
  const third = podium[2];

  const getFranchise = (id) => room.franchises[id];

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-10">
      {/* Top Banner */}
      <div className="text-center space-y-3 relative">
        <div className="flex justify-start sm:absolute sm:left-0 sm:top-0">
          <button
            onClick={onBackToLobby}
            className="px-4 py-2 rounded-full bg-slate-900/80 hover:bg-slate-800 border border-white/10 text-xs font-bold text-slate-300 hover:text-white flex items-center gap-1.5 transition cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Home
          </button>
        </div>

        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-extrabold text-xs uppercase tracking-widest shadow-lg">
          <Trophy className="w-4 h-4 text-amber-400" /> Official Auction Results & Rankings
        </div>
        <h1 className="text-4xl lg:text-5xl font-black text-white tracking-tight">
          IPL Auction Champions
        </h1>
        <p className="text-slate-300 text-sm max-w-xl mx-auto">
          Deterministic 100% transparent evaluation based on player quality ratings, batting/bowling depth, role balance, and financial compliance.
        </p>
      </div>

      {/* TOP THREE PODIUM DISPLAY */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end pt-6">
        {/* Runner-Up (2nd Place) */}
        {runnerUp ? (
          <div className="glass-panel p-6 rounded-3xl border border-slate-700 order-2 md:order-1 text-center space-y-4 shadow-xl relative">
            <div className="w-12 h-12 rounded-full bg-slate-400/20 text-slate-300 border border-slate-400/30 flex items-center justify-center font-black mx-auto text-lg shadow-md">
              🥈 2nd
            </div>
            <div>
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center font-black text-2xl mx-auto shadow-lg mb-2"
                style={{
                  backgroundColor: getFranchise(runnerUp.franchiseId)?.primaryColor,
                  color: getFranchise(runnerUp.franchiseId)?.textColor
                }}
              >
                {getFranchise(runnerUp.franchiseId)?.code}
              </div>
              <h3 className="font-extrabold text-white text-lg">{runnerUp.franchiseName}</h3>
              <p className="text-xs text-slate-400">Owner: {getFranchise(runnerUp.franchiseId)?.ownerName}</p>
            </div>

            <div className="bg-slate-900/80 p-3 rounded-2xl border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-bold block">Overall Squad Score</span>
              <span className="text-2xl font-black text-white font-mono">{runnerUp.totalScore}</span>
              <span className="text-xs text-slate-400"> / 100</span>
            </div>

            <div className="text-xs text-slate-400">
              Squad: <strong className="text-white">{runnerUp.squadSize}</strong> | Spent: <strong className="text-amber-400 font-mono">₹{runnerUp.totalSpent.toFixed(2)} Cr</strong>
            </div>
          </div>
        ) : (
          <div className="order-2 md:order-1" />
        )}

        {/* Champion (1st Place) */}
        {champion ? (
          <div className="glass-panel p-8 rounded-3xl border-2 border-amber-400 bg-gradient-to-b from-amber-500/10 via-slate-900/90 to-slate-950 order-1 md:order-2 text-center space-y-5 shadow-2xl relative transform md:-translate-y-4">
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-amber-400 text-slate-950 px-4 py-1 rounded-full text-xs font-black uppercase tracking-wider shadow-lg flex items-center gap-1.5">
              <Trophy className="w-4 h-4 fill-current" /> CHAMPION
            </div>

            <div className="w-16 h-16 rounded-full bg-amber-400/20 text-amber-300 border border-amber-400/40 flex items-center justify-center font-black mx-auto text-2xl shadow-xl mt-2">
              🥇 1st
            </div>

            <div>
              <div
                className="w-20 h-20 rounded-2xl flex items-center justify-center font-black text-3xl mx-auto shadow-2xl mb-3 border-2 border-amber-400/50"
                style={{
                  backgroundColor: getFranchise(champion.franchiseId)?.primaryColor,
                  color: getFranchise(champion.franchiseId)?.textColor
                }}
              >
                {getFranchise(champion.franchiseId)?.code}
              </div>
              <h2 className="font-black text-white text-2xl">{champion.franchiseName}</h2>
              <p className="text-xs text-amber-400/90 font-semibold mt-0.5">
                Owner: {getFranchise(champion.franchiseId)?.ownerName}
              </p>
            </div>

            <div className="bg-slate-900 p-4 rounded-2xl border border-amber-500/30">
              <span className="text-xs text-amber-400 uppercase font-bold block">Winning Squad Score</span>
              <span className="text-4xl font-black text-amber-400 font-mono">{champion.totalScore}</span>
              <span className="text-sm text-slate-400"> / 100</span>
            </div>

            <div className="text-xs text-slate-300">
              Squad Size: <strong className="text-white">{champion.squadSize}</strong> players • Spent: <strong className="text-emerald-400 font-mono">₹{champion.totalSpent.toFixed(2)} Cr</strong>
            </div>

            <button
              onClick={() => onInspectSquad(champion.franchiseId)}
              className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs transition shadow-lg shadow-amber-500/20"
            >
              Inspect Winning Roster
            </button>
          </div>
        ) : (
          <div className="order-1 md:order-2 text-center text-slate-400">No Eligible Champion</div>
        )}

        {/* Third Place (3rd Place) */}
        {third ? (
          <div className="glass-panel p-6 rounded-3xl border border-slate-700 order-3 text-center space-y-4 shadow-xl relative">
            <div className="w-12 h-12 rounded-full bg-amber-700/20 text-amber-600 border border-amber-700/30 flex items-center justify-center font-black mx-auto text-lg shadow-md">
              🥉 3rd
            </div>
            <div>
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center font-black text-2xl mx-auto shadow-lg mb-2"
                style={{
                  backgroundColor: getFranchise(third.franchiseId)?.primaryColor,
                  color: getFranchise(third.franchiseId)?.textColor
                }}
              >
                {getFranchise(third.franchiseId)?.code}
              </div>
              <h3 className="font-extrabold text-white text-lg">{third.franchiseName}</h3>
              <p className="text-xs text-slate-400">Owner: {getFranchise(third.franchiseId)?.ownerName}</p>
            </div>

            <div className="bg-slate-900/80 p-3 rounded-2xl border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-bold block">Overall Squad Score</span>
              <span className="text-2xl font-black text-white font-mono">{third.totalScore}</span>
              <span className="text-xs text-slate-400"> / 100</span>
            </div>

            <div className="text-xs text-slate-400">
              Squad: <strong className="text-white">{third.squadSize}</strong> | Spent: <strong className="text-amber-400 font-mono">₹{third.totalSpent.toFixed(2)} Cr</strong>
            </div>
          </div>
        ) : (
          <div className="order-3" />
        )}
      </div>

      {/* FULL RANKINGS & DETAILED BREAKDOWN TABLE */}
      <div className="glass-panel rounded-3xl p-6 lg:p-8 border border-slate-800 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xl font-black text-white flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-amber-400" /> Complete Team Evaluations & Scorecards
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Breakdown across verified ratings (30%), batting (20%), bowling (20%), all-rounders (10%), composition (10%), overseas (5%), and budget efficiency (5%).
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {rankings.map(team => {
            const isExpanded = expandedTeam === team.franchiseId;
            const franchise = getFranchise(team.franchiseId);

            return (
              <div
                key={team.franchiseId}
                className={`rounded-2xl border transition overflow-hidden ${
                  team.isEligible
                    ? 'border-slate-800 bg-slate-900/60'
                    : 'border-red-500/20 bg-red-950/10'
                }`}
              >
                {/* Team summary row */}
                <div
                  onClick={() => setExpandedTeam(isExpanded ? null : team.franchiseId)}
                  className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-800/40 transition gap-4"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center font-bold font-mono text-xs text-slate-300">
                      #{team.position}
                    </span>
                    <div
                      className="w-8 h-8 rounded-xl flex items-center justify-center font-black text-xs shadow"
                      style={{ backgroundColor: franchise?.primaryColor, color: franchise?.textColor }}
                    >
                      {franchise?.code}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-white text-sm">{team.franchiseName}</span>
                        {!team.isEligible && (
                          <span className="text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-0.5 rounded-full">
                            Ineligible: {team.ineligibilityReason}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-slate-400">
                        Owner: {franchise?.ownerName} • Squad: {team.squadSize} players
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-5">
                    <div className="text-right">
                      <span className="text-[10px] text-slate-500 uppercase font-semibold block">Total Score</span>
                      <span className="text-xl font-black font-mono text-white">
                        {team.totalScore}
                        <span className="text-xs text-slate-500 font-normal">/100</span>
                      </span>
                    </div>

                    <button className="text-slate-400 hover:text-white p-1">
                      {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                {/* Expanded Details Breakdown */}
                {isExpanded && (
                  <div className="p-5 border-t border-slate-800/80 bg-slate-950/60 space-y-4 text-xs">
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-center">
                      <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                        <span className="text-slate-400 block text-[10px] font-semibold">Player Quality (30%)</span>
                        <strong className="text-white text-sm font-mono">{team.breakdown.playerQuality}</strong>
                      </div>
                      <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                        <span className="text-slate-400 block text-[10px] font-semibold">Batting (20%)</span>
                        <strong className="text-white text-sm font-mono">{team.breakdown.battingStrength}</strong>
                      </div>
                      <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                        <span className="text-slate-400 block text-[10px] font-semibold">Bowling (20%)</span>
                        <strong className="text-white text-sm font-mono">{team.breakdown.bowlingStrength}</strong>
                      </div>
                      <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                        <span className="text-slate-400 block text-[10px] font-semibold">All-Rounders (10%)</span>
                        <strong className="text-white text-sm font-mono">{team.breakdown.allRounderBalance}</strong>
                      </div>
                      <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                        <span className="text-slate-400 block text-[10px] font-semibold">Role Balance (10%)</span>
                        <strong className="text-white text-sm font-mono">{team.breakdown.squadComposition}</strong>
                      </div>
                      <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                        <span className="text-slate-400 block text-[10px] font-semibold">Overseas (5%)</span>
                        <strong className="text-white text-sm font-mono">{team.breakdown.overseasBalance}</strong>
                      </div>
                      <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                        <span className="text-slate-400 block text-[10px] font-semibold">Budget (5%)</span>
                        <strong className="text-white text-sm font-mono">{team.breakdown.budgetEfficiency}</strong>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-slate-400">
                      <div>
                        Composition: {team.counts.batters} Batters, {team.counts.fastBowlers} Fast, {team.counts.spinBowlers} Spin, {team.counts.allRounders} AR, {team.counts.wicketKeepers} WK • Overseas: {team.overseasCount}
                      </div>
                      <button
                        onClick={() => onInspectSquad(team.franchiseId)}
                        className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold transition text-xs"
                      >
                        Inspect Squad Roster
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
