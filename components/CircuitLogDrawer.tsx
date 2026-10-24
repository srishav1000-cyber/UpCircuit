'use client';

import { useEffect, useState } from 'react';
import type { CircuitEvent } from '@/hooks/useCircuitAlerts';
import { HISTORY_TABS, filterHistory, type HistoryEntry, type HistoryTab } from '@/lib/circuitTracker';
import type { Proximity } from '@/lib/analytics/proximity';
import { playChime, soundFor } from '@/lib/audioAlerts';
import { unlockAudioContext } from '@/lib/chime';
import { getNotify } from '@/lib/notifyStore';
import { fmt, fmtPct } from '@/lib/format';

/** HH:MM:SS in IST (the market's clock). */
export const istTime = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

/** `[HH:MM:SS] | SYMBOL | UPPER | ₹price | +x.xx% | band +5%` */
export function logLine(e: Pick<CircuitEvent, 'at' | 'symbol' | 'dir' | 'ltp' | 'pct'> & { demo?: boolean; band?: number }): string {
  const band = e.band ? ` | band ${e.dir === 'upper' ? '+' : '−'}${e.band}%` : '';
  return `[${istTime(e.at)}] | ${e.symbol} | ${e.dir.toUpperCase()}${e.demo ? ' (DEMO)' : ''} | ₹${fmt(e.ltp)} | ${fmtPct(e.pct)}${band}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** session hits merged with the account's Supabase alert_history, newest first */
  history: HistoryEntry[];
  /** stocks currently within 1.5 % of a circuit limit */
  near: Proximity[];
  nameOf: (symbol: string) => string;
  /** open the stock's research modal */
  onAnalyze: (symbol: string) => void;
  /** clears this session's entries (the account history stays in Supabase) */
  onClear: () => void;
  /** account sync is on → history persists across reloads and devices */
  synced: boolean;
}

const dateTime = (ms: number) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Plays the user's configured alert sound (Default siren for LC / arpeggio for UC, or the arpeggio for both) at their volume. */
export function testChime(dir: 'upper' | 'lower') {
  void unlockAudioContext();
  const n = getNotify();
  playChime(soundFor(dir, n.sound), n.volume);
}

function Actions({ symbol, dir, onAnalyze, onClose }: { symbol: string; dir: 'upper' | 'lower'; onAnalyze: (s: string) => void; onClose: () => void }) {
  return (
    <div className="mt-2 flex gap-2">
      <button type="button" onClick={() => testChime(dir)} data-testid="chime-test" className="rounded border border-slate-700 bg-slate-800/60 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-700">🔔 Test Chime</button>
      <button type="button" onClick={() => { onAnalyze(symbol); onClose(); }} data-testid="analyze" className="rounded border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent/20">Analyze →</button>
    </div>
  );
}

/** Slide-over circuit & anomaly desk: persistent history (Supabase alert_history) with category tabs, test-chime and analyze actions. */
export function CircuitLogDrawer({ open, onClose, history, near, nameOf, onAnalyze, onClear, synced }: Props) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<HistoryTab>('all');
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  const rows = filterHistory(history, tab);
  const showNear = tab === 'near' || tab === 'all';
  const count = (t: HistoryTab) => (t === 'near' ? near.length : t === 'all' ? history.length + near.length : filterHistory(history, t).length);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([...history].reverse().map((e) => logLine({ at: e.at, symbol: e.symbol, dir: e.dir, ltp: e.price, pct: e.pct ?? 0, band: e.band, demo: e.demo })).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  const empty = rows.length === 0 && (!showNear || near.length === 0);
  return (
    <div className="fixed inset-0 z-[90]" data-testid="circuit-log-drawer">
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={onClose} />
      <aside role="dialog" aria-label="Circuit breaker and anomaly desk" className="absolute inset-y-0 right-0 flex w-full max-w-lg flex-col border-l border-slate-800 bg-slate-900/90 shadow-2xl backdrop-blur-xl">
        <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="text-[14px] font-bold text-white">Circuit &amp; Anomaly Desk <span className="font-normal text-slate-400">· {history.length} logged</span></h2>
          <button onClick={onClose} aria-label="Close log" className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white">✕</button>
        </header>
        <div role="tablist" aria-label="Anomaly categories" className="flex flex-wrap gap-1.5 border-b border-slate-800 px-4 py-2">
          {HISTORY_TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} data-testid={`circuit-tab-${t.id}`} className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tab === t.id ? 'border-accent bg-accent/15 text-accent' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
              {t.label} <span className="num ml-0.5 text-[10px] opacity-70">{count(t.id)}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2 text-[11px]">
          <button onClick={copy} disabled={!history.length} className="rounded border border-slate-700 bg-slate-800/60 px-2 py-1 font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40">{copied ? 'Copied ✓' : 'Copy log'}</button>
          <button onClick={onClear} disabled={!history.some((e) => e.origin !== 'cloud')} className="rounded border border-slate-700 bg-slate-800/60 px-2 py-1 font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40" title="Hides this session's entries; your saved account history is kept">Clear session</button>
          <span data-testid="circuit-sync-note" className="ml-auto text-slate-500">{synced ? 'saved to your account · all devices' : 'this device only — sign in to keep history'} · IST</span>
        </div>
        <div className="flex-1 overflow-auto px-3 py-3">
          {empty ? (
            <p className="p-4 text-center text-[12px] text-slate-400">{tab === 'near' ? 'No stock is within 1.5% of a circuit limit right now.' : 'No circuit hits yet. Hits on your watchlist and Focus Basket are logged here as they happen.'}</p>
          ) : (
            <ul className="space-y-2" data-testid="circuit-log-rows">
              {showNear && near.map((p) => (
                <li key={`near-${p.symbol}`} data-testid="circuit-card" data-kind="near" data-symbol={p.symbol} data-dir={p.dir} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="flex items-baseline gap-2">
                    <b className="text-[14px] text-white">{p.symbol}</b>
                    <span className="truncate text-[11px] text-slate-400">{nameOf(p.symbol)}</span>
                    <span className="num ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">NEAR {p.dir === 'upper' ? 'UC' : 'LC'} ±{p.band}%</span>
                  </div>
                  <div className="num mt-1 flex flex-wrap gap-x-4 text-[12px] text-slate-300">
                    <span>Price ₹{fmt(p.ltp)}</span>
                    <span>Limit ₹{fmt(p.limit)}</span>
                    <span>{p.proximityPct.toFixed(2)}% to go{p.inferred ? ' (inferred band)' : ''}</span>
                    <span className="text-slate-500">live now</span>
                  </div>
                  <Actions symbol={p.symbol} dir={p.dir} onAnalyze={onAnalyze} onClose={onClose} />
                </li>
              ))}
              {rows.map((e) => (
                <li key={e.key} data-testid="circuit-card" data-kind={e.dir === 'upper' ? 'uc' : 'lc'} data-symbol={e.symbol} data-dir={e.dir} data-origin={e.origin} className={`rounded-lg border p-3 ${e.dir === 'upper' ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5'}`}>
                  <div className="flex items-baseline gap-2">
                    <b className="text-[14px] text-white">{e.symbol}</b>
                    <span className="truncate text-[11px] text-slate-400">{nameOf(e.symbol)}</span>
                    <span className={`num ml-auto rounded px-1.5 py-0.5 text-[10px] font-bold ${e.dir === 'upper' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>{e.dir === 'upper' ? 'UPPER CIRCUIT' : 'LOWER CIRCUIT'} {e.dir === 'upper' ? '+' : '−'}{e.band}%{e.demo ? ' · DEMO' : ''}</span>
                  </div>
                  <div className="num mt-1 flex flex-wrap gap-x-4 text-[12px] text-slate-300">
                    <span>Price at trigger ₹{fmt(e.price)}</span>
                    {e.pct !== undefined && <span>{fmtPct(e.pct)}</span>}
                    <span className="text-slate-400">{dateTime(e.at)} IST</span>
                  </div>
                  <Actions symbol={e.symbol} dir={e.dir} onAnalyze={onAnalyze} onClose={onClose} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
