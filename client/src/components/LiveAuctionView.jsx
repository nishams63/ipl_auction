import React, { useState, useEffect } from 'react';
import {
  Gavel, Clock, AlertTriangle, ArrowRight, Shield, Award,
  Globe, User, CheckCircle2, XCircle, TrendingUp, Sparkles, Pause, Play
} from 'lucide-react';
import { playGavel, playBidPing, playTick, playSoldFanfare, playUnsold } from '../utils/audio';

export default function LiveAuctionView({
  room,
  participant,
  myFranchise,
  onPlaceBid,
  onAdvanceLot,
  onPauseResume,
  onFinishAuction,
  onOpenSquad
}) {
  const lot = room.currentLot;
  const [submittingBid, setSubmittingBid] = useState(false);
  const [bidError, setBidError] = useState(null);
  const [pulseBid, setPulseBid] = useState(false);
  const [imgError, setImgError] = useState(false);

  // Sound triggers based on hammer and countdown
  useEffect(() => {
    if (!lot) return;
    if (lot.countdown === 10 || lot.countdown === 5) {
      playTick();
    }
  }, [lot?.countdown]);

  useEffect(() => {
    setImgError(false);
  }, [lot?.player?.id]);

  if (!lot || !lot.player) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center">
        <div className="glass-panel p-10 rounded-3xl border border-slate-800 space-y-4">
          <Clock className="w-12 h-12 text-amber-400 mx-auto animate-spin" />
          <h2 className="text-2xl font-bold text-white">Preparing Next Player...</h2>
          <p className="text-slate-400 text-sm">Synchronizing auction state with room participants</p>
        </div>
      </div>
    );
  }

  const player = lot.player;
  const highestBidderFranchise = lot.highestBidderFranchiseId
    ? room.franchises[lot.highestBidderFranchiseId]
    : null;

  // Check bidding eligibility for my franchise
  const isMyFranchiseHighest = myFranchise && lot.highestBidderFranchiseId === myFranchise.id;
  const isEliminated = myFranchise?.isEliminated;

  // Feasibility calculation on client for instant UI feedback
  let canBid = true;
  let cannotBidReason = null;

  if (!myFranchise) {
    canBid = false;
    cannotBidReason = "You have not claimed a franchise";
  } else if (room.status !== 'active') {
    canBid = false;
    cannotBidReason = "Auction is paused";
  } else if (lot.countdown <= 0) {
    canBid = false;
    cannotBidReason = "Bidding closed for this lot";
  } else if (isMyFranchiseHighest) {
    canBid = false;
    cannotBidReason = "You already hold the highest bid";
  } else if (isEliminated) {
    canBid = false;
    cannotBidReason = "Franchise is financially eliminated";
  } else if (myFranchise.squad.length >= room.config.maxSquadSize) {
    canBid = false;
    cannotBidReason = `Max squad limit (${room.config.maxSquadSize}) reached`;
  } else if (player.isOverseas && myFranchise.overseasCount >= room.config.maxOverseas) {
    canBid = false;
    cannotBidReason = `Max overseas slots (${room.config.maxOverseas}) filled`;
  } else {
    const projectedPurse = myFranchise.remainingPurse - lot.nextValidBid;
    if (projectedPurse < 0) {
      canBid = false;
      cannotBidReason = "Insufficient purse balance";
    } else {
      const remainingSlots = Math.max(0, room.config.minSquadSize - (myFranchise.squad.length + 1));
      const requiredReserve = remainingSlots * room.config.minPlayerPrice;
      if (projectedPurse < requiredReserve) {
        canBid = false;
        cannotBidReason = `Must reserve ₹${requiredReserve.toFixed(2)} Cr for remaining ${remainingSlots} mandatory slots`;
      }
    }
  }

  const handleBidClick = () => {
    if (!canBid || submittingBid) return;
    setSubmittingBid(true);
    setBidError(null);
    setPulseBid(true);
    setTimeout(() => setPulseBid(false), 400);

    onPlaceBid({
      franchiseId: myFranchise.id,
      bidAmount: lot.nextValidBid,
      expectedVersion: lot.stateVersion
    }, (res) => {
      setSubmittingBid(false);
      if (!res?.success) {
        setBidError(res?.error || "Bid could not be processed");
      }
    });
  };

  // Timer color shifting
  const timerPct = (lot.countdown / room.config.timerDuration) * 100;
  const isUrgent = lot.countdown <= 10;
  const isCritical = lot.countdown <= 5;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Top Quick Status & Host Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 glass-panel px-5 py-3 rounded-2xl border border-white/10 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-sm shadow-emerald-400/50" />
            <span className="font-black text-white text-sm tracking-wide uppercase">
              Round {String(player.round).padStart(2, '0')}
            </span>
            <span className="text-white/20">•</span>
            <span className="text-xs font-mono font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-2.5 py-0.5 rounded-full shadow-sm">
              {player.categorySet}
            </span>
          </div>
          <span className="text-white/20 hidden sm:inline">•</span>
          <span className="text-xs text-slate-300 hidden sm:inline">
            Lot <strong className="text-amber-400 font-mono">{lot.lotNumber}</strong> of {lot.totalLots}
          </span>
        </div>

        {/* Host Control Actions */}
        {participant?.isHost && (
          <div className="flex items-center gap-2">
            <button
              onClick={onPauseResume}
              className={`px-3.5 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 border transition cursor-pointer ${
                room.status === 'paused'
                  ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 border-emerald-400 shadow-lg shadow-emerald-500/25'
                  : 'bg-slate-800/80 hover:bg-slate-700 text-slate-200 border-white/10'
              }`}
            >
              {room.status === 'paused' ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5" />}
              {room.status === 'paused' ? 'Resume Bidding' : 'Pause'}
            </button>

            <button
              onClick={onAdvanceLot}
              className="px-3.5 py-1.5 rounded-full bg-slate-800/80 hover:bg-slate-700 text-xs font-bold text-slate-200 flex items-center gap-1.5 border border-white/10 transition cursor-pointer"
              title="Hammer down or close current lot"
            >
              <Gavel className="w-3.5 h-3.5 text-amber-400" />
              Advance Lot
            </button>

            <button
              onClick={onFinishAuction}
              className="px-3.5 py-1.5 rounded-full bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 text-xs font-bold transition cursor-pointer"
            >
              Conclude Auction
            </button>
          </div>
        )}
      </div>

      {/* Main 2-Column Auction Presentation */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT: Player Information Presentation (5 cols) */}
        <div className="lg:col-span-5 glass-panel rounded-3xl p-6 border-glow-gold shadow-2xl flex flex-col justify-between">
          <div>
            {/* Player Card Header */}
            <div className="relative mb-6">
              <div className="w-full h-64 sm:h-72 rounded-2xl bg-gradient-to-b from-slate-900 to-slate-950 border border-white/10 overflow-hidden flex items-center justify-center relative shadow-2xl">
                {!imgError ? (
                  <img
                    src={player.imageUrl}
                    alt={player.name}
                    onError={() => setImgError(true)}
                    className="w-full h-full object-cover object-top hover:scale-105 transition duration-500"
                  />
                ) : (
                  <div className="w-28 h-28 rounded-2xl bg-gradient-to-tr from-amber-400 via-amber-500 to-yellow-600 flex items-center justify-center text-slate-950 font-black text-4xl shadow-2xl">
                    {player.initials}
                  </div>
                )}

                {/* Badges on image */}
                <div className="absolute top-3 left-3 flex gap-2">
                  <span className="text-xs font-black uppercase px-3 py-1 rounded-full bg-slate-950/90 text-amber-300 border border-amber-400/40 backdrop-blur-md shadow-lg">
                    {player.category}
                  </span>
                  {player.isOverseas && (
                    <span className="text-xs font-bold px-3 py-1 rounded-full bg-blue-600/90 text-white backdrop-blur-md shadow-lg flex items-center gap-1.5 border border-blue-400/30">
                      <Globe className="w-3.5 h-3.5" /> Overseas
                    </span>
                  )}
                </div>

                {/* Rating Badge */}
                <div className="absolute bottom-3 right-3 bg-slate-950/90 border border-amber-400/40 px-3.5 py-1.5 rounded-full flex items-center gap-2 backdrop-blur-md shadow-xl">
                  <span className="text-[10px] text-amber-300 uppercase font-black tracking-wider">OVR</span>
                  <span className="font-black text-amber-400 text-lg font-mono">{player.rating}</span>
                </div>
              </div>
            </div>

            {/* Player Identity */}
            <div className="space-y-1 mb-4">
              <div className="text-xs font-bold text-amber-400/90 uppercase tracking-widest">
                {player.country}
              </div>
              <h2 className="text-3xl font-black text-white tracking-tight">
                {player.name}
              </h2>
              <div className="text-sm text-slate-300 font-medium">
                {player.role}
              </div>
            </div>

            {/* Base Price Tag */}
            <div className="glass-card border border-white/10 rounded-2xl p-4 flex items-center justify-between mb-5 shadow-inner">
              <span className="text-xs text-slate-400 uppercase font-bold tracking-wider">Base Price</span>
              <span className="text-2xl font-black text-emerald-400 font-mono">
                ₹{player.basePrice.toFixed(2)} Cr
              </span>
            </div>

            {/* Verified Statistics Grid */}
            <div className="space-y-2">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                IPL Performance Metrics
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div className="bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl">
                  <span className="text-[10px] text-slate-500 uppercase block font-semibold">Matches</span>
                  <span className="text-sm font-bold text-white font-mono">{player.stats.matches || 0}</span>
                </div>
                {player.stats.runs !== undefined && (
                  <div className="bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-500 uppercase block font-semibold">Runs</span>
                    <span className="text-sm font-bold text-white font-mono">{player.stats.runs}</span>
                  </div>
                )}
                {player.stats.wickets !== undefined && (
                  <div className="bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-500 uppercase block font-semibold">Wickets</span>
                    <span className="text-sm font-bold text-white font-mono">{player.stats.wickets}</span>
                  </div>
                )}
                {player.stats.sr !== undefined && (
                  <div className="bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-500 uppercase block font-semibold">Strike Rate</span>
                    <span className="text-sm font-bold text-amber-400 font-mono">{player.stats.sr}</span>
                  </div>
                )}
                {player.stats.econ !== undefined && (
                  <div className="bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-500 uppercase block font-semibold">Economy</span>
                    <span className="text-sm font-bold text-emerald-400 font-mono">{player.stats.econ}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800/80 text-[11px] text-slate-500 flex items-center justify-between">
            <span>Candidate List ID: {player.id}</span>
            <span>Round {player.round} • Set {player.categorySet}</span>
          </div>
        </div>

        {/* RIGHT: Active Bidding Arena (7 cols) */}
        <div className="lg:col-span-7 space-y-6 flex flex-col justify-between">
          {/* Main Stage Card */}
          <div className="glass-panel rounded-3xl p-6 lg:p-8 border border-slate-800/80 shadow-2xl relative overflow-hidden flex-1 flex flex-col justify-between">
            {/* Background stage lighting */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-amber-500/10 rounded-full blur-3xl pointer-events-none -z-10" />

            {/* Countdown Bar & Hammer Callout */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className={`w-5 h-5 ${isCritical ? 'text-red-400 animate-bounce' : isUrgent ? 'text-amber-400' : 'text-blue-400'}`} />
                  <span className="text-xs uppercase font-extrabold tracking-wider text-slate-400">
                    Countdown
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  {/* Hammer Status Callout Badge */}
                  <span className={`text-xs font-black tracking-widest uppercase px-3 py-1 rounded-xl shadow-lg ${
                    lot.hammerStatus === 'GOING_TWICE'
                      ? 'bg-red-500 text-white animate-pulse'
                      : lot.hammerStatus === 'GOING_ONCE'
                      ? 'bg-amber-500 text-slate-950 font-black'
                      : lot.hammerStatus === 'SOLD'
                      ? 'bg-emerald-500 text-slate-950 font-black'
                      : 'bg-slate-800 text-slate-300 border border-slate-700'
                  }`}>
                    {lot.hammerStatus === 'GOING_TWICE' ? '⚠️ GOING TWICE!' : lot.hammerStatus === 'GOING_ONCE' ? '⚡ GOING ONCE!' : lot.hammerStatus}
                  </span>

                  {/* Numeric Timer */}
                  <span className={`text-3xl font-black font-mono tracking-tight ${
                    isCritical ? 'text-red-400 animate-pulse' : isUrgent ? 'text-amber-400' : 'text-white'
                  }`}>
                    {String(Math.max(0, lot.countdown)).padStart(2, '0')}s
                  </span>
                </div>
              </div>

              {/* Progress bar */}
              <div className="w-full bg-slate-900 h-2.5 rounded-full overflow-hidden border border-slate-800">
                <div
                  className={`h-full transition-all duration-1000 ease-linear rounded-full ${
                    isCritical ? 'bg-red-500' : isUrgent ? 'bg-amber-400' : 'bg-gradient-to-r from-blue-500 to-emerald-400'
                  }`}
                  style={{ width: `${Math.max(0, timerPct)}%` }}
                />
              </div>
            </div>

            {/* Center Stage: Current Highest Bid */}
            <div className="my-8 text-center space-y-3">
              <span className="text-xs uppercase tracking-widest font-extrabold text-slate-400 block">
                Current Highest Bid
              </span>

              <div className="text-5xl sm:text-7xl font-black text-white font-mono tracking-tight drop-shadow-lg">
                ₹{lot.highestBid > 0 ? lot.highestBid.toFixed(2) : player.basePrice.toFixed(2)}
                <span className="text-2xl sm:text-3xl font-bold text-amber-400 ml-2">CR</span>
              </div>

              {/* Highest Bidder Franchise Card */}
              {highestBidderFranchise ? (
                <div className="inline-flex items-center gap-3 px-5 py-2.5 rounded-2xl bg-slate-900 border border-slate-700 shadow-xl">
                  <div
                    className="w-8 h-8 rounded-xl flex items-center justify-center font-black text-xs shadow"
                    style={{
                      backgroundColor: highestBidderFranchise.primaryColor,
                      color: highestBidderFranchise.textColor
                    }}
                  >
                    {highestBidderFranchise.code}
                  </div>
                  <div className="text-left">
                    <div className="text-xs font-bold text-white">
                      {highestBidderFranchise.name}
                    </div>
                    <div className="text-[11px] text-emerald-400 font-mono font-semibold">
                      Leader ({highestBidderFranchise.ownerName})
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-500 font-medium">
                  Waiting for opening bid at base price of ₹{player.basePrice.toFixed(2)} Cr
                </div>
              )}
            </div>

            {/* Action Area: Automatic Bid Button */}
            <div className="space-y-4">
              {bidError && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{bidError}</span>
                </div>
              )}

              <button
                onClick={handleBidClick}
                disabled={!canBid || submittingBid}
                className={`w-full py-4.5 px-6 rounded-full font-black text-xl tracking-wider transition-all duration-200 flex flex-col items-center justify-center relative overflow-hidden ${
                  canBid
                    ? 'gold-btn text-slate-950 cursor-pointer transform active:scale-95'
                    : 'bg-slate-900 border border-white/10 text-slate-500 cursor-not-allowed opacity-80'
                } ${pulseBid ? 'animate-bid-pulse ring-4 ring-amber-400' : ''}`}
              >
                <div className="flex items-center gap-2.5">
                  <Gavel className="w-6 h-6 fill-current animate-hammer" />
                  <span>BID ₹{lot.nextValidBid.toFixed(2)} CR</span>
                </div>
                <span className="text-[11px] font-bold tracking-normal opacity-85 mt-0.5">
                  {lot.highestBid === 0
                    ? `Opening bid at player's base price`
                    : `Automatic next valid increment based on IPL rules`}
                </span>
              </button>

              {/* Status / Feasibility Helper Text */}
              {!canBid && (
                <div className="text-center text-xs font-semibold text-slate-300 flex items-center justify-center gap-1.5 bg-amber-500/10 border border-amber-500/20 py-2 px-3 rounded-full">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                  <span>{cannotBidReason}</span>
                </div>
              )}

              {/* My Franchise Snapshot */}
              {myFranchise && (
                <div className="glass-card rounded-2xl p-3.5 border border-white/10 flex items-center justify-between text-xs text-slate-300 shadow">
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-white">{myFranchise.name}</span>
                    <span>•</span>
                    <span>Purse: <strong className="text-emerald-400 font-mono font-bold">₹{myFranchise.remainingPurse.toFixed(2)} Cr</strong></span>
                  </div>
                  <div>
                    <span>Squad: <strong className="text-amber-400 font-mono font-bold">{myFranchise.squad.length}</strong>/{room.config.minSquadSize} min</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Recent Bids Feed for this lot */}
          <div className="glass-panel p-4 rounded-2xl border border-white/10 shadow-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs uppercase font-extrabold tracking-wider text-slate-300 flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5 text-amber-400" /> Bidding Activity
              </span>
              <span className="text-[11px] text-slate-500 font-mono">
                {lot.bidHistory.length} {lot.bidHistory.length === 1 ? 'bid' : 'bids'} on this player
              </span>
            </div>

            <div className="max-h-24 overflow-y-auto space-y-1.5 pr-1">
              {lot.bidHistory.length === 0 ? (
                <div className="text-xs text-slate-500 py-1 italic">
                  No bids placed yet. Click above to open bidding at ₹{player.basePrice.toFixed(2)} Cr!
                </div>
              ) : (
                [...lot.bidHistory].reverse().map(b => (
                  <div key={b.bidId} className="flex items-center justify-between text-xs py-1 px-2.5 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-amber-400">{b.franchiseCode}</span>
                      <span className="text-slate-400">({b.participantName})</span>
                    </div>
                    <span className="font-bold font-mono text-emerald-400">₹{b.bidAmount.toFixed(2)} Cr</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ALL 10 FRANCHISES PURSE & ROSTER SUMMARY TABLE */}
      <div className="glass-panel rounded-3xl p-6 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-extrabold text-white flex items-center gap-2">
            <Award className="w-4 h-4 text-amber-400" /> Participating Franchises Overview
          </h3>
          <span className="text-xs text-slate-400">
            Real-time purse deductions & squad counts
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
          {Object.values(room.franchises).map(f => {
            const isHighest = lot.highestBidderFranchiseId === f.id;
            const isMe = myFranchise?.id === f.id;

            return (
              <div
                key={f.id}
                onClick={onOpenSquad}
                className={`p-3.5 rounded-2xl border transition cursor-pointer ${
                  isHighest
                    ? 'border-amber-400 bg-amber-500/10 shadow-lg shadow-amber-500/10'
                    : isMe
                    ? 'border-blue-500/50 bg-blue-500/5'
                    : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center font-black text-xs shadow"
                    style={{ backgroundColor: f.primaryColor, color: f.textColor }}
                  >
                    {f.code}
                  </div>
                  {f.isEliminated ? (
                    <span className="text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/30 px-1.5 rounded">
                      ELIMINATED
                    </span>
                  ) : (
                    <span className="text-xs font-bold font-mono text-emerald-400">
                      ₹{f.remainingPurse.toFixed(2)} Cr
                    </span>
                  )}
                </div>

                <div className="font-bold text-white text-xs truncate">
                  {f.name}
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  Owner: {f.ownerName || 'Unassigned'}
                </div>

                <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Squad: <strong className="text-white">{f.squad.length}</strong></span>
                  <span>Overseas: <strong className="text-white">{f.overseasCount}</strong>/{room.config.maxOverseas}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
