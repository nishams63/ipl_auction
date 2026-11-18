import React, { useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import UnityArena from './UnityArena';
import {
  Trophy, ArrowLeft, BarChart2, Users, Sparkles, GitCompare, CheckCircle2, XCircle,
  MinusCircle, AlertTriangle, RefreshCw, Shield, Wallet, Gavel, Info
} from 'lucide-react';

// Post-auction results. Every number shown here comes from the server's deterministic
// evaluation snapshot (room.analysis); AI text (room.aiAnalysis) only explains it.

const DIM_ORDER = ['battingDepth', 'bowlingDepth', 'paceOptions', 'spinOptions', 'allRounders', 'keeperCoverage', 'overseasBalance', 'squadDepth', 'squadComposition', 'xiCompatibility'];
const DIM_LABEL = {
  battingDepth: 'Batting depth', bowlingDepth: 'Bowling depth', paceOptions: 'Pace options', spinOptions: 'Spin options',
  allRounders: 'All-rounders', keeperCoverage: 'Wicketkeeper coverage', overseasBalance: 'Overseas balance',
  squadDepth: 'Squad depth', squadComposition: 'Squad composition', xiCompatibility: 'Playing XI compatibility'
};
const CATEGORY_LABEL = { BAT: 'Batters', WK: 'Wicketkeepers', AR: 'All-rounders', BOWL: 'Pace bowlers', SP: 'Spinners' };
const cr = v => (typeof v === 'number' ? `₹${v.toFixed(2)} Cr` : '—');
const scoreColor = v => (v >= 80 ? 'bg-emerald-500' : v >= 50 ? 'bg-amber-400' : 'bg-rose-500');

function ScoreBar({ value, max = 100 }) {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className={`h-full rounded-full ${scoreColor(value)}`} style={{ width: `${w}%` }} />
    </div>
  );
}

function EligibilityBadge({ eligibility }) {
  if (eligibility.status === 'ELIGIBLE') {
    return <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"><CheckCircle2 className="w-3 h-3" />Eligible</span>;
  }
  if (eligibility.status === 'NOT_PARTICIPATING') {
    return <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-700/40 text-slate-400 border border-slate-600/40"><MinusCircle className="w-3 h-3" />Did not take part</span>;
  }
  return <span title={eligibility.failures.join('\n')} className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 cursor-help"><XCircle className="w-3 h-3" />Not eligible</span>;
}

function TeamDot({ franchise }) {
  return <span className="inline-block w-3 h-3 rounded-full ring-2 ring-slate-900 shrink-0" style={{ background: franchise?.primaryColor || '#64748b' }} />;
}

function Panel({ title, icon: Icon, children, right }) {
  return (
    <section className="glass-panel rounded-2xl border border-slate-800 p-4 sm:p-5 space-y-4">
      {(title || right) && (
        <div className="flex items-center justify-between gap-3">
          {title && <h3 className="text-sm font-black uppercase tracking-wider text-slate-300 flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-amber-400" />}{title}</h3>}
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

function List({ items, tone }) {
  if (!items || items.length === 0) return <p className="text-xs text-slate-500">None noted.</p>;
  const color = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : 'text-sky-300';
  return <ul className="space-y-1.5">{items.map((t, i) => <li key={i} className={`text-sm ${color} leading-snug`}>• <span className="text-slate-200">{t}</span></li>)}</ul>;
}

export default function FinalResultsView({ room, participant, onInspectSquad, onBackToLobby, onRequestAiAnalysis }) {
  const analysis = room.analysis;
  const ai = room.aiAnalysis || { status: 'none', available: false, generating: false };
  const [tab, setTab] = useState('summary');
  const [selected, setSelected] = useState(null);
  const [compare, setCompare] = useState([]);
  const [aiMessage, setAiMessage] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    try {
      confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
      const timer = setTimeout(() => {
        confetti({ particleCount: 80, angle: 60, spread: 55, origin: { x: 0 } });
        confetti({ particleCount: 80, angle: 120, spread: 55, origin: { x: 1 } });
      }, 400);
      return () => clearTimeout(timer);
    } catch { /* confetti is decorative */ }
  }, []);

  const ranked = useMemo(() => (analysis ? analysis.rankings.map(r => ({ ...r, e: analysis.franchises[r.franchiseId] })) : []), [analysis]);
  const playing = ranked.filter(r => r.e.participating);
  const focusId = selected || playing[0]?.franchiseId || ranked[0]?.franchiseId;

  if (!analysis) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center">
        <h2 className="text-2xl font-bold text-white">Calculating final standings…</h2>
        <p className="text-slate-400 text-sm mt-2">The server is preparing the post-auction evaluation.</p>
      </div>
    );
  }

  const isParticipant = !!participant;
  const isHost = !!participant?.isHost;
  const requestAi = force => {
    if (!onRequestAiAnalysis || aiBusy) return;
    setAiBusy(true);
    setAiMessage(null);
    onRequestAiAnalysis(force, res => {
      setAiBusy(false);
      if (!res?.success) setAiMessage(res?.error || 'The AI analysis could not be requested.');
      else if (res.status === 'unavailable') setAiMessage(res.message);
    });
  };
  const toggleCompare = fid => setCompare(c => (c.includes(fid) ? c.filter(x => x !== fid) : c.length >= 4 ? c : [...c, fid]));
  const franchiseOf = fid => room.franchises[fid];
  const s = analysis.summary;
  const leader = playing[0];

  const tabs = [
    ['summary', 'Summary', Trophy], ['leaderboard', 'Leaderboard', BarChart2], ['squads', 'Squad analysis', Users],
    ['ai', 'AI analysis', Sparkles], ['compare', 'Compare', GitCompare]
  ];

  const awardCard = (title, award, valueKey = 'score') => (
    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-4">
      <div className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">{title}</div>
      {award?.winner ? (
        <div className="mt-2 flex items-center gap-2">
          <TeamDot franchise={franchiseOf(award.winner)} />
          <span className="text-white font-black">{analysis.franchises[award.winner].franchiseName}</span>
          <span className="ml-auto text-amber-300 font-mono text-sm">{award[valueKey]}</span>
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-400">No award: {award?.reason || 'not enough evidence'}.</p>
      )}
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-6">
      <UnityArena room={room} compact />
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBackToLobby} className="p-2 rounded-full border border-slate-700 text-slate-300 hover:text-white hover:border-amber-400/60 transition" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">Auction <span className="gold-gradient-text">Results</span></h2>
            <p className="text-xs text-slate-400">Room {room.roomCode} · completed · scores by the deterministic engine {analysis.engineVersion}</p>
          </div>
        </div>
        {leader && (
          <div className="flex items-center gap-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 px-4 py-2">
            <Trophy className="w-5 h-5 text-amber-400" />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-amber-300/80 font-bold">{leader.e.eligibility.eligible ? 'Top ranked squad' : 'Top score (no squad met the rules)'}</div>
              <div className="text-white font-black flex items-center gap-2"><TeamDot franchise={franchiseOf(leader.franchiseId)} />{leader.e.franchiseName} · {leader.overall}</div>
            </div>
          </div>
        )}
      </div>

      <nav className="flex gap-2 overflow-x-auto pb-1" role="tablist">
        {tabs.map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap border transition ${tab === id ? 'bg-amber-400 text-slate-950 border-amber-400' : 'border-slate-700 text-slate-300 hover:border-amber-400/50 hover:text-white'}`}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </nav>

      {tab === 'summary' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Players sold" value={s.playersSold} sub={`${s.playersUnsold} unsold · ${s.playersSkipped} skipped${s.playersNotAuctioned ? ` · ${s.playersNotAuctioned} not auctioned` : ''}`} />
            <Stat label="Total spent" value={cr(s.totalExpenditure)} sub={`by ${s.participatingFranchises} franchise(s)`} />
            <Stat label="Purse remaining" value={cr(s.totalRemainingPurse)} sub="across participating franchises" />
            <Stat label="Squads meeting the rules" value={`${s.eligibleFranchises}/${s.participatingFranchises}`} sub={`squad ${analysis.rules.minSquadSize}–${analysis.rules.maxSquadSize}, ≤${analysis.rules.maxOverseas} overseas, ≥${analysis.rules.minWKs} WK`} />
          </div>
          <Panel title="Category leaders" icon={Trophy}>
            <div className="grid sm:grid-cols-3 gap-3">
              {awardCard('Best balanced squad', analysis.awards.bestBalanced)}
              {awardCard('Strongest batting unit', analysis.awards.strongestBatting)}
              {awardCard('Strongest bowling unit', analysis.awards.strongestBowling)}
            </div>
            {analysis.awards.biggestWeakness.league && (
              <p className="text-sm text-slate-300 flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                League-wide weakest area: <b className="text-white">{analysis.awards.biggestWeakness.league.label}</b> (average {analysis.awards.biggestWeakness.league.averageScore}/100).</p>
            )}
          </Panel>
          <Panel title="Bought at base price" icon={Gavel}>
            <p className="text-xs text-slate-400">{analysis.awards.basePriceBuys.note}</p>
            {analysis.awards.basePriceBuys.players.length > 0 && (
              <div className="grid sm:grid-cols-2 gap-2">
                {analysis.awards.basePriceBuys.players.map(p => (
                  <div key={p.playerId} className="flex items-center gap-2 rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2 text-sm">
                    <TeamDot franchise={franchiseOf(p.franchiseId)} />
                    <span className="text-white font-semibold truncate">{p.playerName}</span>
                    <span className="text-slate-500 text-xs">{CATEGORY_LABEL[p.category] || p.category}</span>
                    <span className="ml-auto font-mono text-amber-300">{cr(p.price)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="About these scores" icon={Info}>
            <ul className="text-xs text-slate-400 space-y-1">{analysis.dataNotes.map((n, i) => <li key={i}>• {n}</li>)}</ul>
          </Panel>
        </div>
      )}

      {tab === 'leaderboard' && (
        <Panel title="All ten franchises" icon={BarChart2}>
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="text-left px-2 py-2">Rank</th><th className="text-left px-2">Franchise</th><th className="text-left px-2 w-48">Overall</th>
                  <th className="px-2">Batting</th><th className="px-2">Bowling</th><th className="px-2">All-round</th><th className="px-2">Balance</th>
                  <th className="px-2">Eligibility</th><th className="text-right px-2">Purse left</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(r => (
                  <tr key={r.franchiseId} className={`border-t border-slate-800/80 ${r.e.participating ? '' : 'opacity-50'}`}>
                    <td className="px-2 py-3 font-black text-white">{r.tied ? `T${r.rank}` : r.rank}</td>
                    <td className="px-2"><button onClick={() => { setSelected(r.franchiseId); setTab('squads'); }} className="flex items-center gap-2 text-left hover:text-amber-300"><TeamDot franchise={franchiseOf(r.franchiseId)} /><span className="font-bold text-white">{r.e.franchiseName}</span></button></td>
                    <td className="px-2"><div className="flex items-center gap-2"><span className="font-mono font-bold text-white w-12">{r.overall}</span><ScoreBar value={r.overall} /></div></td>
                    <td className="px-2 text-center font-mono text-slate-200">{r.e.headline.batting}</td>
                    <td className="px-2 text-center font-mono text-slate-200">{r.e.headline.bowling}</td>
                    <td className="px-2 text-center font-mono text-slate-200">{r.e.headline.allRounder}</td>
                    <td className="px-2 text-center font-mono text-slate-200">{r.e.headline.balance}</td>
                    <td className="px-2 text-center"><EligibilityBadge eligibility={r.e.eligibility} /></td>
                    <td className="px-2 text-right font-mono text-slate-200">{r.e.participating ? cr(r.e.purse.remaining) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">Squads that meet the auction rules rank first, then squads that do not, then franchises that did not take part. Equal scores share a rank (shown as T) and are listed alphabetically. Remaining purse does not add to the score.</p>
        </Panel>
      )}

      {tab === 'squads' && focusId && (() => {
        const e = analysis.franchises[focusId];
        const f = franchiseOf(focusId);
        const squad = f?.squad || [];
        return (
          <div className="space-y-4">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {ranked.map(r => (
                <button key={r.franchiseId} onClick={() => setSelected(r.franchiseId)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border whitespace-nowrap ${r.franchiseId === focusId ? 'border-amber-400 text-white bg-amber-400/10' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
                  <TeamDot franchise={franchiseOf(r.franchiseId)} />{r.e.shortName}
                </button>
              ))}
            </div>
            <div className="grid lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3 space-y-4">
                <Panel title={`${e.franchiseName} — ${e.overall}/100`} icon={Shield} right={<EligibilityBadge eligibility={e.eligibility} />}>
                  {!e.eligibility.eligible && e.participating && <ul className="text-xs text-rose-300 space-y-1">{e.eligibility.failures.map((x, i) => <li key={i}>• {x}</li>)}</ul>}
                  <div className="space-y-2.5">
                    {DIM_ORDER.map(k => (
                      <div key={k} className="grid grid-cols-12 items-center gap-2 text-xs">
                        <span className="col-span-5 sm:col-span-4 text-slate-300">{DIM_LABEL[k]} <span className="text-slate-500">({analysis.weights[k]}%)</span></span>
                        <span className="col-span-5 sm:col-span-6"><ScoreBar value={e.dimensions[k]} /></span>
                        <span className="col-span-2 text-right font-mono text-white">{e.dimensions[k]}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel title={`Squad (${squad.length})`} icon={Users} right={onInspectSquad && e.participating ? <button onClick={() => onInspectSquad(focusId)} className="text-xs font-bold text-amber-300 hover:text-amber-200">Open squad</button> : null}>
                  {squad.length === 0 ? <p className="text-sm text-slate-500">No players.</p> : (
                    <div className="space-y-3">
                      {Object.keys(CATEGORY_LABEL).map(cat => {
                        const ps = squad.filter(p => p.category === cat);
                        if (!ps.length) return null;
                        return (
                          <div key={cat}>
                            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">{CATEGORY_LABEL[cat]} ({ps.length})</div>
                            <div className="grid sm:grid-cols-2 gap-1.5">
                              {ps.map(p => (
                                <div key={p.id} className="flex items-center gap-2 rounded-lg bg-slate-900/60 border border-slate-800 px-2.5 py-1.5 text-xs">
                                  <span className="text-white font-semibold truncate">{p.name}</span>
                                  {p.isOverseas && <span className="text-[10px] px-1.5 rounded bg-sky-500/15 text-sky-300">OS</span>}
                                  <span className="text-slate-500 truncate hidden sm:inline">{p.role}</span>
                                  <span className="ml-auto font-mono text-amber-300">{cr(p.boughtPrice)}</span>
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
              <div className="lg:col-span-2 space-y-4">
                <Panel title="Composition" icon={BarChart2}>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {Object.entries(CATEGORY_LABEL).map(([k, l]) => <div key={k} className="flex justify-between rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2"><span className="text-slate-400">{l}</span><b className="text-white">{e.counts[k]}</b></div>)}
                    <div className="flex justify-between rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2"><span className="text-slate-400">Overseas</span><b className="text-white">{e.counts.overseas}/{analysis.rules.maxOverseas}</b></div>
                    <div className="flex justify-between rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2"><span className="text-slate-400">Indian</span><b className="text-white">{e.counts.indian}</b></div>
                  </div>
                  <div className="text-xs text-slate-400 space-y-1">
                    <div>Batting options {e.roleOptions.battingOptions} · bowling options {e.roleOptions.bowlingOptions}</div>
                    <div>Pace {e.roleOptions.paceOptions} · spin {e.roleOptions.spinOptions} · AR pace/spin/unknown {e.counts.arPace}/{e.counts.arSpin}/{e.counts.arUnknownBowling}</div>
                    {e.counts.unclassified > 0 && <div className="text-amber-300">{e.counts.unclassified} player(s) without a recognised role</div>}
                  </div>
                </Panel>
                <Panel title="Playing XI checks" icon={CheckCircle2}>
                  <ul className="space-y-1.5">{e.xiChecks.map(c => <li key={c.id} className="flex items-start gap-2 text-xs">{c.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <XCircle className="w-4 h-4 text-rose-400 shrink-0" />}<span className="text-slate-300">{c.label}</span></li>)}</ul>
                </Panel>
                <Panel title="Purse" icon={Wallet}>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div><div className="text-slate-500">Start</div><div className="font-mono text-white">{cr(e.purse.initial)}</div></div>
                    <div><div className="text-slate-500">Spent</div><div className="font-mono text-white">{cr(e.purse.spent)}</div></div>
                    <div><div className="text-slate-500">Left</div><div className="font-mono text-white">{cr(e.purse.remaining)}</div></div>
                  </div>
                </Panel>
              </div>
            </div>
          </div>
        );
      })()}

      {tab === 'ai' && (
        <div className="space-y-4">
          <Panel title="AI analysis" icon={Sparkles} right={
            <div className="flex items-center gap-2">
              {ai.generating && <span className="text-xs text-amber-300 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5 animate-spin" />Generating…</span>}
              {isParticipant && ai.available && !ai.generating && !ai.result && (
                <button onClick={() => requestAi(false)} disabled={aiBusy} className="gold-btn px-4 py-1.5 rounded-full text-slate-950 text-xs font-black disabled:opacity-50">Generate AI analysis</button>
              )}
              {isHost && ai.available && !ai.generating && ai.result && (
                <button onClick={() => requestAi(true)} disabled={aiBusy} className="px-3 py-1.5 rounded-full border border-slate-700 text-slate-300 text-xs font-bold hover:border-amber-400/50 disabled:opacity-50 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" />Regenerate</button>
              )}
            </div>
          }>
            {aiMessage && <p className="text-xs text-amber-300">{aiMessage}</p>}
            {!ai.available && <p className="text-xs text-slate-400">AI analysis is not configured on this server. The rule-based analysis below is complete and uses the same verified data.</p>}
            {ai.lastError && <p className="text-xs text-rose-300">Last AI attempt failed ({ai.lastError.code}). {ai.result ? 'The previous AI report is still shown.' : 'Rule-based analysis is shown instead.'}</p>}
            {ai.result ? (
              <div className="space-y-3">
                <p className="text-[11px] text-slate-500">Written by AI ({ai.model}) from the verified auction data. It explains the scores; it cannot change scores, ranks or eligibility.</p>
                {ai.result.summary && <div><h4 className="text-xs font-bold uppercase tracking-wider text-amber-300 mb-1">Auction summary</h4><p className="text-sm text-slate-200 whitespace-pre-line">{ai.result.summary}</p></div>}
                {ai.result.comparison && <div><h4 className="text-xs font-bold uppercase tracking-wider text-amber-300 mb-1">How the franchises compare</h4><p className="text-sm text-slate-200 whitespace-pre-line">{ai.result.comparison}</p></div>}
                {ai.problems?.length > 0 && <details className="text-xs text-slate-500"><summary className="cursor-pointer">Checks applied to the AI output ({ai.problems.length})</summary><ul className="mt-1 space-y-0.5">{ai.problems.map((p, i) => <li key={i}>• {p}</li>)}</ul></details>}
              </div>
            ) : (
              <p className="text-xs text-slate-400">Showing the rule-based analysis generated by the scoring engine.</p>
            )}
          </Panel>
          {ranked.filter(r => r.e.participating).map(r => {
            const e = r.e;
            const aiEntry = ai.result?.franchises?.[r.franchiseId];
            const src = aiEntry || e.explanation;
            const squadById = new Map((franchiseOf(r.franchiseId)?.squad || []).map(p => [p.id, p]));
            return (
              <Panel key={r.franchiseId} title={`${r.tied ? `T${r.rank}` : r.rank}. ${e.franchiseName} — ${e.overall}/100`} icon={Shield}
                right={<div className="flex items-center gap-2"><span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${aiEntry ? 'bg-violet-500/15 text-violet-300' : 'bg-slate-700/50 text-slate-300'}`}>{aiEntry ? 'AI report' : 'Rule-based'}</span><EligibilityBadge eligibility={e.eligibility} /></div>}>
                <p className="text-sm text-slate-200 leading-relaxed">{src.report}</p>
                <div className="grid md:grid-cols-3 gap-4">
                  <div><h4 className="text-xs font-bold uppercase tracking-wider text-emerald-300 mb-1.5">Strengths</h4><List items={src.strengths} tone="good" /></div>
                  <div><h4 className="text-xs font-bold uppercase tracking-wider text-rose-300 mb-1.5">Weaknesses</h4><List items={src.weaknesses} tone="bad" /></div>
                  <div><h4 className="text-xs font-bold uppercase tracking-wider text-sky-300 mb-1.5">Recommendations</h4><List items={src.recommendations} /></div>
                </div>
                {aiEntry?.suggestedXI?.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-amber-300 mb-1.5">Suggested XI (AI, checked against the squad)</h4>
                    <div className="flex flex-wrap gap-1.5">{aiEntry.suggestedXI.map(id => <span key={id} className="text-xs px-2 py-1 rounded-lg bg-slate-900/60 border border-slate-800 text-slate-200">{squadById.get(id)?.name || id}{squadById.get(id)?.isOverseas ? ' (OS)' : ''}</span>)}</div>
                  </div>
                )}
                {aiEntry?.missingInformation?.length > 0 && <p className="text-xs text-slate-500">Not available in the data: {aiEntry.missingInformation.join('; ')}</p>}
              </Panel>
            );
          })}
        </div>
      )}

      {tab === 'compare' && (
        <Panel title="Compare franchises" icon={GitCompare}>
          <p className="text-xs text-slate-400">Pick two to four franchises. Every value comes from the final squads.</p>
          <div className="flex flex-wrap gap-2">
            {playing.map(r => (
              <button key={r.franchiseId} onClick={() => toggleCompare(r.franchiseId)} aria-pressed={compare.includes(r.franchiseId)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border ${compare.includes(r.franchiseId) ? 'border-amber-400 bg-amber-400/10 text-white' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
                <TeamDot franchise={franchiseOf(r.franchiseId)} />{r.e.shortName}
              </button>
            ))}
          </div>
          {compare.length < 2 ? <p className="text-sm text-slate-500">Select at least two franchises.</p> : (() => {
            const cols = compare.map(fid => analysis.franchises[fid]);
            const rows = [
              ['Overall score', e => e.overall, true],
              ...DIM_ORDER.map(k => [DIM_LABEL[k], e => e.dimensions[k], true]),
              ['Players', e => e.counts.total, null], ['Batters', e => e.counts.BAT, null], ['Wicketkeepers', e => e.counts.WK, null],
              ['All-rounders', e => e.counts.AR, null], ['Pace bowlers', e => e.counts.BOWL, null], ['Spinners', e => e.counts.SP, null],
              ['Overseas', e => e.counts.overseas, null], ['Spent (₹ Cr)', e => e.purse.spent, null], ['Purse left (₹ Cr)', e => e.purse.remaining, null]
            ];
            return (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm">
                  <thead><tr><th className="text-left px-2 py-2 text-[11px] uppercase text-slate-400">Measure</th>{cols.map(e => <th key={e.franchiseId} className="px-2 text-center"><span className="inline-flex items-center gap-1.5 text-white"><TeamDot franchise={franchiseOf(e.franchiseId)} />{e.shortName}</span></th>)}</tr></thead>
                  <tbody>
                    {rows.map(([label, get, higherIsBetter]) => {
                      const vals = cols.map(get);
                      const best = higherIsBetter ? Math.max(...vals) : null;
                      return (
                        <tr key={label} className="border-t border-slate-800/80">
                          <td className="px-2 py-2 text-slate-300">{label}</td>
                          {vals.map((v, i) => <td key={i} className={`px-2 text-center font-mono ${higherIsBetter && v === best && vals.filter(x => x === best).length === 1 ? 'text-emerald-300 font-bold' : 'text-slate-200'}`}>{typeof v === 'number' ? v : '—'}</td>)}
                        </tr>
                      );
                    })}
                    <tr className="border-t border-slate-800/80"><td className="px-2 py-2 text-slate-300">Eligibility</td>{cols.map(e => <td key={e.franchiseId} className="px-2 text-center"><EligibilityBadge eligibility={e.eligibility} /></td>)}</tr>
                  </tbody>
                </table>
              </div>
            );
          })()}
        </Panel>
      )}
    </div>
  );
}
