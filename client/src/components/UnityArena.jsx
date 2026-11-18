import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, MonitorX, RefreshCw, Loader2 } from 'lucide-react';
import { getArena } from '../utils/arenaController';
import { toArenaState } from '../utils/arenaState';

// Optional 3D auction hall (Unity WebGL). Purely a display of the room state React already
// has: it never receives a callback that could bid, pause, advance or change anything.
// If WebGL or the build is missing, or Unity fails, the rest of the auction is unaffected.

const PREF_KEY = 'ipl-arena-visible';
function readPref() {
  try {
    const v = globalThis.localStorage?.getItem(PREF_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* storage blocked */ }
  return !(globalThis.matchMedia?.('(max-width: 640px)').matches); // collapsed by default on phones
}
function writePref(v) { try { globalThis.localStorage?.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* ignore */ } }

export default function UnityArena({ room, compact = false }) {
  const arena = getArena();
  const hostRef = useRef(null);
  const [visible, setVisible] = useState(readPref);
  const [info, setInfo] = useState(() => arena.snapshot());

  useEffect(() => arena.subscribe(setInfo), [arena]);

  useEffect(() => {
    const host = hostRef.current;
    if (!visible || !host) return undefined;
    arena.attach(host);
    return () => arena.detach(host);
  }, [arena, visible]);

  const state = useMemo(() => toArenaState(room), [room]);
  useEffect(() => { if (visible) arena.push(state); }, [arena, state, visible, info.status]);

  // No build in this deployment: stay out of the way entirely.
  if (info.status === 'unavailable') return null;

  const toggle = () => { const v = !visible; setVisible(v); writePref(v); };
  const height = compact ? 'h-[200px] sm:h-[260px]' : 'h-[220px] sm:h-[340px] lg:h-[420px]';

  return (
    <section className="relative w-full rounded-2xl overflow-hidden border border-white/10 bg-[#030716]" aria-label="3D auction arena">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950/80 border-b border-white/5 text-[11px]">
        <span className="font-bold tracking-wider text-amber-300 uppercase">3D Arena <span className="text-slate-500 normal-case font-normal">· display only</span></span>
        <div className="flex items-center gap-2">
          {visible && info.status === 'ready' && (
            <select
              value={info.quality}
              onChange={(e) => arena.setQuality(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200"
              aria-label="Arena quality"
            >
              <option value="auto">Auto</option>
              <option value="high">High</option>
              <option value="low">Low</option>
            </select>
          )}
          <button onClick={toggle} className="flex items-center gap-1 px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:text-white cursor-pointer" aria-pressed={visible}>
            {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {visible ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {visible && (
        <div className={`relative w-full ${height}`}>
          <div ref={hostRef} className="absolute inset-0" />
          {(info.status === 'loading' || info.status === 'idle') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#030716]/90 text-slate-300 text-sm">
              <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
              <span>Loading the auction hall… {Math.round((info.progress || 0) * 100)}%</span>
              <span className="text-[11px] text-slate-500">The auction below works while this loads.</span>
            </div>
          )}
          {(info.status === 'unsupported' || info.status === 'failed') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6 bg-[#030716] text-slate-300 text-sm">
              <MonitorX className="w-6 h-6 text-slate-500" />
              <span>{info.status === 'unsupported' ? '3D arena unavailable: this browser has no WebGL.' : '3D arena could not start.'}</span>
              {info.error && info.status === 'failed' && <span className="text-[11px] text-slate-500 max-w-md">{info.error}</span>}
              <span className="text-[11px] text-slate-500">Bidding and every other control keep working normally.</span>
              {info.status === 'failed' && (
                <button onClick={() => arena.retry(hostRef.current)} className="mt-1 flex items-center gap-1 px-3 py-1 rounded border border-slate-600 hover:border-amber-400 text-slate-200 cursor-pointer">
                  <RefreshCw className="w-3.5 h-3.5" /> Retry
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
