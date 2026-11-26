import React, { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

// Accessible confirmation dialog (replaces window.confirm, which blocks the page and the timer UI)
export default function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default', onConfirm, onCancel }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    cancelRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;
  const danger = tone === 'danger';
  return (
    <div className="fixed inset-0 z-[80] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="bg-[#0a1230] border border-slate-700 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${danger ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'}`}>
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <h3 id="confirm-title" className="text-lg font-black text-white">{title}</h3>
            {body && <p className="text-sm text-slate-300 mt-1 leading-relaxed">{body}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button ref={cancelRef} type="button" onClick={onCancel}
            className="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-200 hover:bg-slate-700 font-bold text-sm">
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm}
            className={`px-4 py-2.5 rounded-xl font-black text-sm ${danger ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-amber-400 hover:bg-amber-300 text-slate-950'}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
