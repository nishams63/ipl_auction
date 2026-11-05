import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Gavel, Clock, AlertTriangle, ArrowRight, Shield, Award,
  Globe, User, CheckCircle2, XCircle, TrendingUp, Sparkles, Pause, Play,
  Copy, Check, Edit3, X, ChevronRight, Plane, Star, Radio,
  Search, Filter, ArrowUp, RotateCcw
} from 'lucide-react';
import { playGavel, playBidPing, playTick, playSoldFanfare, playUnsold } from '../utils/audio';

// Franchise logo/emblem badges generator
function FranchiseBadge({ code, size = "md" }) {
  const sizeClasses = {
    sm: "w-6 h-6 text-[10px]",
    md: "w-8 h-8 text-xs",
    lg: "w-10 h-10 text-sm",
    xl: "w-14 h-14 text-lg"
  };

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
      className={`${sizeClasses[size] || sizeClasses.md} rounded-xl flex items-center justify-center font-black tracking-tighter shadow-md flex-shrink-0 border`}
      style={{ backgroundColor: c.bg, color: c.text, borderColor: c.border }}
    >
      {code}
    </div>
  );
}

// Category badge color mapper
function CategoryBadge({ category }) {
  const styles = {
    BAT: "bg-blue-600/90 text-white border-blue-400/40",
    BOWL: "bg-amber-500/90 text-slate-950 font-black border-amber-300/40",
    FAST: "bg-amber-500/90 text-slate-950 font-black border-amber-300/40",
    SP: "bg-purple-600/90 text-white border-purple-400/40",
    SPIN: "bg-purple-600/90 text-white border-purple-400/40",
    AR: "bg-emerald-600/90 text-white border-emerald-400/40",
    WK: "bg-cyan-500/90 text-slate-950 font-black border-cyan-300/40"
  };

  return (
    <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md border tracking-wider shadow-sm ${styles[category] || styles.BAT}`}>
      {category}
    </span>
  );
}

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
  const [copiedCode, setCopiedCode] = useState(false);

  // Custom Bid Modal state
  const [isCustomBidOpen, setIsCustomBidOpen] = useState(false);
  const [customBidAmount, setCustomBidAmount] = useState('');
  const [customBidError, setCustomBidError] = useState(null);

  // Sound triggers based on hammer and countdown (15s timer)
  useEffect(() => {
    if (!lot) return;
    if (lot.countdown === 5 || lot.countdown === 3 || lot.countdown === 2 || lot.countdown === 1) {
      playTick();
    }
  }, [lot?.countdown]);

  // Reset image error on lot switch
  useEffect(() => {
    setImgError(false);
    setBidError(null);
    setCustomBidError(null);
  }, [lot?.player?.id]);

  if (!lot || !lot.player) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-24 text-center">
        <div className="glass-panel p-12 rounded-3xl border border-slate-800 space-y-4">
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

  // Feasibility & eligibility check
  const isMyFranchiseHighest = myFranchise && lot.highestBidderFranchiseId === myFranchise.id;
  const isEliminated = myFranchise?.isEliminated;

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

  const submitBid = (amount) => {
    if (!myFranchise || submittingBid) return;
    setSubmittingBid(true);
    setBidError(null);
    setPulseBid(true);
    setTimeout(() => setPulseBid(false), 400);

    onPlaceBid({
      franchiseId: myFranchise.id,
      bidAmount: amount,
      expectedVersion: lot.stateVersion
    }, (res) => {
      setSubmittingBid(false);
      if (!res?.success) {
        setBidError(res?.error || "Bid could not be processed");
      }
    });
  };

  const handleMainBidClick = () => {
    if (!canBid) return;
    submitBid(lot.nextValidBid);
  };

  // Quick increment buttons (+0.25, +0.50, +1.00, +2.00)
  const handleQuickIncrement = (inc) => {
    if (!canBid) return;
    const base = lot.highestBid > 0 ? lot.highestBid : player.basePrice;
    const targetBid = Math.round((base + inc) * 100) / 100;
    submitBid(targetBid);
  };

  // Handle custom bid modal submission
  const handleCustomBidSubmit = (e) => {
    e.preventDefault();
    const amount = parseFloat(customBidAmount);
    if (isNaN(amount) || amount < lot.nextValidBid) {
      setCustomBidError(`Amount must be at least ₹${lot.nextValidBid.toFixed(2)} Cr`);
      return;
    }
    const cents = Math.round(amount * 100);
    if (cents % 25 !== 0) {
      setCustomBidError(`Amount must be in multiples of ₹0.25 Cr`);
      return;
    }
    submitBid(amount);
    setIsCustomBidOpen(false);
    setCustomBidAmount('');
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(room.roomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // Countdown timer calculations (15-second authoritative auction timer)
  const timerRadius = 40;
  const timerCircumference = 2 * Math.PI * timerRadius;
  const timerDuration = room.config.timerDuration || 15;
  const timerPct = Math.max(0, lot.countdown / timerDuration);
  const strokeDashoffset = timerCircumference - timerPct * timerCircumference;
  const isUrgent = lot.countdown <= 6;
  const isCritical = lot.countdown <= 3;
  const timerColor = isCritical ? "#EF4444" : isUrgent ? "#F59E0B" : "#10B981";

  // Complete catalogue & marquee list state (all ~300 players)
  const catalog = room.playersCatalog || [];
  const currentIdx = room.currentPlayerIndex >= 0 ? room.currentPlayerIndex : 0;
  const currentLotPlayerId = player?.id || (catalog[currentIdx]?.id);

  // Search and filter state for complete catalogue
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL'); // 'ALL' | 'BAT' | 'BOWL' | 'AR' | 'SP' | 'WK'
  const [nationalityFilter, setNationalityFilter] = useState('ALL'); // 'ALL' | 'IND' | 'OS'
  const [statusFilter, setStatusFilter] = useState('ALL'); // 'ALL' | 'CURRENT' | 'UPCOMING' | 'SOLD' | 'UNSOLD'

  const activePlayerCardRef = useRef(null);
  const marqueeContainerRef = useRef(null);

  // Quick lookup map of completed room history lots
  const historyMap = useMemo(() => {
    const map = {};
    (room.history || []).forEach(h => {
      if (h.player?.id) {
        map[h.player.id] = h;
      }
    });
    return map;
  }, [room.history]);

  // Process all catalog players preserving exact round-robin sequence with dynamic statuses
  const processedCatalog = useMemo(() => {
    return catalog.map((p, idx) => {
      const isCurrent = p.id === currentLotPlayerId;
      const historyItem = historyMap[p.id];

      let computedStatus = 'upcoming';
      let soldToCode = null;
      let soldPrice = 0;

      if (isCurrent) {
        computedStatus = 'current';
      } else if (p.status === 'sold' || historyItem?.status === 'SOLD') {
        computedStatus = 'sold';
        soldToCode = p.soldTo || historyItem?.winningFranchiseCode || historyItem?.winningFranchiseId;
        soldPrice = p.soldPrice || historyItem?.finalBid || 0;
      } else if (p.status === 'unsold' || historyItem?.status === 'UNSOLD') {
        computedStatus = 'unsold';
      } else if (room.currentPlayerIndex > idx) {
        computedStatus = 'unsold';
      } else {
        computedStatus = 'upcoming';
      }

      return {
        ...p,
        catalogOrder: p.overallLot || (idx + 1),
        computedStatus,
        soldToCode,
        soldPrice,
        isCurrent
      };
    });
  }, [catalog, currentLotPlayerId, historyMap, room.currentPlayerIndex]);

  // Overall catalog statistics
  const catalogStats = useMemo(() => {
    let sold = 0;
    let unsold = 0;
    processedCatalog.forEach(p => {
      if (p.computedStatus === 'sold') sold++;
      else if (p.computedStatus === 'unsold') unsold++;
    });
    return { sold, unsold, remaining: catalog.length - sold - unsold };
  }, [processedCatalog, catalog.length]);

  // Filtered catalogue without modifying the underlying sequence
  const filteredList = useMemo(() => {
    return processedCatalog.filter(p => {
      // 1. Search Query (name, country, role, set)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchName = (p.name || '').toLowerCase().includes(q);
        const matchCountry = (p.country || '').toLowerCase().includes(q) || (p.countryCode || '').toLowerCase().includes(q);
        const matchRole = (p.role || '').toLowerCase().includes(q);
        const matchSet = (p.setName || '').toLowerCase().includes(q);
        if (!matchName && !matchCountry && !matchRole && !matchSet) return false;
      }

      // 2. Category Filter
      if (categoryFilter !== 'ALL') {
        if (p.category !== categoryFilter) return false;
      }

      // 3. Nationality Filter
      if (nationalityFilter === 'IND' && p.isOverseas) return false;
      if (nationalityFilter === 'OS' && !p.isOverseas) return false;

      // 4. Status Filter
      if (statusFilter !== 'ALL') {
        if (statusFilter === 'CURRENT' && p.computedStatus !== 'current') return false;
        if (statusFilter === 'UPCOMING' && p.computedStatus !== 'upcoming') return false;
        if (statusFilter === 'SOLD' && p.computedStatus !== 'sold') return false;
        if (statusFilter === 'UNSOLD' && p.computedStatus !== 'unsold') return false;
      }

      return true;
    });
  }, [processedCatalog, searchQuery, categoryFilter, nationalityFilter, statusFilter]);

  // Auto-scroll to active player on lot transition (when no search query is active)
  useEffect(() => {
    if (!searchQuery && activePlayerCardRef.current) {
      activePlayerCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentLotPlayerId]);

  // Navigation handlers
  const jumpToActiveLot = () => {
    if (searchQuery || categoryFilter !== 'ALL' || nationalityFilter !== 'ALL' || statusFilter !== 'ALL') {
      setSearchQuery('');
      setCategoryFilter('ALL');
      setNationalityFilter('ALL');
      setStatusFilter('ALL');
    }
    setTimeout(() => {
      if (activePlayerCardRef.current) {
        activePlayerCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 60);
  };

  const scrollToTop = () => {
    if (marqueeContainerRef.current) {
      marqueeContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const resetFilters = () => {
    setSearchQuery('');
    setCategoryFilter('ALL');
    setNationalityFilter('ALL');
    setStatusFilter('ALL');
  };

  // Next 3 upcoming players for the bottom marquee ticker
  const nextThree = catalog.slice(currentIdx + 1, currentIdx + 4);

  return (
    <div className="w-full max-w-[1600px] mx-auto px-3 sm:px-6 py-4 space-y-4">
      {/* 1. TOP STADIUM ARENA BANNER (Matches Reference Image) */}
      <div className="relative w-full rounded-2xl overflow-hidden border border-white/10 shadow-2xl bg-gradient-to-b from-[#0a153a] via-[#050b25] to-[#04081a]">
        {/* Spotlight Arena Backdrop */}
        <div className="h-32 sm:h-40 w-full relative flex items-center justify-center overflow-hidden">
          {/* Subtle Stadium Light Beam Gradients */}
          <div className="absolute inset-0 bg-gradient-to-r from-blue-900/40 via-purple-900/30 to-blue-900/40 pointer-events-none" />
          <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-[700px] h-40 bg-gradient-to-b from-blue-500/20 via-purple-500/10 to-transparent blur-3xl pointer-events-none" />

          {/* Hanging Team Banners Arc */}
          <div className="relative z-10 flex items-center justify-between w-full max-w-5xl px-4 gap-2 sm:gap-4">
            {/* Left 5 Teams */}
            <div className="flex items-center gap-1.5 sm:gap-3">
              {['CSK', 'MI', 'RCB', 'KKR', 'SRH'].map(code => (
                <div key={code} className="flex flex-col items-center group transform transition hover:-translate-y-1">
                  <div className="w-8 sm:w-11 h-12 sm:h-16 rounded-b-xl border border-white/20 shadow-lg flex items-center justify-center font-black text-[10px] sm:text-xs"
                    style={{ backgroundColor: room.franchises[code]?.primaryColor || '#1e293b', color: room.franchises[code]?.textColor || '#fff' }}>
                    {code}
                  </div>
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1 shadow-sm shadow-amber-400/50" />
                </div>
              ))}
            </div>

            {/* Center Stage: IPL Trophy Pedestal */}
            <div className="flex flex-col items-center justify-center px-2 sm:px-4 py-1 rounded-2xl bg-slate-950/70 border border-amber-500/30 backdrop-blur-md shadow-2xl">
              <div className="flex items-center gap-2">
                <span className="text-amber-400 font-black text-xs sm:text-sm tracking-widest uppercase">IPL</span>
                <span className="text-white font-extrabold text-[10px] sm:text-xs tracking-wider uppercase">AUCTION</span>
              </div>
              <div className="w-12 h-1 bg-gradient-to-r from-transparent via-amber-400 to-transparent mt-1" />
            </div>

            {/* Right 5 Teams */}
            <div className="flex items-center gap-1.5 sm:gap-3">
              {['RR', 'DC', 'PBKS', 'GT', 'LSG'].map(code => (
                <div key={code} className="flex flex-col items-center group transform transition hover:-translate-y-1">
                  <div className="w-8 sm:w-11 h-12 sm:h-16 rounded-b-xl border border-white/20 shadow-lg flex items-center justify-center font-black text-[10px] sm:text-xs"
                    style={{ backgroundColor: room.franchises[code]?.primaryColor || '#1e293b', color: room.franchises[code]?.textColor || '#fff' }}>
                    {code}
                  </div>
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1 shadow-sm shadow-amber-400/50" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 2. HORIZONTAL AUCTION INFORMATION & CONTROL BAR */}
        <div className="px-4 py-2.5 bg-[#08102d]/95 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* Left: Room Status & Lot Metadata */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* Room Code Pill */}
            <div className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/40 px-3 py-1.5 rounded-xl text-amber-300 font-bold shadow-sm">
              <span className="text-[11px] text-amber-400/80">Room:</span>
              <span className="font-mono tracking-wider font-extrabold">{room.roomCode}</span>
              <button
                onClick={copyRoomCode}
                className="hover:text-white transition p-0.5"
                title="Copy Room Code"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* Private Room Badge */}
            <span className="flex items-center gap-1.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 px-3 py-1.5 rounded-xl font-bold">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Private Room
            </span>

            {/* Complete Auction Category & Set Navigation Info */}
            <div className="hidden sm:flex items-center gap-2 bg-slate-900/95 border border-slate-700/80 px-3.5 py-1.5 rounded-xl text-slate-300 font-medium text-xs shadow-inner">
              <span className="text-amber-400 font-extrabold uppercase tracking-wider">
                CATEGORY: <strong className="text-white">{player.category}</strong>
              </span>
              <span className="text-slate-600">|</span>
              <span>
                SET: <strong className="text-amber-300 font-bold">{player.setName || player.categorySet}</strong>
              </span>
              <span className="text-slate-600">|</span>
              <span className="font-mono">
                LOT: <strong className="text-white">{String(player.lotInSet || 1).padStart(2, '0')} / {String(player.setTotal || 8).padStart(2, '0')}</strong>
              </span>
              <span className="text-slate-600">|</span>
              <span className="font-mono text-[11px] text-slate-400">
                COMPLETED: <strong className="text-emerald-400">{String((player.lotInSet || 1) - 1).padStart(2, '0')}</strong>
              </span>
              <span className="text-slate-600">|</span>
              <span className="font-mono text-[11px] text-slate-400">
                REMAINING: <strong className="text-amber-400">{String((player.setTotal || 8) - ((player.lotInSet || 1) - 1)).padStart(2, '0')}</strong>
              </span>
            </div>
          </div>

          {/* Right: Host Controls (Pause, Advance, Conclude) */}
          {participant?.isHost ? (
            <div className="flex items-center gap-2">
              <button
                onClick={onPauseResume}
                className={`px-3 py-1.5 rounded-xl font-bold flex items-center gap-1.5 border transition cursor-pointer ${
                  room.status === 'paused'
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 border-emerald-400 shadow-md shadow-emerald-500/20'
                    : 'bg-slate-800/90 hover:bg-slate-700 text-slate-200 border-slate-700'
                }`}
              >
                {room.status === 'paused' ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5" />}
                <span>{room.status === 'paused' ? 'Resume' : 'Pause'}</span>
              </button>

              <button
                onClick={onAdvanceLot}
                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold flex items-center gap-1 border border-blue-400/40 transition shadow-md cursor-pointer"
                title="Hammer down or close current lot"
              >
                <span>Advance Lot</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={onFinishAuction}
                className="px-3 py-1.5 rounded-xl bg-red-600/80 hover:bg-red-600 text-white font-bold border border-red-500/40 transition cursor-pointer shadow-md"
              >
                Conclude Auction
              </button>
            </div>
          ) : (
            <div className="text-xs text-slate-400 flex items-center gap-2">
              <span>Host: <strong className="text-amber-400">{room.hostName}</strong></span>
            </div>
          )}
        </div>
      </div>

      {/* 3. MAIN DASHBOARD: THREE-COLUMN BROADCAST LAYOUT (20% - 60% - 20%) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* LEFT COLUMN: COMPLETE MARQUEE CATALOGUE (All ~300 Players) */}
        <div className="lg:col-span-3 bg-[#0a1333]/90 border border-blue-900/40 rounded-2xl p-3.5 shadow-xl flex flex-col justify-between backdrop-blur-md">
          <div className="flex flex-col flex-1 min-h-0">
            {/* Header: Title with Dynamic Total Count & Quick Navigation */}
            <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-white/10 flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Star className="w-4 h-4 text-amber-400 fill-amber-400 flex-shrink-0" />
                <h3 className="text-xs font-black tracking-wider uppercase text-white truncate">
                  MARQUEE LIST ({filteredList.length === catalog.length ? catalog.length : `${filteredList.length} / ${catalog.length}`})
                </h3>
              </div>

              {/* Jump to Active Lot & Scroll to Top Buttons */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={jumpToActiveLot}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[10px] font-black transition cursor-pointer shadow-sm group"
                  title="Jump to Current Active Lot"
                >
                  <Radio className="w-3 h-3 text-amber-400 animate-pulse" />
                  <span>Live Lot</span>
                </button>
                <button
                  onClick={scrollToTop}
                  className="flex items-center gap-1 p-1 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[10px] font-bold transition cursor-pointer"
                  title="Scroll to Top (#1)"
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Search Input */}
            <div className="relative mb-2 flex-shrink-0">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search player, country, role..."
                className="w-full bg-slate-900/90 border border-slate-700/80 rounded-xl pl-8 pr-7 py-1.5 text-xs text-white placeholder-slate-500 outline-none focus:border-amber-400/80 transition"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-white"
                  title="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Filter Pills Toolbar */}
            <div className="space-y-1.5 mb-2.5 flex-shrink-0">
              {/* Category Pills */}
              <div className="flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-none text-[10px]">
                <span className="text-slate-500 font-bold uppercase text-[9px] mr-0.5 flex items-center gap-0.5">
                  <Filter className="w-2.5 h-2.5" /> CAT:
                </span>
                {['ALL', 'BAT', 'BOWL', 'AR', 'SP', 'WK'].map(cat => (
                  <button
                    key={cat}
                    onClick={() => setCategoryFilter(cat)}
                    className={`px-1.5 py-0.5 rounded font-extrabold uppercase transition cursor-pointer border ${
                      categoryFilter === cat
                        ? 'bg-amber-400 text-slate-950 border-amber-300 shadow-sm'
                        : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Nationality & Status Filters */}
              <div className="flex items-center justify-between text-[10px] gap-1">
                {/* Nationality */}
                <div className="flex items-center gap-1">
                  <span className="text-slate-500 font-bold text-[9px]">NAT:</span>
                  {[
                    { label: 'All', val: 'ALL' },
                    { label: 'IND', val: 'IND' },
                    { label: 'OS', val: 'OS' }
                  ].map(n => (
                    <button
                      key={n.val}
                      onClick={() => setNationalityFilter(n.val)}
                      className={`px-1.5 py-0.5 rounded font-bold transition cursor-pointer border text-[9px] ${
                        nationalityFilter === n.val
                          ? 'bg-blue-500 text-white border-blue-400 shadow-sm'
                          : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white'
                      }`}
                    >
                      {n.label}
                    </button>
                  ))}
                </div>

                {/* Status Dropdown */}
                <div className="flex items-center gap-1">
                  <span className="text-slate-500 font-bold text-[9px]">STATUS:</span>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="bg-slate-900 border border-slate-700/80 text-slate-200 text-[10px] font-bold rounded px-1.5 py-0.5 outline-none focus:border-amber-400"
                  >
                    <option value="ALL">All Status</option>
                    <option value="CURRENT">⚡ Current</option>
                    <option value="UPCOMING">⏳ Upcoming</option>
                    <option value="SOLD">✓ Sold</option>
                    <option value="UNSOLD">✗ Unsold</option>
                  </select>
                </div>

                {/* Reset button if any filter active */}
                {(searchQuery || categoryFilter !== 'ALL' || nationalityFilter !== 'ALL' || statusFilter !== 'ALL') && (
                  <button
                    onClick={resetFilters}
                    className="text-[9px] text-amber-400 hover:underline flex items-center gap-0.5 font-bold cursor-pointer flex-shrink-0"
                    title="Reset all filters"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* Scrollable Player Rows (All ~300 Players in Round-Robin Sequence) */}
            <div
              ref={marqueeContainerRef}
              className="flex-1 overflow-y-auto overscroll-contain player-list-scroll pr-1.5 space-y-1.5 min-h-[440px] max-h-[520px]"
            >
              {filteredList.length === 0 ? (
                <div className="py-12 text-center text-slate-500 space-y-2">
                  <p className="text-xs">No players match your active filters</p>
                  <button
                    onClick={resetFilters}
                    className="text-xs text-amber-400 hover:underline font-bold cursor-pointer"
                  >
                    Reset filters
                  </button>
                </div>
              ) : (
                filteredList.map((p) => {
                  const isCurrent = p.isCurrent;
                  const isSold = p.computedStatus === 'sold';
                  const isUnsold = p.computedStatus === 'unsold';

                  return (
                    <div
                      key={p.id}
                      ref={isCurrent ? activePlayerCardRef : null}
                      className={`p-2 rounded-xl border transition-all duration-200 flex items-center justify-between gap-2 text-xs relative ${
                        isCurrent
                          ? 'border-2 border-amber-400 bg-gradient-to-r from-amber-500/25 via-yellow-500/15 to-blue-950/40 shadow-lg shadow-amber-500/20 ring-2 ring-amber-400/50'
                          : isSold
                          ? 'border-emerald-500/25 bg-emerald-950/20 opacity-80 hover:opacity-100'
                          : isUnsold
                          ? 'border-rose-900/30 bg-rose-950/15 opacity-70 hover:opacity-100'
                          : 'border-white/5 bg-slate-900/40 hover:bg-slate-800/40 hover:border-slate-700/60'
                      }`}
                    >
                      {/* Left: Catalogue Order Number + Avatar + Metadata */}
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className={`text-[11px] font-mono font-black w-6 text-center flex-shrink-0 ${
                          isCurrent ? 'text-amber-400 font-extrabold' : isSold ? 'text-emerald-400' : isUnsold ? 'text-rose-400' : 'text-slate-500'
                        }`}>
                          #{p.catalogOrder}
                        </span>

                        {/* Player Circular Avatar */}
                        <div className={`w-9 h-9 rounded-full overflow-hidden flex-shrink-0 border flex items-center justify-center font-bold text-[10px] relative ${
                          isCurrent
                            ? 'border-amber-400 bg-amber-500/20 text-amber-300 ring-2 ring-amber-400/40'
                            : isSold
                            ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300'
                            : isUnsold
                            ? 'border-rose-900/40 bg-rose-950/40 text-rose-300'
                            : 'border-slate-700 bg-slate-800 text-slate-300'
                        }`}>
                          <img
                            src={p.imageUrl}
                            alt={p.name}
                            loading="lazy"
                            className="w-full h-full object-cover object-top"
                            onError={(e) => {
                              e.target.style.display = 'none';
                              if (e.target.nextSibling) e.target.nextSibling.style.display = 'flex';
                            }}
                          />
                          <span className="hidden w-full h-full items-center justify-center font-mono font-bold text-[11px] bg-slate-800 text-slate-300">
                            {p.initials || p.name.substring(0, 2).toUpperCase()}
                          </span>
                        </div>

                        {/* Player Name, Nationality & Category Set */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 truncate">
                            <span
                              className={`font-bold truncate text-[11px] ${
                                isCurrent ? 'text-white font-black' : isSold ? 'text-slate-200' : isUnsold ? 'text-slate-400 line-through' : 'text-slate-200'
                              }`}
                              title={p.name}
                            >
                              {p.name}
                            </span>
                          </div>

                          <div className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                            <span className="flex items-center gap-1">
                              <span>{p.countryFlag || '🏏'}</span>
                              <span className="font-mono">{p.countryCode || p.country}</span>
                            </span>
                            {p.isOverseas ? (
                              <span className="text-[9px] font-extrabold text-blue-400 bg-blue-500/10 px-1 py-0.2 rounded flex items-center gap-0.5">
                                <Plane className="w-2.5 h-2.5" /> OS
                              </span>
                            ) : (
                              <span className="text-[9px] font-extrabold text-emerald-400 bg-emerald-500/10 px-1 py-0.2 rounded">
                                IND
                              </span>
                            )}
                            <span className="text-slate-600">•</span>
                            <span className="text-[9px] text-slate-400 truncate">{p.setName}</span>
                          </div>
                        </div>
                      </div>

                      {/* Right: Category badge + Dynamic Auction Status */}
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <CategoryBadge category={p.category} />

                        {/* Dynamic Auction Status Badge */}
                        {isCurrent ? (
                          <span className="flex items-center gap-1 bg-amber-400 text-slate-950 font-black px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider shadow-sm animate-pulse">
                            <Radio className="w-2.5 h-2.5 fill-current" />
                            CURRENT
                          </span>
                        ) : isSold ? (
                          <div className="flex items-center gap-1 text-[9px] font-bold text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 rounded">
                            <span className="text-emerald-400">SOLD</span>
                            <span className="text-slate-500">•</span>
                            <strong className="text-white">{p.soldToCode}</strong>
                            <span className="font-mono text-emerald-300">₹{p.soldPrice?.toFixed(2)} Cr</span>
                          </div>
                        ) : isUnsold ? (
                          <span className="bg-rose-500/15 border border-rose-500/30 text-rose-400 font-bold px-1.5 py-0.5 rounded text-[9px]">
                            UNSOLD
                          </span>
                        ) : (
                          <span className="text-slate-400 text-[10px] font-mono bg-slate-800/60 border border-slate-700/50 px-1.5 py-0.5 rounded">
                            ₹{p.basePrice?.toFixed(2)} Cr
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Footer: Dynamic Summary Statistics */}
          <div className="pt-2.5 mt-2 border-t border-white/10 text-[10px] text-slate-400 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <span>Sold: <strong className="text-emerald-400">{catalogStats.sold}</strong></span>
              <span className="text-slate-700">|</span>
              <span>Unsold: <strong className="text-rose-400">{catalogStats.unsold}</strong></span>
              <span className="text-slate-700">|</span>
              <span>Remaining: <strong className="text-amber-400">{catalogStats.remaining}</strong></span>
            </div>
            <span>Total: <strong className="text-white font-mono">{catalog.length}</strong></span>
          </div>
        </div>

        {/* CENTER COLUMN (60%): PLAYER PROFILE + LIVE BIDDING ARENA */}
        <div className="lg:col-span-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* CENTER-LEFT: PLAYER PROFILE CARD */}
          <div className="bg-[#0b1437]/90 border border-blue-800/40 rounded-2xl p-4 shadow-xl flex flex-col justify-between backdrop-blur-md relative overflow-hidden">
            {/* Header: Country Flag & Franchise badge */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-700/80 px-2.5 py-1 rounded-xl text-xs font-bold text-slate-200 shadow">
                  <span className="text-base">{player.countryFlag || "🏏"}</span>
                  <span className="font-mono uppercase">{player.countryCode || player.country}</span>
                  {player.isOverseas && (
                    <span className="text-[9px] text-blue-400 bg-blue-500/10 px-1 rounded ml-1 font-extrabold">OS</span>
                  )}
                </div>

                {/* Team Logo (MI, CSK etc) */}
                <FranchiseBadge code={highestBidderFranchise?.code || "MI"} size="md" />
              </div>

              {/* Dynamic High-Resolution Player Image */}
              <div className="w-full h-52 sm:h-56 rounded-xl bg-gradient-to-b from-blue-950/60 via-slate-900 to-slate-950 border border-blue-500/20 overflow-hidden relative flex items-center justify-center shadow-inner group">
                {!imgError ? (
                  <img
                    key={player.id}
                    src={player.imageUrl}
                    alt={player.name}
                    onError={() => setImgError(true)}
                    className="w-full h-full object-cover object-top transition duration-500 group-hover:scale-105"
                  />
                ) : (
                  <div className="w-24 h-24 rounded-2xl bg-gradient-to-tr from-amber-500 to-yellow-400 flex items-center justify-center text-slate-950 font-black text-3xl shadow-2xl">
                    {player.initials}
                  </div>
                )}

                {/* Category overlay badge */}
                <div className="absolute top-2.5 left-2.5">
                  <CategoryBadge category={player.category} />
                </div>
              </div>

              {/* Player Identity & OVR Badge */}
              <div className="flex items-start justify-between mt-3 gap-2">
                <div>
                  <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight uppercase leading-none">
                    {player.name}
                  </h2>
                  <div className="text-xs font-semibold text-slate-400 mt-1">
                    {player.role}
                  </div>
                </div>

                {/* Golden Laurel Wreath Rating */}
                <div className="flex flex-col items-center justify-center px-2 py-1 rounded-xl bg-amber-500/10 border border-amber-500/30 shadow-md">
                  <span className="text-[8px] font-extrabold text-amber-400 uppercase tracking-wider">OVR</span>
                  <span className="text-lg font-black text-amber-300 font-mono leading-none">{player.rating}</span>
                </div>
              </div>

              {/* 4 Performance Metric Blocks */}
              <div className="grid grid-cols-4 gap-1.5 mt-3 text-center">
                <div className="bg-slate-900/80 border border-slate-800 p-1.5 rounded-lg">
                  <span className="text-[9px] text-slate-400 uppercase font-semibold block">Matches</span>
                  <span className="text-xs font-bold text-white font-mono">{player.stats.matches || 0}</span>
                </div>

                {player.category === 'BAT' || player.category === 'WK' ? (
                  <>
                    <div className="bg-slate-900/80 border border-slate-800 p-1.5 rounded-lg">
                      <span className="text-[9px] text-slate-400 uppercase font-semibold block">Runs</span>
                      <span className="text-xs font-bold text-white font-mono">{player.stats.runs || 0}</span>
                    </div>
                    <div className="bg-slate-900/80 border border-slate-800 p-1.5 rounded-lg">
                      <span className="text-[9px] text-slate-400 uppercase font-semibold block">SR</span>
                      <span className="text-xs font-black text-emerald-400 font-mono">{player.stats.sr || "130.0"}</span>
                    </div>
                    <div className="bg-slate-900/80 border border-slate-800 p-1.5 rounded-lg">
                      <span className="text-[9px] text-slate-400 uppercase font-semibold block">HS</span>
                      <span className="text-xs font-bold text-amber-400 font-mono">{player.stats.hs || "75*"}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="bg-slate-900/80 border border-slate-800 p-1.5 rounded-lg">
                      <span className="text-[9px] text-slate-400 uppercase font-semibold block">Wickets</span>
                      <span className="text-xs font-bold text-white font-mono">{player.stats.wickets || 0}</span>
                    </div>
                    <div className="bg-slate-900/80 border border-slate-800 p-1.5 rounded-lg">
                      <span className="text-[9px] text-slate-400 uppercase font-semibold block">Economy</span>
                      <span className="text-xs font-black text-emerald-400 font-mono">{player.stats.econ || "7.50"}</span>
                    </div>
                    <div className="bg-slate-900/80 border border-slate-800 p-1.5 rounded-lg">
                      <span className="text-[9px] text-slate-400 uppercase font-semibold block">BBI</span>
                      <span className="text-xs font-bold text-amber-400 font-mono">{player.stats.bbi || "3/20"}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Base Price Footer Pill */}
            <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between bg-slate-950/70 p-2.5 rounded-xl border border-white/5">
              <span className="text-xs font-bold text-slate-400 uppercase">Base Price</span>
              <span className="text-base font-black text-amber-400 font-mono">
                ₹{player.basePrice.toFixed(2)} Cr
              </span>
            </div>
          </div>

          {/* CENTER-RIGHT: LIVE BIDDING INTERFACE */}
          <div className="bg-[#0b1437]/90 border border-blue-800/40 rounded-2xl p-4 shadow-xl flex flex-col justify-between backdrop-blur-md space-y-4">
            {/* Top: Current Highest Bid with Gold Laurel Header */}
            <div className="bg-gradient-to-b from-slate-900/90 to-slate-950 p-4 rounded-xl border border-amber-500/30 text-center relative shadow-lg">
              <div className="flex items-center justify-center gap-2 mb-1">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-400">
                  CURRENT HIGHEST BID
                </span>
              </div>

              {/* Big Gold Bid Amount */}
              <div className="text-3xl sm:text-4xl font-black text-amber-300 font-mono tracking-tight my-1 drop-shadow-md">
                ₹{lot.highestBid > 0 ? lot.highestBid.toFixed(2) : player.basePrice.toFixed(2)}
                <span className="text-xl font-bold ml-1 text-amber-400">Cr</span>
              </div>

              <div className="text-[11px] text-slate-400 truncate">
                {highestBidderFranchise ? (
                  <span className="text-emerald-400 font-bold">
                    Leader: {highestBidderFranchise.name} ({highestBidderFranchise.ownerName})
                  </span>
                ) : (
                  <span>Opening bid at player's base price</span>
                )}
              </div>
            </div>

            {/* Circular Countdown Timer */}
            <div className="flex items-center justify-center gap-4 py-1">
              <div className="relative w-24 h-24 flex items-center justify-center">
                <svg className="w-full h-full transform -rotate-90">
                  <circle
                    cx="48"
                    cy="48"
                    r={timerRadius}
                    stroke="#1e293b"
                    strokeWidth="7"
                    fill="transparent"
                  />
                  <circle
                    cx="48"
                    cy="48"
                    r={timerRadius}
                    stroke={timerColor}
                    strokeWidth="7"
                    strokeDasharray={timerCircumference}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    fill="transparent"
                    className="transition-all duration-1000 ease-linear"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                  <span className="text-[8px] font-extrabold uppercase tracking-wider text-slate-400">TIME LEFT</span>
                  <span className={`text-2xl font-black font-mono leading-none ${isCritical ? 'text-red-400 animate-pulse' : isUrgent ? 'text-amber-400' : 'text-white'}`}>
                    {Math.max(0, lot.countdown)}s
                  </span>
                </div>
              </div>
            </div>

            {/* Main Action Buttons */}
            <div className="space-y-2">
              {bidError && (
                <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-[11px] flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{bidError}</span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                {/* Large Gold Bidding Button (2 cols) */}
                <button
                  onClick={handleMainBidClick}
                  disabled={!canBid || submittingBid}
                  className={`col-span-2 py-3 px-3 rounded-xl font-black text-sm sm:text-base tracking-wide transition flex items-center justify-center gap-1.5 shadow-xl relative cursor-pointer ${
                    canBid
                      ? 'bg-gradient-to-r from-amber-400 via-amber-500 to-yellow-500 hover:from-amber-300 hover:to-yellow-400 text-slate-950 shadow-amber-500/30 active:scale-95'
                      : 'bg-slate-900 border border-slate-800 text-slate-500 cursor-not-allowed opacity-70'
                  } ${pulseBid ? 'animate-bid-pulse ring-4 ring-amber-400' : ''}`}
                >
                  <Gavel className="w-4 h-4 fill-current animate-hammer" />
                  <span>BID ₹{lot.nextValidBid.toFixed(2)} Cr</span>
                </button>

                {/* Custom Bid Button */}
                <button
                  onClick={() => setIsCustomBidOpen(true)}
                  disabled={!canBid}
                  className={`py-3 px-2 rounded-xl font-bold text-xs flex items-center justify-center gap-1 border transition cursor-pointer ${
                    canBid
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                      : 'bg-slate-900/60 border-slate-800 text-slate-600 cursor-not-allowed'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5 text-amber-400" />
                  <span>Custom</span>
                </button>
              </div>

              {/* 4 Quick Bid Increment Buttons */}
              <div className="grid grid-cols-4 gap-1.5 pt-1">
                {[0.25, 0.50, 1.00, 2.00].map(inc => (
                  <button
                    key={inc}
                    onClick={() => handleQuickIncrement(inc)}
                    disabled={!canBid}
                    className={`py-1.5 rounded-lg text-[11px] font-bold border transition cursor-pointer ${
                      canBid
                        ? 'bg-slate-900 hover:bg-blue-600/30 hover:border-blue-400 text-slate-200 border-slate-700'
                        : 'bg-slate-950 border-slate-900 text-slate-600 cursor-not-allowed'
                    }`}
                  >
                    + ₹{inc.toFixed(2)} Cr
                  </button>
                ))}
              </div>

              {!canBid && (
                <div className="text-center text-[10px] text-slate-400 flex items-center justify-center gap-1 pt-1">
                  <AlertTriangle className="w-3 h-3 text-amber-400" />
                  <span>{cannotBidReason}</span>
                </div>
              )}
            </div>

            {/* Bidding Activity Table */}
            <div className="bg-slate-950/70 rounded-xl p-2.5 border border-white/5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-300 px-1">
                <span className="flex items-center gap-1">
                  <TrendingUp className="w-3 h-3 text-amber-400" />
                  Bidding Activity
                </span>
                <span className="text-[10px] font-mono text-slate-500">
                  {lot.bidHistory.length} bids
                </span>
              </div>

              <div className="max-h-24 overflow-y-auto space-y-1 text-[11px]">
                {lot.bidHistory.length === 0 ? (
                  <div className="text-center text-slate-500 py-2 italic text-[11px]">
                    Awaiting first bid...
                  </div>
                ) : (
                  [...lot.bidHistory].reverse().slice(0, 5).map((b, i) => (
                    <div key={b.bidId || i} className="flex items-center justify-between py-1 px-2 rounded-lg bg-slate-900/60 border border-slate-800 text-[11px]">
                      <span className="text-slate-500 font-mono w-4">#{lot.bidHistory.length - i}</span>
                      <div className="flex items-center gap-1.5 font-bold">
                        <FranchiseBadge code={b.franchiseCode} size="sm" />
                        <span className="text-slate-200">{b.franchiseCode}</span>
                      </div>
                      <span className="font-mono font-bold text-emerald-400">
                        ₹{b.bidAmount.toFixed(2)} Cr
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {new Date(b.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (20%): TEAMS OVERVIEW (10) */}
        <div className="lg:col-span-3 bg-[#0a1333]/90 border border-blue-900/40 rounded-2xl p-3.5 shadow-xl flex flex-col justify-between backdrop-blur-md">
          <div>
            <div className="flex items-center justify-between pb-3 mb-2 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-amber-400" />
                <h3 className="text-xs font-black tracking-wider uppercase text-white">
                  TEAMS OVERVIEW ({Object.keys(room.franchises).length})
                </h3>
              </div>
              <span className="text-[10px] text-slate-400 font-mono">Purse / Squad</span>
            </div>

            {/* Table Header */}
            <div className="grid grid-cols-12 text-[10px] font-bold text-slate-400 px-2 py-1 uppercase tracking-wider">
              <span className="col-span-5">Team</span>
              <span className="col-span-4 text-right">Purse (Cr)</span>
              <span className="col-span-3 text-right">Squad</span>
            </div>

            {/* All 10 Franchises Table */}
            <div className="space-y-1 max-h-[510px] overflow-y-auto pr-1">
              {Object.values(room.franchises).map(f => {
                const isLeader = lot.highestBidderFranchiseId === f.id;
                const isMe = myFranchise?.id === f.id;

                return (
                  <div
                    key={f.id}
                    onClick={() => onOpenSquad && onOpenSquad(f.id)}
                    className={`grid grid-cols-12 items-center p-2 rounded-xl border transition cursor-pointer text-xs ${
                      isLeader
                        ? 'border-amber-400 bg-amber-500/15 shadow-sm'
                        : isMe
                        ? 'border-blue-500/60 bg-blue-500/10'
                        : 'border-white/5 bg-slate-900/40 hover:bg-slate-800/40'
                    }`}
                  >
                    {/* Team logo & short code */}
                    <div className="col-span-5 flex items-center gap-1.5 min-w-0">
                      {isLeader && <Gavel className="w-3 h-3 text-amber-400 fill-current animate-bounce" />}
                      <FranchiseBadge code={f.code} size="sm" />
                      <span className={`font-black truncate ${isMe ? 'text-amber-300' : 'text-white'}`}>
                        {f.code}
                      </span>
                    </div>

                    {/* Remaining Purse */}
                    <div className="col-span-4 text-right font-mono font-bold text-emerald-400">
                      {f.isEliminated ? (
                        <span className="text-[10px] text-red-400">OUT</span>
                      ) : (
                        `₹${f.remainingPurse.toFixed(2)}`
                      )}
                    </div>

                    {/* Squad Count */}
                    <div className="col-span-3 text-right font-mono text-[11px] text-slate-300">
                      <strong>{f.squad.length}</strong>/{room.config.minSquadSize}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-3 mt-2 border-t border-white/10 text-[10px] text-slate-400 flex items-center justify-between">
            <span>Base Purse: ₹{room.config.basePurse} Cr</span>
            <span>Max OS: 8</span>
          </div>
        </div>
      </div>

      {/* 4. BOTTOM AUCTION MARQUEE & RULES TICKER STRIP */}
      <div className="w-full bg-[#08102d]/95 border border-white/10 rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs shadow-lg">
        {/* Left: Auction Marquee Ticker */}
        <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-[280px]">
          <span className="flex items-center gap-1.5 text-amber-400 font-extrabold uppercase text-[10px] bg-amber-500/15 border border-amber-500/30 px-2.5 py-1 rounded-lg flex-shrink-0">
            <Radio className="w-3 h-3 text-amber-400 animate-pulse" />
            AUCTION MARQUEE
          </span>

          <div className="truncate text-slate-300 text-xs">
            <span className="font-semibold text-slate-400 mr-1.5">Next 3 Players:</span>
            {nextThree.length > 0 ? (
              nextThree.map((p, i) => (
                <span key={p.id}>
                  <strong className="text-white">{p.name}</strong>{' '}
                  <span className="text-[10px] text-amber-400 font-bold">({p.category})</span>
                  {i < nextThree.length - 1 && <span className="text-slate-600 mx-2">•</span>}
                </span>
              ))
            ) : (
              <span className="italic text-slate-500">No more upcoming players</span>
            )}
          </div>
        </div>

        {/* Right: Quick Rules Indicators */}
        <div className="flex items-center gap-3 text-[11px] text-slate-400 flex-shrink-0">
          <span>👥 10 Teams</span>
          <span className="text-slate-700">|</span>
          <span>🏏 Min 15 Players</span>
          <span className="text-slate-700">|</span>
          <span>✈️ Max 8 Overseas</span>
          <span className="text-slate-700">|</span>
          <span>🧤 Min 1 Wicketkeeper</span>
        </div>
      </div>

      {/* CUSTOM BID MODAL */}
      {isCustomBidOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="glass-panel p-6 rounded-3xl max-w-md w-full border border-amber-500/40 shadow-2xl relative space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black text-white flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-amber-400" /> Enter Custom Bid
              </h3>
              <button
                onClick={() => setIsCustomBidOpen(false)}
                className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-300">
              Enter a valid bid for <strong className="text-white">{player.name}</strong>. Must be at least the next minimum increment of <strong className="text-emerald-400">₹{lot.nextValidBid.toFixed(2)} Cr</strong>.
            </p>

            {customBidError && (
              <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                {customBidError}
              </div>
            )}

            <form onSubmit={handleCustomBidSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">
                  Bid Amount in ₹ Crores (multiples of 0.25 Cr)
                </label>
                <input
                  type="number"
                  step="0.25"
                  min={lot.nextValidBid}
                  max={myFranchise?.remainingPurse || 120}
                  value={customBidAmount}
                  onChange={e => setCustomBidAmount(e.target.value)}
                  placeholder={`Min ₹${lot.nextValidBid.toFixed(2)} Cr`}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white font-mono text-lg font-black focus:border-amber-400 outline-none"
                  autoFocus
                />
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-xs text-slate-400 space-y-1">
                <div>Your Remaining Purse: <strong className="text-emerald-400 font-mono">₹{myFranchise?.remainingPurse.toFixed(2)} Cr</strong></div>
                <div>Current Leader: <strong className="text-white">{lot.highestBidderName || 'None'}</strong> (₹{lot.highestBid.toFixed(2)} Cr)</div>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCustomBidOpen(false)}
                  className="flex-1 py-2.5 rounded-xl bg-slate-800 text-slate-300 font-bold text-xs hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs shadow-lg shadow-amber-500/20"
                >
                  Submit Bid
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
