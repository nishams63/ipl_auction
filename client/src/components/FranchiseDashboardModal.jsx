import React, { useState, useEffect } from 'react';
import {
  X, Users, Shield, DollarSign, Award, ChevronUp, ChevronDown,
  UserCheck, AlertCircle, CheckCircle2, Star, Plane, Crown, Flag,
  Layers, Trophy
} from 'lucide-react';
import { socket } from '../utils/socket';

// Franchise logo/emblem badge
function FranchiseBadge({ code, size = "md" }) {
  const colors = {
    CSK: { bg: "#FACC15", text: "#1E3A8A", border: "#EAB308" },
    MI: { bg: "#004BA0", text: "#FFFFFF", border: "#D1AB3E" },
    RCB: { bg: "#EC1C24", text: "#FFFFFF", border: "#D4AF37" },
    KKR: { bg: "#3A225D", text: "#F7D54E", border: "#F7D54E" },
    SRH: { bg: "#F26522", text: "#FFFFFF", border: "#000000" },
    RR: { bg: "#EA1B85", text: "#FFFFFF", border: "#254AA5" },
    DC: { bg: "#0078BC", text: "#FFFFFF", border: "#EF1B23" },
    PBKS: { bg: "#DD1F2D", text: "#FFFFFF", border: "#D7A22A" },
    GT: { bg: "#0B4973", text: "#FFFFFF", border: "#C89945" },
    LSG: { bg: "#00B4D8", text: "#FFFFFF", border: "#F77F00" }
  };
  const c = colors[code] || { bg: "#1E293B", text: "#FFFFFF", border: "#475569" };

  return (
    <div
      className={`rounded-xl flex items-center justify-center font-black tracking-tighter shadow-md border flex-shrink-0 ${
        size === "sm" ? "w-7 h-7 text-[10px]" : size === "lg" ? "w-14 h-14 text-xl" : "w-10 h-10 text-sm"
      }`}
      style={{ backgroundColor: c.bg, color: c.text, borderColor: c.border }}
    >
      {code}
    </div>
  );
}

export default function FranchiseDashboardModal({
  room,
  isOpen,
  onClose,
  initialFranchiseId,
  myFranchise,
  participant
}) {
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'squad' | 'playing_xi'
  const [selectedFranchiseId, setSelectedFranchiseId] = useState(
    initialFranchiseId || myFranchise?.id || Object.keys(room?.franchises || {})[0] || 'CSK'
  );

  // Playing XI editing state for selected franchise
  const [playingXIIds, setPlayingXIIds] = useState([]);
  const [captainId, setCaptainId] = useState(null);
  const [viceCaptainId, setViceCaptainId] = useState(null);
  const [impactPlayerId, setImpactPlayerId] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Sync selected franchise with props when opened
  useEffect(() => {
    if (initialFranchiseId) {
      setSelectedFranchiseId(initialFranchiseId);
    }
  }, [initialFranchiseId, isOpen]);

  // Load existing Playing XI when switching franchise or room updates
  const franchise = room?.franchises?.[selectedFranchiseId] || Object.values(room?.franchises || {})[0];

  useEffect(() => {
    if (franchise) {
      setPlayingXIIds(franchise.playingXI || []);
      setCaptainId(franchise.captainId || null);
      setViceCaptainId(franchise.viceCaptainId || null);
      setImpactPlayerId(franchise.impactPlayerId || null);
      setSaveSuccess(false);
      setSaveError(null);
    }
  }, [franchise?.id, franchise?.playingXI, isOpen]);

  if (!isOpen || !room) return null;

  const squad = franchise?.squad || [];
  const squadMap = new Map(squad.map(p => [p.id, p]));

  // Is current user owner of this franchise?
  const isOwner = myFranchise?.id === franchise?.id;
  const isHost = participant?.isHost;
  const canEdit = isOwner; // Only owner can edit, host can view all

  // Playing XI calculations
  const playingXIPlayers = playingXIIds.map(id => squadMap.get(id)).filter(Boolean);
  const benchPlayers = squad.filter(p => !playingXIIds.includes(p.id));
  const overseasInXI = playingXIPlayers.filter(p => p.isOverseas).length;
  const wkInXI = playingXIPlayers.filter(p => p.category === 'WK').length;

  // Validation indicators
  const has11 = playingXIIds.length === 11;
  const overseasValid = overseasInXI <= 4;
  const hasMinWK = wkInXI >= 1;
  const hasCaptain = !!captainId && playingXIIds.includes(captainId);
  const hasViceCaptain = !!viceCaptainId && playingXIIds.includes(viceCaptainId) && viceCaptainId !== captainId;
  const isXIComplete = has11 && overseasValid && hasMinWK && hasCaptain && hasViceCaptain;

  // Playing XI Actions
  const addToXI = (player) => {
    if (!canEdit) return;
    if (playingXIIds.length >= 11) {
      setSaveError("Playing XI can have at most 11 players. Remove a player first.");
      return;
    }
    if (player.isOverseas && overseasInXI >= 4) {
      setSaveError("Playing XI can have at most 4 overseas players.");
      return;
    }
    if (impactPlayerId === player.id) {
      setImpactPlayerId(null);
    }
    setSaveError(null);
    setSaveSuccess(false);
    setPlayingXIIds(prev => [...prev, player.id]);
  };

  const removeFromXI = (playerId) => {
    if (!canEdit) return;
    setSaveError(null);
    setSaveSuccess(false);
    setPlayingXIIds(prev => prev.filter(id => id !== playerId));
    if (captainId === playerId) setCaptainId(null);
    if (viceCaptainId === playerId) setViceCaptainId(null);
  };

  const movePosition = (index, direction) => {
    if (!canEdit) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= playingXIIds.length) return;
    const newArr = [...playingXIIds];
    const temp = newArr[index];
    newArr[index] = newArr[targetIndex];
    newArr[targetIndex] = temp;
    setPlayingXIIds(newArr);
    setSaveSuccess(false);
  };

  const toggleCaptain = (playerId) => {
    if (!canEdit) return;
    if (captainId === playerId) {
      setCaptainId(null);
    } else {
      setCaptainId(playerId);
      if (viceCaptainId === playerId) setViceCaptainId(null);
    }
    setSaveSuccess(false);
  };

  const toggleViceCaptain = (playerId) => {
    if (!canEdit) return;
    if (viceCaptainId === playerId) {
      setViceCaptainId(null);
    } else {
      setViceCaptainId(playerId);
      if (captainId === playerId) setCaptainId(null);
    }
    setSaveSuccess(false);
  };

  const savePlayingXI = () => {
    if (!canEdit) return;
    setSaveError(null);

    socket.emit('update_playing_xi', {
      roomCode: room.roomCode,
      participantToken: participant?.token || myFranchise?.ownerToken,
      franchiseId: franchise.id,
      playingXI: playingXIIds,
      captainId,
      viceCaptainId,
      wicketKeeperId: playingXIPlayers.find(p => p.category === 'WK')?.id || null,
      impactPlayerId
    }, (res) => {
      if (res?.success) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        setSaveError(res?.error || "Failed to update Playing XI");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xl flex items-center justify-center p-2 sm:p-4 animate-fade-in">
      <div className="bg-[#050c26] border border-amber-500/40 rounded-3xl max-w-6xl w-full max-h-[92vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Top Header: Navigation Tabs & Close */}
        <div className="px-4 py-3 sm:px-6 sm:py-4 border-b border-white/10 bg-[#071133] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
              <Users className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-black text-white tracking-wide uppercase">
                SQUAD MANAGEMENT CENTER
              </h2>
              <span className="text-[10px] text-slate-400">
                10 IPL Franchises • ₹120 Cr Initial Purse • Max 15 Squad • Playing XI
              </span>
            </div>
          </div>

          {/* Primary View Switcher Tabs */}
          <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-2xl border border-white/10">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeTab === 'overview'
                  ? 'bg-amber-500 text-slate-950 shadow-md font-black'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              10 Franchises Overview
            </button>
            <button
              onClick={() => setActiveTab('squad')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeTab === 'squad'
                  ? 'bg-amber-500 text-slate-950 shadow-md font-black'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Individual Squad
            </button>
            <button
              onClick={() => setActiveTab('playing_xi')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1 ${
                activeTab === 'playing_xi'
                  ? 'bg-amber-500 text-slate-950 shadow-md font-black'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Trophy className="w-3.5 h-3.5" />
              <span>Playing XI</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* TAB 1: 10 FRANCHISES OVERVIEW TABLE */}
        {activeTab === 'overview' && (
          <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-amber-400 uppercase tracking-wider">
                ALL 10 IPL FRANCHISES STATUS & PURSE
              </h3>
              <span className="text-xs text-slate-400">
                Initial Purse: <strong className="text-emerald-400">₹120.00 Cr each</strong> (Total ₹1,200 Cr)
              </span>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-white/10">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/90 text-slate-400 text-[11px] uppercase tracking-wider border-b border-white/10">
                  <tr>
                    <th className="py-3 px-3">Franchise</th>
                    <th className="py-3 px-3 text-right">Remaining Purse</th>
                    <th className="py-3 px-3 text-right">Total Spent</th>
                    <th className="py-3 px-3 text-center">Squad</th>
                    <th className="py-3 px-3 text-center">IND</th>
                    <th className="py-3 px-3 text-center">OS</th>
                    <th className="py-3 px-3 text-center">BAT</th>
                    <th className="py-3 px-3 text-center">BOWL</th>
                    <th className="py-3 px-3 text-center">AR</th>
                    <th className="py-3 px-3 text-center">WK</th>
                    <th className="py-3 px-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 bg-slate-950/60 font-medium">
                  {Object.values(room.franchises).map(f => {
                    const fSquad = f.squad || [];
                    const indCount = fSquad.filter(p => !p.isOverseas).length;
                    const osCount = fSquad.filter(p => p.isOverseas).length;
                    const batCount = fSquad.filter(p => p.category === 'BAT').length;
                    const bowlCount = fSquad.filter(p => p.category === 'BOWL' || p.category === 'FAST' || p.category === 'SP' || p.category === 'SPIN').length;
                    const arCount = fSquad.filter(p => p.category === 'AR').length;
                    const wkCount = fSquad.filter(p => p.category === 'WK').length;
                    const isMe = myFranchise?.id === f.id;

                    return (
                      <tr
                        key={f.id}
                        className={`hover:bg-slate-800/40 transition ${
                          isMe ? 'bg-blue-600/10' : ''
                        }`}
                      >
                        <td className="py-2.5 px-3 flex items-center gap-2">
                          <FranchiseBadge code={f.code} size="sm" />
                          <div>
                            <div className="font-bold text-white flex items-center gap-1.5">
                              <span>{f.name}</span>
                              {isMe && (
                                <span className="text-[9px] bg-amber-400 text-slate-950 font-black px-1.5 rounded">
                                  YOU
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-slate-400">
                              {f.ownerName ? `Owner: ${f.ownerName}` : 'Unclaimed'}
                            </span>
                          </div>
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-400 text-sm">
                          {f.isEliminated ? (
                            <span className="text-red-400 font-bold">OUT</span>
                          ) : (
                            `₹${f.remainingPurse.toFixed(2)} Cr`
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono text-slate-300">
                          ₹{f.totalSpent.toFixed(2)} Cr
                        </td>

                        <td className="py-2.5 px-3 text-center font-mono font-bold text-white">
                          {fSquad.length} <span className="text-slate-500 font-normal">/ 15</span>
                        </td>

                        <td className="py-2.5 px-3 text-center text-slate-300 font-mono">{indCount}</td>
                        <td className="py-2.5 px-3 text-center text-blue-400 font-mono font-bold">{osCount} / 8</td>
                        <td className="py-2.5 px-3 text-center text-slate-300 font-mono">{batCount}</td>
                        <td className="py-2.5 px-3 text-center text-slate-300 font-mono">{bowlCount}</td>
                        <td className="py-2.5 px-3 text-center text-slate-300 font-mono">{arCount}</td>
                        <td className="py-2.5 px-3 text-center text-amber-400 font-mono font-bold">{wkCount}</td>

                        <td className="py-2.5 px-3 text-center">
                          <button
                            onClick={() => {
                              setSelectedFranchiseId(f.id);
                              setActiveTab('squad');
                            }}
                            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold border border-slate-700 transition cursor-pointer"
                          >
                            View Squad
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 2 & 3 FRANCHISE SELECTOR BAR */}
        {activeTab !== 'overview' && (
          <div className="p-3 bg-slate-950/70 border-b border-white/10 flex items-center gap-2 overflow-x-auto">
            {Object.values(room.franchises).map(f => (
              <button
                key={f.id}
                onClick={() => setSelectedFranchiseId(f.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 flex-shrink-0 cursor-pointer ${
                  selectedFranchiseId === f.id
                    ? 'bg-amber-400 text-slate-950 font-black shadow-md'
                    : 'bg-slate-900/80 hover:bg-slate-800 text-slate-300 border border-white/10'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: f.primaryColor }}
                />
                <span>{f.code}</span>
                {f.squad?.length > 0 && (
                  <span className="text-[10px] font-mono opacity-80">({f.squad.length})</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* TAB 2: INDIVIDUAL SQUAD VIEW */}
        {activeTab === 'squad' && (
          <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
            {/* Franchise Header Banner */}
            <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-950 border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <FranchiseBadge code={franchise.code} size="lg" />
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl sm:text-2xl font-black text-white">{franchise.name}</h3>
                    {franchise.isEliminated && (
                      <span className="text-xs font-bold text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-0.5 rounded-full">
                        Eliminated
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Owner: <strong className="text-slate-200">{franchise.ownerName || 'Unclaimed'}</strong> • {franchise.homeGround}
                  </p>
                </div>
              </div>

              {/* Financial Stats */}
              <div className="flex items-center gap-3">
                <div className="bg-slate-950/70 px-4 py-2 rounded-xl border border-slate-800 text-right">
                  <span className="text-[10px] text-slate-400 uppercase font-bold block">Remaining Purse</span>
                  <span className="text-base sm:text-lg font-black font-mono text-emerald-400">
                    ₹{franchise.remainingPurse.toFixed(2)} Cr
                  </span>
                </div>
                <div className="bg-slate-950/70 px-4 py-2 rounded-xl border border-slate-800 text-right">
                  <span className="text-[10px] text-slate-400 uppercase font-bold block">Total Spent</span>
                  <span className="text-base sm:text-lg font-black font-mono text-amber-400">
                    ₹{franchise.totalSpent.toFixed(2)} Cr
                  </span>
                </div>
              </div>
            </div>

            {/* Squad List Grid */}
            {squad.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <Users className="w-12 h-12 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No players acquired by {franchise.name} yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {squad.map((p, idx) => (
                  <div
                    key={p.id + idx}
                    className="bg-slate-900/80 border border-slate-800 p-3 rounded-2xl flex items-center justify-between gap-3 hover:border-slate-700 transition"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Player Image Thumbnail */}
                      <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 overflow-hidden flex items-center justify-center font-bold text-amber-400 text-xs flex-shrink-0">
                        {p.imageUrl ? (
                          <img
                            src={p.imageUrl}
                            alt={p.name}
                            className="w-full h-full object-cover object-top"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        ) : (
                          p.initials
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 truncate">
                          <span className="font-black text-white text-sm truncate">{p.name}</span>
                          {p.isOverseas ? (
                            <span className="text-[9px] text-blue-400 font-bold bg-blue-500/10 px-1 rounded border border-blue-500/20">
                              OS
                            </span>
                          ) : (
                            <span className="text-[9px] text-slate-400 font-bold bg-slate-800 px-1 rounded">
                              IND
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 flex items-center gap-1">
                          <span>{p.category}</span>
                          <span>•</span>
                          <span className="truncate">{p.role}</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <span className="text-xs font-mono font-black text-emerald-400 block">
                        ₹{(p.boughtPrice || p.basePrice).toFixed(2)} Cr
                      </span>
                      <span className="text-[10px] text-slate-400">
                        Rating: <strong className="text-amber-400 font-mono">{p.rating}</strong>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: INTERACTIVE PLAYING XI MANAGEMENT */}
        {activeTab === 'playing_xi' && (
          <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
            {/* Ownership Notification Bar */}
            <div className={`p-3 rounded-2xl border text-xs flex items-center justify-between ${
              canEdit
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}>
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-amber-400" />
                <span>
                  {canEdit
                    ? `You are the owner of ${franchise.name}. You can manage and save the Playing XI.`
                    : `View Mode: Only the franchise owner (${franchise.ownerName || 'Unclaimed'}) can modify this Playing XI.`}
                </span>
              </div>

              {canEdit && (
                <button
                  onClick={savePlayingXI}
                  disabled={!isXIComplete}
                  className={`px-4 py-1.5 rounded-xl font-black text-xs transition cursor-pointer shadow-md ${
                    isXIComplete
                      ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-amber-500/20'
                      : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  Save Playing XI
                </button>
              )}
            </div>

            {/* Validation Feedback Messages */}
            {saveSuccess && (
              <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <span>Playing XI saved and synchronized across all participants!</span>
              </div>
            )}
            {saveError && (
              <div className="p-2.5 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 text-xs flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <span>{saveError}</span>
              </div>
            )}

            {/* Rule Validation Checklist Banner */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs">
              <div className={`p-2 rounded-xl border ${has11 ? 'bg-emerald-950/20 border-emerald-500/40 text-emerald-300' : 'bg-slate-900 border-slate-800 text-slate-400'}`}>
                <span className="text-[10px] block font-semibold">11 Players</span>
                <strong className="font-mono">{playingXIIds.length} / 11</strong>
              </div>

              <div className={`p-2 rounded-xl border ${overseasValid ? 'bg-emerald-950/20 border-emerald-500/40 text-emerald-300' : 'bg-red-950/20 border-red-500/40 text-red-400'}`}>
                <span className="text-[10px] block font-semibold">Overseas in XI</span>
                <strong className="font-mono">{overseasInXI} / 4 Max</strong>
              </div>

              <div className={`p-2 rounded-xl border ${hasMinWK ? 'bg-emerald-950/20 border-emerald-500/40 text-emerald-300' : 'bg-red-950/20 border-red-500/40 text-red-400'}`}>
                <span className="text-[10px] block font-semibold">Wicketkeeper</span>
                <strong className="font-mono">{hasMinWK ? `${wkInXI} WK Assigned` : 'Need at least 1'}</strong>
              </div>

              <div className={`p-2 rounded-xl border ${hasCaptain ? 'bg-emerald-950/20 border-emerald-500/40 text-emerald-300' : 'bg-amber-950/20 border-amber-500/40 text-amber-400'}`}>
                <span className="text-[10px] block font-semibold">Captain (C)</span>
                <strong className="truncate block font-mono">{hasCaptain ? squadMap.get(captainId)?.name : 'Required'}</strong>
              </div>

              <div className={`p-2 rounded-xl border ${hasViceCaptain ? 'bg-emerald-950/20 border-emerald-500/40 text-emerald-300' : 'bg-amber-950/20 border-amber-500/40 text-amber-400'}`}>
                <span className="text-[10px] block font-semibold">Vice-Captain (VC)</span>
                <strong className="truncate block font-mono">{hasViceCaptain ? squadMap.get(viceCaptainId)?.name : 'Required'}</strong>
              </div>
            </div>

            {/* Playing XI Batting Order & Bench Dual Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
              {/* LEFT: Starting Playing XI (Positions 1 to 11) */}
              <div className="lg:col-span-7 bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between pb-2 border-b border-white/10">
                  <h4 className="text-xs font-black uppercase text-amber-400 tracking-wider flex items-center gap-1.5">
                    <Trophy className="w-3.5 h-3.5" />
                    Starting Playing XI ({playingXIIds.length}/11)
                  </h4>
                  <span className="text-[10px] text-slate-400">Rearrange Batting Order</span>
                </div>

                {playingXIPlayers.length === 0 ? (
                  <div className="text-center py-12 text-slate-500 text-xs">
                    No players in Playing XI yet. Add players from your available squad bench on the right.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {playingXIPlayers.map((p, idx) => {
                      const isC = p.id === captainId;
                      const isVC = p.id === viceCaptainId;
                      const isWK = p.category === 'WK';

                      return (
                        <div
                          key={p.id}
                          className="bg-slate-950/80 border border-slate-800 hover:border-slate-700 p-2 sm:p-2.5 rounded-xl flex items-center justify-between gap-2 text-xs transition"
                        >
                          {/* Order number & player info */}
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-5 h-5 rounded-full bg-slate-800 font-mono font-bold text-slate-300 text-[10px] flex items-center justify-center flex-shrink-0">
                              {idx + 1}
                            </span>

                            {/* Small avatar */}
                            <div className="w-8 h-8 rounded-lg bg-slate-800 overflow-hidden flex-shrink-0 border border-slate-700 flex items-center justify-center font-bold text-[10px] text-amber-400">
                              {p.imageUrl ? (
                                <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover object-top" onError={(e) => { e.target.style.display = 'none'; }} />
                              ) : (
                                p.initials
                              )}
                            </div>

                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 truncate">
                                <span className="font-extrabold text-white text-xs truncate">{p.name}</span>
                                {p.isOverseas && <span className="text-[9px] text-blue-400 font-bold bg-blue-500/10 px-1 rounded">OS</span>}
                                {isWK && <span className="text-[9px] text-cyan-400 font-bold bg-cyan-500/10 px-1 rounded">WK</span>}
                              </div>
                              <span className="text-[10px] text-slate-400">{p.role}</span>
                            </div>
                          </div>

                          {/* Role badges & controls */}
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {/* Captain / Vice Captain Badges */}
                            {canEdit ? (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => toggleCaptain(p.id)}
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-black transition cursor-pointer ${
                                    isC
                                      ? 'bg-amber-400 text-slate-950 shadow'
                                      : 'bg-slate-800 text-slate-400 hover:text-white'
                                  }`}
                                  title="Assign Captain"
                                >
                                  C
                                </button>
                                <button
                                  onClick={() => toggleViceCaptain(p.id)}
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-black transition cursor-pointer ${
                                    isVC
                                      ? 'bg-blue-400 text-slate-950 shadow'
                                      : 'bg-slate-800 text-slate-400 hover:text-white'
                                  }`}
                                  title="Assign Vice-Captain"
                                >
                                  VC
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1">
                                {isC && <span className="bg-amber-400 text-slate-950 font-black text-[10px] px-1.5 py-0.5 rounded">C</span>}
                                {isVC && <span className="bg-blue-400 text-slate-950 font-black text-[10px] px-1.5 py-0.5 rounded">VC</span>}
                              </div>
                            )}

                            {/* Batting order move controls */}
                            {canEdit && (
                              <div className="flex items-center gap-0.5">
                                <button
                                  onClick={() => movePosition(idx, -1)}
                                  disabled={idx === 0}
                                  className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white disabled:opacity-30 cursor-pointer"
                                  title="Move Up in Batting Order"
                                >
                                  <ChevronUp className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => movePosition(idx, 1)}
                                  disabled={idx === playingXIPlayers.length - 1}
                                  className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white disabled:opacity-30 cursor-pointer"
                                  title="Move Down in Batting Order"
                                >
                                  <ChevronDown className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => removeFromXI(p.id)}
                                  className="p-1 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded transition cursor-pointer ml-1"
                                  title="Remove from Playing XI"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* RIGHT: Bench & Impact Player Selection */}
              <div className="lg:col-span-5 space-y-4">
                {/* Impact Player Selection Box */}
                <div className="bg-slate-900/60 border border-purple-500/30 rounded-2xl p-3.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase text-purple-400 tracking-wider flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 fill-current" />
                      Impact Player
                    </span>
                    {impactPlayerId && (
                      <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                        Assigned
                      </span>
                    )}
                  </div>

                  {canEdit ? (
                    <select
                      value={impactPlayerId || ''}
                      onChange={(e) => {
                        setImpactPlayerId(e.target.value || null);
                        setSaveSuccess(false);
                      }}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:border-purple-400 outline-none"
                    >
                      <option value="">-- Select Impact Player from Bench --</option>
                      {benchPlayers.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.category} • {p.isOverseas ? 'OS' : 'IND'})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="text-xs text-slate-300">
                      {impactPlayerId ? (
                        <div className="flex items-center gap-2 bg-slate-950 p-2 rounded-xl">
                          <span className="font-bold text-white">{squadMap.get(impactPlayerId)?.name}</span>
                          <span className="text-[10px] text-slate-400">({squadMap.get(impactPlayerId)?.category})</span>
                        </div>
                      ) : (
                        <span className="text-slate-500 italic">No Impact Player designated yet</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Available Bench Players */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center justify-between pb-2 border-b border-white/10">
                    <h4 className="text-xs font-black uppercase text-slate-300 tracking-wider">
                      Available Bench ({benchPlayers.length})
                    </h4>
                    <span className="text-[10px] text-slate-500">Add to XI</span>
                  </div>

                  {benchPlayers.length === 0 ? (
                    <div className="text-center py-8 text-slate-500 text-xs">
                      All purchased squad members are currently in the Playing XI.
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-[360px] overflow-y-auto pr-1">
                      {benchPlayers.map(p => (
                        <div
                          key={p.id}
                          className="bg-slate-950/70 border border-slate-800 p-2 rounded-xl flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 truncate">
                              <span className="font-bold text-slate-200 truncate">{p.name}</span>
                              {p.isOverseas && <span className="text-[9px] text-blue-400 font-bold bg-blue-500/10 px-1 rounded">OS</span>}
                              {p.category === 'WK' && <span className="text-[9px] text-cyan-400 font-bold bg-cyan-500/10 px-1 rounded">WK</span>}
                            </div>
                            <span className="text-[10px] text-slate-400">{p.category} • {p.role}</span>
                          </div>

                          {canEdit && (
                            <button
                              onClick={() => addToXI(p)}
                              disabled={playingXIIds.length >= 11 || (p.isOverseas && overseasInXI >= 4)}
                              className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-[10px] transition cursor-pointer flex-shrink-0"
                            >
                              + Add to XI
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
