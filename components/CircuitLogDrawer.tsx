'use client';

import { useEffect, useState } from 'react';
import type { CircuitEvent } from '@/hooks/useCircuitAlerts';
import { fmt, fmtPct } from '@/lib/format';

/** HH:MM:SS in IST (the market's clock). */
export const istTime = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

/** `[HH:MM:SS] | SYMBOL | UPPER | ₹price | +x.xx%` */
export function logLine(e: Pick<CircuitEvent, 'at' | 'symbol' | 'dir' | 'ltp' | 'pct'> & { demo?: boolean }): string {
  return `[${istTime(e.at)}] | ${e.symbol} | ${e.dir.toUpperCase()}${e.demo ? ' (DEMO)' : ''} | ₹${fmt(e.ltp)} | ${fmtPct(e.pct)}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** newest first */
  log: CircuitEvent[];
  onOpen: (symbol: string) => void;
  onClear: () => void;
}

/** Slide-over: chronological history of every circuit hit this session (oldest at the top). */
export function CircuitLogDrawer({ open, onClose, log, onOpen, onClear }: Props) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  const rows = [...log].reverse();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rows.map(logLine).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="fixed inset-0 z-[90]" data-testid="circuit-log-drawer">
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={onClose} />
      <aside role="dialog" aria-label="Circuit hit log" className="absolute inset-y-0 right-0 flex w-full max-w-lg flex-col border-l border-slate-800 bg-slate-900/90 shadow-2xl backdrop-blur-xl">
        <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="text-[14px] font-bold text-white">Circuit Hit Log <span className="font-normal text-slate-400">· {log.length} this session</span></h2>
          <button onClick={onClose} aria-label="Close log" className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white">✕</button>
        </header>
        <div className="flex gap-2 border-b border-slate-800 px-4 py-2 text-[11px]">
          <button onClick={copy} disabled={!rows.length} className="rounded border border-slate-700 bg-slate-800/60 px-2 py-1 font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40">{copied ? 'Copied ✓' : 'Copy log'}</button>
          <button onClick={onClear} disabled={!rows.length} className="rounded border border-slate-700 bg-slate-800/60 px-2 py-1 font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40">Clear</button>
          <span className="ml-auto self-center text-slate-500">times in IST</span>
        </div>
        <div className="flex-1 overflow-auto px-2 py-2">
          {!rows.length ? (
            <p className="p-4 text-center text-[12px] text-slate-400">No circuit hits yet. Hits on your watchlist and Focus Basket appear here as they happen.</p>
          ) : (
            <ul className="space-y-1 font-mono text-[12px]" data-testid="circuit-log-rows">
              {rows.map((e) => (
                <li key={e.id}>
                  <button onClick={() => { onOpen(e.symbol); onClose(); }} data-testid="circuit-log-row" className={`w-full rounded border px-2 py-1.5 text-left hover:bg-slate-800 ${e.dir === 'upper' ? 'border-emerald-500/30 text-emerald-300' : 'border-rose-500/30 text-rose-300'}`}>
                    {logLine(e)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
