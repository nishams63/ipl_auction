import React, { useEffect, useState } from 'react';
import { Gavel, Sparkles, XCircle } from 'lucide-react';

// Franchise logo/emblem badge
function FranchiseEmblem({ code, size = "lg" }) {
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
      className="w-14 h-14 rounded-2xl flex items-center justify-center font-black text-xl tracking-tighter shadow-2xl border-2 flex-shrink-0"
      style={{ backgroundColor: c.bg, color: c.text, borderColor: c.border }}
    >
      {code}
    </div>
  );
}

export default function CinematicAuctionOverlay({ eventData, onDismiss }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!eventData) return;
    setVisible(true);

    // Auto dismiss after 2.8 seconds
    const timer = setTimeout(() => {
      setVisible(false);
      if (onDismiss) onDismiss();
    }, 2800);

    return () => clearTimeout(timer);
  }, [eventData]);

  if (!eventData || !visible) return null;

  const { result, lot, historyEntry } = eventData;
  const isSold = result === 'SOLD';
  const player = lot?.player || historyEntry?.player;
  const winningFranchiseName = historyEntry?.winningFranchiseName || 'Winning Franchise';
  const winningFranchiseCode = historyEntry?.winningFranchiseCode || 'IPL';
  const finalBid = historyEntry?.finalBid || lot?.highestBid || player?.basePrice || 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-xl animate-fade-in pointer-events-auto">
      {/* Background Cinematic Light Beams */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className={`absolute -top-40 left-1/2 -translate-x-1/2 w-[800px] h-[600px] rounded-full blur-[140px] opacity-40 ${
          isSold ? 'bg-amber-500' : 'bg-red-600'
        }`} />
        <div className="absolute bottom-0 inset-x-0 h-40 bg-gradient-to-t from-slate-950 to-transparent" />
      </div>

      {/* Floating particles for SOLD celebration */}
      {isSold && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-3 h-3 bg-amber-400 rounded-full animate-ping opacity-75" />
          <div className="absolute top-1/3 right-1/4 w-2 h-2 bg-yellow-300 rounded-full animate-ping opacity-60 delay-150" />
          <div className="absolute bottom-1/3 left-1/3 w-3 h-3 bg-amber-300 rounded-full animate-ping opacity-70 delay-300" />
          <div className="absolute top-1/2 right-1/3 w-2.5 h-2.5 bg-yellow-400 rounded-full animate-ping opacity-50 delay-500" />
        </div>
      )}

      {/* Main Broadcast Presentation Card */}
      <div
        className={`relative max-w-xl w-full rounded-3xl p-6 sm:p-8 text-center shadow-2xl border transform transition-all duration-500 scale-100 ${
          isSold
            ? 'bg-gradient-to-b from-[#0a153a] via-[#060c26] to-[#030617] border-amber-400/60 shadow-amber-500/25 ring-2 ring-amber-400/30'
            : 'bg-gradient-to-b from-[#2a0e14] via-[#16070a] to-[#090204] border-red-500/50 shadow-red-500/20 ring-1 ring-red-500/30'
        }`}
      >
        {/* Hammer / Result Stamp Header */}
        <div className="flex flex-col items-center justify-center mb-4">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center mb-2 shadow-xl ${
            isSold
              ? 'bg-gradient-to-tr from-amber-400 to-yellow-500 text-slate-950 animate-bounce'
              : 'bg-red-600/30 text-red-400 border border-red-500/40'
          }`}>
            {isSold ? (
              <Gavel className="w-8 h-8 fill-current" />
            ) : (
              <XCircle className="w-8 h-8" />
            )}
          </div>

          <span
            className={`font-black text-4xl sm:text-5xl tracking-widest uppercase filter drop-shadow-lg ${
              isSold
                ? 'bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 bg-clip-text text-transparent'
                : 'text-red-500 tracking-wider'
            }`}
          >
            {isSold ? 'SOLD!' : 'UNSOLD'}
          </span>
          <div className={`w-24 h-1 mt-1 rounded-full ${isSold ? 'bg-gradient-to-r from-transparent via-amber-400 to-transparent' : 'bg-red-500/50'}`} />
        </div>

        {/* Player Photo with Glow Ring */}
        <div className="relative mx-auto w-36 h-36 sm:w-44 sm:h-44 rounded-2xl overflow-hidden my-3 border-2 shadow-2xl flex items-center justify-center bg-slate-900"
          style={{ borderColor: isSold ? '#F59E0B' : '#EF4444' }}>
          {player?.imageUrl ? (
            <img
              src={player.imageUrl}
              alt={player.name}
              className="w-full h-full object-cover object-top"
              onError={(e) => { e.target.style.display = 'none'; }}
            />
          ) : (
            <span className="text-3xl font-black text-white">{player?.initials || 'IPL'}</span>
          )}

          {/* Role badge */}
          <span className="absolute bottom-1.5 inset-x-2 py-0.5 rounded-md bg-slate-950/85 backdrop-blur-md text-[10px] font-bold text-slate-300 border border-white/10 uppercase tracking-wider">
            {player?.category} • {player?.role}
          </span>
        </div>

        {/* Player Name */}
        <h2 className="text-2xl sm:text-3xl font-black text-white uppercase tracking-tight mt-2">
          {player?.name}
        </h2>

        {/* Sold vs Unsold Details */}
        {isSold ? (
          <div className="mt-4 pt-4 border-t border-white/10 space-y-3">
            <div className="flex items-center justify-center gap-3">
              <FranchiseEmblem code={winningFranchiseCode} size="lg" />
              <div className="text-left">
                <span className="text-[10px] text-amber-400 font-extrabold uppercase tracking-widest block">
                  PURCHASED BY
                </span>
                <span className="text-base sm:text-lg font-black text-white">
                  {winningFranchiseName}
                </span>
              </div>
            </div>

            <div className="inline-block px-5 py-2 rounded-2xl bg-gradient-to-r from-amber-500/20 via-yellow-500/30 to-amber-500/20 border border-amber-400/50 shadow-inner">
              <span className="text-xs text-amber-300 font-bold uppercase tracking-wider block">
                FINAL SOLD PRICE
              </span>
              <span className="text-2xl sm:text-3xl font-black text-amber-300 font-mono">
                ₹{Number(finalBid).toFixed(2)} CRORE
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-4 pt-3 border-t border-red-500/20">
            <p className="text-sm font-semibold text-slate-400">
              No bids placed before time expired.
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Passed at base price of <strong className="text-slate-300 font-mono">₹{player?.basePrice?.toFixed(2)} Cr</strong>. Marked as Unsold.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
