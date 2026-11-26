import React, { useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import { Trophy, ArrowLeft, Users, CheckCircle2, XCircle, MinusCircle, AlertTriangle, Shield, Wallet, Info, Swords, Award, AlertOctagon, TrendingUp } from 'lucide-react';
import { getRoomSquadLimits } from '../../../server/config';

// CRICKET MASTERMIND — IPL AUCTION VERDICT
// Professional post-auction strategic analysis.
// ABSOLUTELY NO OVERALL NUMERICAL SCORES OR POINT-BASED RATINGS.
// All rankings, verdicts, and awards are derived from qualitative cricket squad evaluations.

const CATEGORY_LABEL = {
  BAT: 'Specialist Batters',
  WK: 'Wicketkeepers',
  AR: 'All-rounders',
  BOWL: 'Fast Bowlers',
  SP: 'Spinners'
};

const cr = v => (typeof v === 'number' && Number.isFinite(v) ? `₹${v.toFixed(2)} Cr` : '—');

function EligibilityBadge({ eligibility }) {
  if (!eligibility || eligibility.status === 'ELIGIBLE' || eligibility.eligible) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
        <CheckCircle2 className="w-3 h-3" />Rule-Compliant
      </span>
    );
  }
  if (eligibility.status === 'NOT_PARTICIPATING') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-700/40 text-slate-400 border border-slate-600/40">
        <MinusCircle className="w-3 h-3" />Did Not Participate
      </span>
    );
  }
  return (
    <span title={eligibility.failures?.join('\n') || 'Failed squad rules'} className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 cursor-help">
      <XCircle className="w-3 h-3" />Rule Violation
    </span>
  );
}

function TeamDot({ franchise }) {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full ring-2 ring-slate-900 shrink-0"
      style={{ background: franchise?.primaryColor || '#64748b' }}
    />
  );
}

function Panel({ title, icon: Icon, children, right, className = '' }) {
  return (
    <section className={`glass-panel rounded-2xl border border-slate-800 p-4 sm:p-5 space-y-4 ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3">
          {title && (
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-300 flex items-center gap-2">
              {Icon && <Icon className="w-4 h-4 text-amber-400" />}
              {title}
            </h3>
          )}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-4">
      <div className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">{label}</div>
      <div className="text-2xl font-black text-white mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function FinalResultsView({ room, onInspectSquad, onBackToLobby }) {
  const { maxSquadSize, maxOverseas } = getRoomSquadLimits(room);
  const analysis = room.analysis;
  const [tab, setTab] = useState('verdict');
  const [selectedFranchiseId, setSelectedFranchiseId] = useState(null);
  const [compareA, setCompareA] = useState(null);
  const [compareB, setCompareB] = useState(null);

  useEffect(() => {
    try {
      confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 } });
      const timer = setTimeout(() => {
        confetti({ particleCount: 90, angle: 60, spread: 55, origin: { x: 0 } });
        confetti({ particleCount: 90, angle: 120, spread: 55, origin: { x: 1 } });
      }, 350);
      return () => clearTimeout(timer);
    } catch { /* decorative */ }
  }, []);

  const mastermind = useMemo(() => {
    if (!analysis) return null;
    return {
      engineVersion: analysis.engineVersion || 'cricket-mastermind-v1',
      // Never invent a winner or reasons: fall back to the server's rank 1 with no claims
      verdict: analysis.verdict || {
        winnerFranchiseId: analysis.rankings?.[0]?.franchiseId || null,
        winnerFranchiseName: analysis.rankings?.[0]?.franchiseName || null,
        expertVerdict: '',
        mainReasons: [],
        keyAdvantages: [],
        vulnerabilities: []
      },
      rankings: analysis.rankings || [],
      franchises: analysis.franchises || {},
      whyWinnerWon: analysis.whyWinnerWon || null,
      biggestMistakes: analysis.biggestMistakes || [],
      bestAcquisitions: analysis.bestAcquisitions || [],
      headToHead: analysis.headToHead || {},
      summary: analysis.summary || {},
      limitations: analysis.limitations || analysis.dataNotes || []
    };
  }, [analysis]);

  const winner = useMemo(() => {
    if (!mastermind || !mastermind.verdict.winnerFranchiseId) return null;
    const winnerId = mastermind.verdict.winnerFranchiseId;
    return {
      id: winnerId,
      name: mastermind.verdict.winnerFranchiseName,
      franchise: room?.franchises?.[winnerId] || {},
      details: mastermind.franchises[winnerId]
    };
  }, [mastermind, room]);

  const rankedList = useMemo(() => {
    if (!mastermind) return [];
    return mastermind.rankings.map(r => ({
      ...r,
      franchise: room?.franchises?.[r.franchiseId],
      eval: mastermind.franchises[r.franchiseId]
    }));
  }, [mastermind, room]);

  const activeFocusId = selectedFranchiseId || rankedList[0]?.franchiseId || 'CSK';
  const focusEval = mastermind?.franchises[activeFocusId];

  // Initialize comparison teams
  useEffect(() => {
    if (rankedList.length >= 2) {
      if (!compareA) setCompareA(rankedList[0].franchiseId);
      if (!compareB) setCompareB(rankedList[1].franchiseId);
    }
  }, [rankedList, compareA, compareB]);

  if (!analysis) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center">
        <h2 className="text-2xl font-bold text-white">Deliberating Auction Verdict…</h2>
        <p className="text-slate-400 text-sm mt-2">Cricket Mastermind is reviewing squad construction across all 10 franchises.</p>
      </div>
    );
  }

  const s = mastermind.summary;

  const tabs = [
    ['verdict', 'Auction Verdict', Trophy],
    ['rankings', 'Official Rankings (1–10)', Shield],
    ['squads', 'Franchise Deep-Dive', Users],
    ['mistakes', 'Auction Review & Value', Award],
    ['matchup', 'Head-to-Head', Swords]
  ];

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-6">

      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between border-b border-slate-800 pb-5">
        <div className="flex items-center gap-3">
          <button
            onClick={onBackToLobby}
            className="p-2 rounded-full border border-slate-700 text-slate-300 hover:text-white hover:border-amber-400/60 transition"
            aria-label="Leave the results and return home" title="Leave room"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-amber-400/10 text-amber-300 border border-amber-400/30">
                CRICKET MASTERMIND
              </span>
              <span className="text-xs text-slate-500 font-mono">Room {room.roomCode}</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight mt-0.5">
              IPL Auction <span className="gold-gradient-text">Verdict</span>
            </h2>
          </div>
        </div>

        {winner && (
          <div data-testid="results-winner" data-franchise={winner.id} className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-amber-500/15 via-amber-500/5 to-transparent border border-amber-500/30 px-4 py-2.5">
            <Trophy className="w-6 h-6 text-amber-400 shrink-0" />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-amber-300/90 font-bold">
                1st Place · Auction Champion
              </div>
              <div className="text-white font-black flex items-center gap-2 text-base">
                <TeamDot franchise={winner.franchise} />
                {winner.name}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Navigation Tabs */}
      <nav role="tablist" aria-label="Results sections" className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap border transition ${
              tab === id
                ? 'bg-amber-400 text-slate-950 border-amber-400 shadow-lg shadow-amber-400/10'
                : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:border-amber-400/50 hover:text-white'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </nav>

      {/* TAB 1: SECTION 1 (Auction Verdict) & SECTION 4 (Why Winner Won) */}
      {tab === 'verdict' && (
        <div className="space-y-6">
          {/* Winner Crown Panel */}
          <div className="relative overflow-hidden rounded-3xl border border-amber-500/40 bg-gradient-to-br from-amber-500/10 via-slate-900 to-slate-950 p-6 sm:p-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="space-y-2">
                <div className="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-wider px-3 py-1 rounded-full bg-amber-400 text-slate-950">
                  <Trophy className="w-3.5 h-3.5" />
                  Auction Mastermind Champion
                </div>
                <h1 className="text-3xl sm:text-4xl font-black text-white flex items-center gap-3">
                  <TeamDot franchise={winner.franchise} />
                  {winner.name}
                </h1>
                <p className="text-amber-200/90 text-sm max-w-2xl font-medium leading-relaxed">
                  {mastermind.verdict.expertVerdict}
                </p>
              </div>

              <div className="shrink-0 flex md:flex-col gap-2">
                <button
                  onClick={() => { setSelectedFranchiseId(winner.id); setTab('squads'); }}
                  className="gold-btn px-5 py-2.5 rounded-full text-slate-950 text-xs font-black"
                >
                  Inspect Winning Squad
                </button>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4 mt-6 pt-6 border-t border-slate-800/80">
              <div className="space-y-2">
                <h4 className="text-xs font-black uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  Primary Strategic Advantages
                </h4>
                <ul className="space-y-1.5">
                  {(mastermind.verdict.mainReasons || []).map((r, i) => (
                    <li key={i} className="text-xs text-slate-300 leading-snug flex items-start gap-2">
                      <span className="text-emerald-400 font-bold">•</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-black uppercase tracking-wider text-rose-400 flex items-center gap-1.5">
                  <AlertOctagon className="w-4 h-4" />
                  Tactical Risks &amp; Vulnerabilities
                </h4>
                <ul className="space-y-1.5">
                  {(mastermind.verdict.vulnerabilities || []).map((v, i) => (
                    <li key={i} className="text-xs text-slate-300 leading-snug flex items-start gap-2">
                      <span className="text-rose-400 font-bold">•</span>
                      <span>{v}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Section 4: Why the Winner Won (1st vs 2nd) */}
          {mastermind.whyWinnerWon && (
            <Panel title="Why 1st Place Beat 2nd Place" icon={Swords}>
              <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black text-amber-400">1st</span>
                    <span className="text-sm font-bold text-white">{mastermind.whyWinnerWon.firstPlace}</span>
                  </div>
                  <span className="text-xs font-black uppercase text-slate-500">Versus</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black text-slate-400">2nd</span>
                    <span className="text-sm font-bold text-slate-300">{mastermind.whyWinnerWon.secondPlace}</span>
                  </div>
                </div>

                <p className="text-sm text-slate-200 leading-relaxed font-medium">
                  {mastermind.whyWinnerWon.verdictStatement}
                </p>

                <div className="grid sm:grid-cols-3 gap-3 text-xs pt-2">
                  <div className="rounded-lg bg-slate-950/60 p-3 border border-slate-800/80 space-y-1">
                    <span className="font-bold text-amber-300 uppercase tracking-wider block">Batting Unit</span>
                    <p className="text-slate-300">{mastermind.whyWinnerWon.battingComparison}</p>
                  </div>
                  <div className="rounded-lg bg-slate-950/60 p-3 border border-slate-800/80 space-y-1">
                    <span className="font-bold text-amber-300 uppercase tracking-wider block">Bowling &amp; Death Overs</span>
                    <p className="text-slate-300">{mastermind.whyWinnerWon.bowlingComparison}</p>
                  </div>
                  <div className="rounded-lg bg-slate-950/60 p-3 border border-slate-800/80 space-y-1">
                    <span className="font-bold text-amber-300 uppercase tracking-wider block">Balance &amp; WKs</span>
                    <p className="text-slate-300">{mastermind.whyWinnerWon.balanceComparison}</p>
                  </div>
                </div>
              </div>
            </Panel>
          )}

          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Total Sold" value={s.playersSold || 0} sub={`${s.playersUnsold || 0} unsold · ${s.playersSkipped || 0} skipped`} />
            <Stat label="Total Outlay" value={cr(s.totalExpenditure)} sub={`Across ${s.participatingFranchises || 0} teams`} />
            <Stat label="Remaining Purse" value={cr(s.totalRemainingPurse)} sub="Collective unspent funds" />
            <Stat label="Rule Compliance" value={`${s.eligibleFranchises || 0}/${s.participatingFranchises || 0}`} sub="Fully compliant squads" />
          </div>
        </div>
      )}

      {/* TAB 2: SECTION 2 (Official Rankings 1-10) */}
      {tab === 'rankings' && (
        <Panel title="Official Cricket Mastermind Rankings (1st to 10th)" icon={Shield}>
          <p className="text-xs text-slate-400">
            Strict ordinal rankings from 1st to 10th determined purely through qualitative cricket reasoning,
            head-to-head department matchups, and squad completeness. <b>Zero numerical point totals or score formulas.</b>
          </p>

          <div className="space-y-3 mt-4">
            {rankedList.map(r => (
              <div
                key={r.franchiseId}
                data-testid="ranking-row"
                data-rank={r.rank}
                data-franchise={r.franchiseId}
                className={`rounded-2xl border transition p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                  r.rank === 1
                    ? 'border-amber-400/60 bg-gradient-to-r from-amber-500/10 via-slate-900 to-slate-900'
                    : r.eligible
                    ? 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                    : 'border-rose-900/40 bg-rose-950/10 opacity-75'
                }`}
              >
                <div className="flex items-start sm:items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-lg shrink-0 ${
                    r.rank === 1
                      ? 'bg-amber-400 text-slate-950 shadow-md shadow-amber-400/20'
                      : r.rank === 2
                      ? 'bg-slate-300 text-slate-950'
                      : r.rank === 3
                      ? 'bg-amber-700 text-white'
                      : 'bg-slate-800 text-slate-300'
                  }`}>
                    {r.rank}
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <TeamDot franchise={r.franchise} />
                      <span className="font-black text-white text-base">{r.franchiseName}</span>
                      <EligibilityBadge eligibility={r.eval?.eligibility} />
                      <span className="text-xs text-slate-500">
                        ({r.eval?.squadSize || 0}/{maxSquadSize} players · {r.eval?.counts?.overseas || 0}/{maxOverseas} overseas)
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed font-medium">
                      {r.reasonForPosition}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row md:flex-col items-start md:items-end gap-2 shrink-0 border-t md:border-t-0 pt-3 md:pt-0 border-slate-800">
                  <div className="text-xs text-emerald-300 font-semibold flex items-center gap-1">
                    <span className="text-[10px] text-slate-500 uppercase">Key Strength:</span> {r.mainStrength}
                  </div>
                  <div className="text-xs text-rose-300 font-semibold flex items-center gap-1">
                    <span className="text-[10px] text-slate-500 uppercase">Key Flaw:</span> {r.mainWeakness}
                  </div>
                  <button
                    onClick={() => { setSelectedFranchiseId(r.franchiseId); setTab('squads'); }}
                    className="text-xs font-bold text-amber-300 hover:text-amber-200 mt-1"
                  >
                    View Detailed Analysis →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* TAB 3: SECTION 3 (Franchise Deep-Dive) */}
      {tab === 'squads' && focusEval && (
        <div className="space-y-4">
          {/* Franchise Selector Pills */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {rankedList.map(r => (
              <button
                key={r.franchiseId}
                onClick={() => setSelectedFranchiseId(r.franchiseId)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border whitespace-nowrap transition ${
                  r.franchiseId === activeFocusId
                    ? 'border-amber-400 text-white bg-amber-400/15'
                    : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-white'
                }`}
              >
                <TeamDot franchise={r.franchise} />
                <span className="font-mono text-[10px] text-amber-400">#{r.rank}</span>
                {r.shortName}
              </button>
            ))}
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            {/* Left 2 Cols: Strategic Breakdown */}
            <div className="lg:col-span-2 space-y-4">
              <Panel
                title={`${focusEval.franchiseName} · Strategic Audit`}
                icon={Shield}
                right={<EligibilityBadge eligibility={focusEval.eligibility} />}
              >
                <p className="text-sm text-slate-200 leading-relaxed font-medium">
                  {focusEval.shortAssessment}
                </p>

                {/* 7 Core Dimensions */}
                <div className="space-y-3 pt-2">
                  <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3.5 space-y-1">
                    <div className="text-xs font-bold uppercase tracking-wider text-amber-300">Batting Unit</div>
                    <p className="text-xs text-slate-300 leading-relaxed">{focusEval.departments?.batting?.assessment || 'No batting assessment available.'}</p>
                  </div>

                  <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3.5 space-y-1">
                    <div className="text-xs font-bold uppercase tracking-wider text-amber-300">Pace Bowling Department</div>
                    <p className="text-xs text-slate-300 leading-relaxed">{focusEval.departments?.pace?.assessment || focusEval.departments?.bowling?.assessment || 'No pace bowling assessment available.'}</p>
                  </div>

                  <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3.5 space-y-1">
                    <div className="text-xs font-bold uppercase tracking-wider text-amber-300">Spin Bowling Department</div>
                    <p className="text-xs text-slate-300 leading-relaxed">{focusEval.departments?.spin?.assessment || focusEval.departments?.bowling?.assessment || 'No spin bowling assessment available.'}</p>
                  </div>

                  <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3.5 space-y-1">
                    <div className="text-xs font-bold uppercase tracking-wider text-amber-300">All-Rounder Balance</div>
                    <p className="text-xs text-slate-300 leading-relaxed">{focusEval.departments?.allRounders?.assessment || 'No all-rounder assessment available.'}</p>
                  </div>

                  <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3.5 space-y-1">
                    <div className="text-xs font-bold uppercase tracking-wider text-amber-300">Wicketkeeping Coverage</div>
                    <p className="text-xs text-slate-300 leading-relaxed">{focusEval.departments?.wicketkeeping?.assessment || 'No wicketkeeping assessment available.'}</p>
                  </div>

                  <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3.5 space-y-1">
                    <div className="text-xs font-bold uppercase tracking-wider text-amber-300">Overseas Strategy</div>
                    <p className="text-xs text-slate-300 leading-relaxed">{focusEval.departments?.overseas?.assessment || 'No overseas strategy assessment available.'}</p>
                  </div>

                  <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3.5 space-y-1">
                    <div className="text-xs font-bold uppercase tracking-wider text-amber-300">Bench Reserves &amp; Depth</div>
                    <p className="text-xs text-slate-300 leading-relaxed">{focusEval.departments?.benchStrength?.assessment || 'No bench depth assessment available.'}</p>
                  </div>
                </div>
              </Panel>

              {/* Squad Player List */}
              <Panel
                title={`Acquired Squad (${focusEval.squad?.length || 0} Players)`}
                icon={Users}
                right={
                  onInspectSquad && focusEval.participating ? (
                    <button
                      onClick={() => onInspectSquad(activeFocusId)}
                      className="text-xs font-bold text-amber-300 hover:text-amber-200"
                    >
                      Open Interactive Squad →
                    </button>
                  ) : null
                }
              >
                {!focusEval.squad?.length ? (
                  <p className="text-xs text-slate-500">No players acquired.</p>
                ) : (
                  <div className="space-y-3">
                    {Object.keys(CATEGORY_LABEL).map(cat => {
                      const ps = focusEval.squad.filter(p => p.category === cat);
                      if (!ps.length) return null;
                      return (
                        <div key={cat}>
                          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1.5">
                            {CATEGORY_LABEL[cat]} ({ps.length})
                          </div>
                          <div className="grid sm:grid-cols-2 gap-1.5">
                            {ps.map(p => (
                              <div
                                key={p.id}
                                className="flex items-center gap-2 rounded-lg bg-slate-900/60 border border-slate-800 px-2.5 py-1.5 text-xs"
                              >
                                <span className="text-white font-semibold truncate">{p.name}</span>
                                {p.isOverseas && (
                                  <span className="text-[10px] px-1.5 rounded bg-sky-500/15 text-sky-300 font-bold">
                                    OS
                                  </span>
                                )}
                                <span className="text-slate-500 truncate hidden sm:inline">{p.role}</span>
                                <span className="ml-auto font-mono text-amber-300 font-bold">{cr(p.boughtPrice)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Panel>
            </div>

            {/* Right Col: Tactical Cards */}
            <div className="space-y-4">
              {/* Critical Weaknesses Card */}
              <Panel title="Critical Squad Weaknesses" icon={AlertTriangle}>
                {focusEval.criticalWeaknesses.length === 0 ? (
                  <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" /> Zero critical squad weaknesses detected.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {focusEval.criticalWeaknesses.map((w, i) => (
                      <li key={i} className="text-xs text-rose-300 leading-snug flex items-start gap-2">
                        <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {/* Key Strengths Card */}
              <Panel title="Identified Strengths" icon={Award}>
                {focusEval.keyStrengths.length === 0 ? (
                  <p className="text-xs text-slate-500">None noted.</p>
                ) : (
                  <ul className="space-y-2">
                    {focusEval.keyStrengths.map((s, i) => (
                      <li key={i} className="text-xs text-emerald-300 leading-snug flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {/* Purse Allocation */}
              <Panel title="Auction Expenditure" icon={Wallet}>
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="text-slate-500 text-[10px]">Start Purse</div>
                    <div className="font-mono text-white font-bold mt-1">{cr(focusEval.purse?.initial)}</div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="text-slate-500 text-[10px]">Spent</div>
                    <div className="font-mono text-white font-bold mt-1">{cr(focusEval.purse?.spent)}</div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="text-slate-500 text-[10px]">Remaining</div>
                    <div className="font-mono text-emerald-400 font-bold mt-1">{cr(focusEval.purse?.remaining)}</div>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400 mt-2">
                  {focusEval.departments?.auctionStrategy?.assessment || ''}
                </p>
              </Panel>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: SECTION 5 (Biggest Mistakes) & SECTION 6 (Best Acquisitions) */}
      {tab === 'mistakes' && (
        <div className="space-y-6">
          {/* Section 5: Biggest Auction Mistakes */}
          <Panel title="Biggest Auction Mistakes Across Franchises" icon={AlertOctagon}>
            <p className="text-xs text-slate-400">
              Data-verified squad construction blunders identified during the auction. No fabricated player form or statistics.
            </p>

            {!(mastermind.biggestMistakes || []).length ? (
              <p className="text-xs text-emerald-300 py-4">No major squad-building blunders detected across franchises.</p>
            ) : (
              <div className="grid sm:grid-cols-2 gap-3 mt-3">
                {(mastermind.biggestMistakes || []).map((m, i) => (
                  <div
                    key={i}
                    className="rounded-xl bg-slate-900/80 border border-rose-900/40 p-4 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-white text-sm flex items-center gap-1.5">
                        <TeamDot franchise={room.franchises?.[m.franchiseId]} />
                        {m.franchiseName}
                      </span>
                      <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                        m.severity === 'CRITICAL'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      }`}>
                        {m.category}
                      </span>
                    </div>
                    <p className="text-xs text-rose-200/90 leading-relaxed">
                      {m.mistake}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Section 6: Best Acquisitions */}
          <Panel title="Best Strategic Acquisitions" icon={TrendingUp}>
            <p className="text-xs text-slate-400">
              Notable purchases that secured indispensable roles at high value or base price without inflationary waste.
            </p>

            {!(mastermind.bestAcquisitions || []).length ? (
              <p className="text-xs text-slate-500 py-4">No standout tactical acquisitions identified.</p>
            ) : (
              <div className="grid sm:grid-cols-2 gap-3 mt-3">
                {(mastermind.bestAcquisitions || []).map((a, i) => (
                  <div
                    key={i}
                    className="rounded-xl bg-slate-900/80 border border-emerald-900/40 p-4 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <TeamDot franchise={room.franchises?.[a.franchiseId]} />
                        <span className="font-bold text-white text-sm">{a.playerName}</span>
                      </div>
                      <span className="font-mono text-emerald-400 font-bold text-xs">{cr(a.priceCr)}</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {a.franchiseName} · {a.role}
                    </div>
                    <p className="text-xs text-emerald-200/90 leading-relaxed">
                      {a.reason}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Methodology & Limitations */}
          <Panel title="Cricket Mastermind Methodology &amp; Boundaries" icon={Info}>
            <ul className="text-xs text-slate-400 space-y-1.5">
              {(mastermind.limitations || []).map((note, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-amber-400 font-bold">•</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      {/* TAB 5: Head-to-Head Pairwise Comparison */}
      {tab === 'matchup' && (
        <Panel title="Tactical Head-to-Head Matchup Matrix" icon={Swords}>
          <p className="text-xs text-slate-400">
            Select any two franchises to inspect the exact qualitative cricket evaluation that determined their relative standing.
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-3 mt-3">
            <div className="w-full sm:w-1/2">
              <label className="text-[11px] uppercase tracking-wider text-slate-400 font-bold block mb-1">Franchise A</label>
              <select
                value={compareA || ''}
                onChange={e => setCompareA(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
              >
                {rankedList.map(r => (
                  <option key={r.franchiseId} value={r.franchiseId}>
                    #{r.rank} {r.franchiseName}
                  </option>
                ))}
              </select>
            </div>

            <div className="w-full sm:w-1/2">
              <label className="text-[11px] uppercase tracking-wider text-slate-400 font-bold block mb-1">Franchise B</label>
              <select
                value={compareB || ''}
                onChange={e => setCompareB(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
              >
                {rankedList.map(r => (
                  <option key={r.franchiseId} value={r.franchiseId}>
                    #{r.rank} {r.franchiseName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {compareA && compareB && compareA !== compareB && (() => {
            const matchup = mastermind.headToHead?.[compareA]?.[compareB];
            const evalA = mastermind.franchises[compareA];
            const evalB = mastermind.franchises[compareB];

            if (!matchup || !evalA || !evalB) return null;

            return (
              <div className="rounded-2xl bg-slate-900/80 border border-slate-800 p-5 space-y-4 mt-4">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-b border-slate-800 pb-4">
                  <div className="flex items-center gap-2">
                    <TeamDot franchise={room.franchises?.[compareA]} />
                    <span className="font-black text-white text-base">{evalA.franchiseName}</span>
                  </div>

                  <div className="px-3 py-1 rounded-full bg-amber-400/10 border border-amber-400/30 text-amber-300 text-xs font-black uppercase">
                    Advantage: {matchup.winner} ({matchup.margin})
                  </div>

                  <div className="flex items-center gap-2">
                    <TeamDot franchise={room.franchises?.[compareB]} />
                    <span className="font-black text-white text-base">{evalB.franchiseName}</span>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400 block">Decisive Rationale</span>
                  <p className="text-sm text-slate-200 leading-relaxed font-medium">{matchup.reason}</p>
                </div>

                <div className="grid sm:grid-cols-2 gap-4 text-xs pt-2">
                  <div className="space-y-2 border-r border-slate-800 pr-2">
                    <h5 className="font-bold text-white uppercase tracking-wider">{evalA.franchiseName} Profile</h5>
                    <p className="text-slate-300">Batting: {evalA.departments?.batting?.depthCount ?? evalA.counts?.BAT ?? 0} options ({evalA.departments?.batting?.openers?.length ?? 0} openers, {evalA.departments?.batting?.finishers?.length ?? 0} finishers)</p>
                    <p className="text-slate-300">Bowling: {evalA.departments?.bowling?.depthCount ?? evalA.counts?.BOWL ?? 0} options ({evalA.departments?.bowling?.deathBowlers?.length ?? 0} death specialists)</p>
                    <p className="text-slate-300">WKs: {evalA.departments?.wicketkeeping?.totalCount ?? evalA.counts?.WK ?? 0} ({(evalA.departments?.wicketkeeping?.totalCount ?? evalA.counts?.WK ?? 0) >= 2 ? 'Covered' : 'Vulnerable'})</p>
                    <p className="text-slate-300">All-rounders: {evalA.departments?.allRounders?.totalCount ?? evalA.counts?.AR ?? 0} ({evalA.departments?.allRounders?.genuineCount ?? 0} verified)</p>
                  </div>

                  <div className="space-y-2 pl-2">
                    <h5 className="font-bold text-white uppercase tracking-wider">{evalB.franchiseName} Profile</h5>
                    <p className="text-slate-300">Batting: {evalB.departments?.batting?.depthCount ?? evalB.counts?.BAT ?? 0} options ({evalB.departments?.batting?.openers?.length ?? 0} openers, {evalB.departments?.batting?.finishers?.length ?? 0} finishers)</p>
                    <p className="text-slate-300">Bowling: {evalB.departments?.bowling?.depthCount ?? evalB.counts?.BOWL ?? 0} options ({evalB.departments?.bowling?.deathBowlers?.length ?? 0} death specialists)</p>
                    <p className="text-slate-300">WKs: {evalB.departments?.wicketkeeping?.totalCount ?? evalB.counts?.WK ?? 0} ({(evalB.departments?.wicketkeeping?.totalCount ?? evalB.counts?.WK ?? 0) >= 2 ? 'Covered' : 'Vulnerable'})</p>
                    <p className="text-slate-300">All-rounders: {evalB.departments?.allRounders?.totalCount ?? evalB.counts?.AR ?? 0} ({evalB.departments?.allRounders?.genuineCount ?? 0} verified)</p>
                  </div>
                </div>
              </div>
            );
          })()}
        </Panel>
      )}
    </div>
  );
}
