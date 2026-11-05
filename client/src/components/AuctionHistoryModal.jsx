import React, { useState } from 'react';
import { X, Search, Filter, History, CheckCircle, XCircle, Shield } from 'lucide-react';

export default function AuctionHistoryModal({
  room,
  isOpen,
  onClose
}) {
  const [tab, setTab] = useState('players'); // 'players' | 'audit'
  const [filterStatus, setFilterStatus] = useState('ALL'); // 'ALL' | 'SOLD' | 'UNSOLD'
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');

  if (!isOpen) return null;

  const filteredHistory = (room.history || []).filter(item => {
    if (filterStatus !== 'ALL' && item.status !== filterStatus) return false;
    if (categoryFilter !== 'ALL' && item.player?.category !== categoryFilter) return false;
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      const matchName = item.player?.name.toLowerCase().includes(q);
      const matchTeam = item.winningFranchiseName?.toLowerCase().includes(q);
      if (!matchName && !matchTeam) return false;
    }
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xl flex items-center justify-center p-4">
      <div className="glass-panel border-glow-gold rounded-3xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Modal Top Bar */}
        <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center text-amber-400">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Auction Records & History</h2>
              <p className="text-xs text-slate-300">Real-time log of sold lots and audit events</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex bg-slate-950/90 p-1 rounded-full border border-white/10 text-xs font-bold">
              <button
                onClick={() => setTab('players')}
                className={`px-3.5 py-1.5 rounded-full transition cursor-pointer ${
                  tab === 'players' ? 'gold-btn text-slate-950 font-black' : 'text-slate-400 hover:text-white'
                }`}
              >
                Lots ({room.history?.length || 0})
              </button>
              <button
                onClick={() => setTab('audit')}
                className={`px-3.5 py-1.5 rounded-full transition cursor-pointer ${
                  tab === 'audit' ? 'gold-btn text-slate-950 font-black' : 'text-slate-400 hover:text-white'
                }`}
              >
                Audit Log
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {tab === 'players' ? (
          <>
            {/* Filter and Search Bar */}
            <div className="p-4 bg-slate-900/40 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-1 min-w-[240px]">
                <div className="relative w-full">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search player or winning team..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-amber-400 outline-none"
                  />
                </div>
              </div>

              {/* Status and Category Filters */}
              <div className="flex items-center gap-2">
                <select
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 outline-none"
                >
                  <option value="ALL">All Outcomes</option>
                  <option value="SOLD">Sold Only</option>
                  <option value="UNSOLD">Unsold Only</option>
                </select>

                <select
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 outline-none"
                >
                  <option value="ALL">All Roles</option>
                  <option value="BAT">Batters</option>
                  <option value="FAST">Fast Bowlers</option>
                  <option value="SPIN">Spin Bowlers</option>
                  <option value="AR">All-Rounders</option>
                  <option value="WK">Wicketkeepers</option>
                </select>
              </div>
            </div>

            {/* List Body */}
            <div className="p-5 overflow-y-auto flex-1 space-y-2">
              {filteredHistory.length === 0 ? (
                <div className="text-center py-16 text-slate-500 text-sm">
                  No lots match your search criteria.
                </div>
              ) : (
                filteredHistory.map((item, idx) => {
                  const isSold = item.status === 'SOLD';
                  return (
                    <div
                      key={item.lotNumber + '_' + idx}
                      className="p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-xl bg-slate-800 flex items-center justify-center text-xs font-mono font-bold text-slate-400">
                          #{item.lotNumber}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-extrabold text-white text-sm">{item.player.name}</span>
                            <span className="text-[10px] font-bold text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
                              {item.player.category}
                            </span>
                            {item.player.isOverseas && (
                              <span className="text-[10px] font-bold text-blue-400 bg-blue-500/10 px-1 rounded">
                                OS
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-400">
                            Base: ₹{item.player.basePrice.toFixed(2)} Cr • {item.player.country}
                          </div>
                        </div>
                      </div>

                      <div className="text-right flex items-center gap-4">
                        {isSold ? (
                          <div>
                            <div className="text-xs font-bold font-mono text-emerald-400">
                              ₹{item.finalBid.toFixed(2)} Cr
                            </div>
                            <div className="text-[11px] font-semibold text-amber-400">
                              Sold to {item.winningFranchiseCode}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs font-bold text-slate-500 bg-slate-800/80 px-2 py-1 rounded-lg">
                            UNSOLD
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          /* Audit Log Tab */
          <div className="p-5 overflow-y-auto flex-1 space-y-2 font-mono text-xs">
            {(room.auditLog || []).map((entry, idx) => (
              <div key={idx} className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3">
                <span className="text-slate-500 flex-shrink-0 text-[11px]">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-amber-400 font-bold uppercase text-[10px] bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                  {entry.type}
                </span>
                <span className="text-slate-300 text-xs">
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
