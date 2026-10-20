'use client';

import { useEffect, useRef, useState } from 'react';
import type { CircuitDir } from '@/lib/circuit';
import type { CircuitEvent } from '@/hooks/useCircuitAlerts';
import { testChime } from '@/lib/chime';
import { fmt, fmtPct } from '@/lib/format';

/** Pulsing glow for a card / pill at a circuit limit — emerald for upper, crimson for lower. */
export const GLOW: Record<CircuitDir, string> = {
  upper: 'border-emerald-500 shadow-[0_0_25px_rgba(16,185,129,0.7)] animate-pulse',
  lower: 'border-red-500 shadow-[0_0_25px_rgba(239,68,68,0.7)] animate-pulse',
};
/** the full-screen pop-up card */
const CARD: Record<CircuitDir, string> = {
  upper: 'border-emerald-500/60 shadow-[0_0_60px_rgba(16,185,129,0.5)]',
  lower: 'border-rose-500/60 shadow-[0_0_60px_rgba(239,68,68,0.5)]',
};
const TONE: Record<CircuitDir, { text: string; badge: string; bar: string }> = {
  upper: { text: 'text-emerald-400', badge: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40', bar: 'bg-emerald-500' },
  lower: { text: 'text-rose-400', badge: 'bg-rose-500/15 text-rose-300 ring-rose-500/40', bar: 'bg-rose-500' },
};
export const OVERLAY_MS = 3000;

const svg = { width: 44, height: 44, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
export const TrendingUp = ({ size = 44 }: { size?: number }) => (
  <svg {...svg} width={size} height={size}><path d="m22 7-8.5 8.5-5-5L2 17" /><path d="M16 7h6v6" /></svg>
);
export const TrendingDown = ({ size = 44 }: { size?: number }) => (
  <svg {...svg} width={size} height={size}><path d="m22 17-8.5-8.5-5 5L2 7" /><path d="M16 17h6v-6" /></svg>
);

export interface CircuitAudio {
  on: boolean;
  toggle: () => void;
  /** the browser still blocks sound until a click */
  locked: boolean;
  unlock: () => void;
}
interface Props {
  /** every confirmed hit this session, newest first */
  log: CircuitEvent[];
  /** symbols still sitting at a circuit */
  glow: Record<string, CircuitDir>;
  audio: CircuitAudio;
  onOpen: (symbol: string) => void;
  onOpenLog: () => void;
}

/** Phase 1 — 3-second full-screen glassmorphic pop-up for each newly confirmed circuit hit (queued if several arrive together). */
function Overlay({ log }: { log: CircuitEvent[] }) {
  const seen = useRef(0);
  const [queue, setQueue] = useState<CircuitEvent[]>([]);
  useEffect(() => {
    const fresh = log.filter((e) => e.id > seen.current);
    if (!fresh.length) return;
    seen.current = Math.max(...fresh.map((e) => e.id));
    setQueue((q) => [...q, ...fresh.reverse()]);
  }, [log]);
  const head = queue[0];
  const next = () => setQueue((q) => q.slice(1));
  useEffect(() => {
    if (!head) return;
    const t = setTimeout(() => setQueue((q) => q.slice(1)), OVERLAY_MS);
    return () => clearTimeout(t);
  }, [head]);
  useEffect(() => {
    if (!head) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && next();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [head]);
  if (!head) return null;
  const t = TONE[head.dir];
  const upper = head.dir === 'upper';
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`${upper ? 'Upper' : 'Lower'} circuit: ${head.symbol}`}
      data-testid="circuit-overlay"
      data-dir={head.dir}
      data-symbol={head.symbol}
      onClick={next}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-xl"
    >
      <div onClick={(e) => e.stopPropagation()} className={`relative w-full max-w-md overflow-hidden rounded-2xl border-2 bg-slate-900/90 p-6 text-center ${CARD[head.dir]}`}>
        <button onClick={next} aria-label="Close circuit alert" data-testid="circuit-overlay-close" className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white">✕</button>
        <div className={`mx-auto mb-2 flex justify-center ${t.text}`}>{upper ? <TrendingUp /> : <TrendingDown />}</div>
        <div className={`text-[12px] font-bold tracking-[0.2em] ${t.text}`}>{upper ? 'UPPER CIRCUIT' : 'LOWER CIRCUIT'}</div>
        {head.demo && <div data-testid="circuit-overlay-demo" className="mx-auto mt-1 inline-block rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold tracking-widest text-amber-300 ring-1 ring-amber-500/40">DEMO SIMULATION</div>}
        <div className="mt-1 text-4xl font-extrabold tracking-tight text-white">{head.symbol}</div>
        <div className={`mx-auto mt-3 inline-block rounded-full px-4 py-1 text-xl font-bold ring-1 ${t.badge}`} data-testid="circuit-overlay-pct">{fmtPct(head.pct)}</div>
        <dl className="mt-4 grid grid-cols-3 gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-left">
          {[['Price', `₹${fmt(head.ltp)}`], ['Change', fmtPct(head.pct)], ['Band', `${upper ? '+' : '−'}${head.band}%`]].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] uppercase tracking-wide text-slate-400">{k}</dt>
              <dd className="num text-[15px] font-semibold text-white">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-[11px] text-slate-400">{head.exact ? 'Exchange circuit limit' : `${head.band}% limit`} ₹{fmt(head.limit)}{queue.length > 1 ? ` · +${queue.length - 1} more` : ''}</p>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-slate-800">
          <div key={head.id} className={`h-full ${t.bar}`} style={{ animation: `circuit-countdown ${OVERLAY_MS}ms linear forwards` }} />
        </div>
      </div>
      <style>{`@keyframes circuit-countdown{from{width:100%}to{width:0}}`}</style>
    </div>
  );
}

/** Phase 2 — persistent bar under the navbar: one pill per stock that hit a circuit this session, plus audio controls. */
function Bar({ log, glow, audio, onOpen, onOpenLog }: Props) {
  const pills: CircuitEvent[] = [];
  const seen = new Set<string>();
  for (const e of log) if (!seen.has(e.symbol)) { seen.add(e.symbol); pills.push(e); } // newest per symbol
  if (!pills.length && !audio.locked) return null;
  const btn = 'rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-700';
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/90 px-3 py-1.5 backdrop-blur" role="region" aria-label="Circuit alerts" data-testid="circuit-alerts">
      {audio.locked && (
        <button onClick={audio.unlock} data-testid="audio-unlock" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/20">
          🔇 Click to Enable Live Audio Alerts
        </button>
      )}
      {pills.map((e) => (
        <button
          key={e.symbol}
          onClick={() => onOpen(e.symbol)}
          data-testid={`circuit-${e.dir}`}
          data-symbol={e.symbol}
          title={`${e.dir === 'upper' ? 'Upper' : 'Lower'} circuit · ${e.band}% band — open chart`}
          className={`flex items-center gap-1.5 rounded-full border-2 bg-slate-950/70 px-2.5 py-0.5 text-[12px] ${e.symbol in glow ? GLOW[e.dir] : e.dir === 'upper' ? 'border-emerald-500/50' : 'border-rose-500/50'}`}
        >
          <span aria-hidden className={TONE[e.dir].text}>{e.dir === 'upper' ? <TrendingUp size={13} /> : <TrendingDown size={13} />}</span>
          <b className="text-white">{e.symbol}</b>
          <span className={`num ${TONE[e.dir].text}`}>{fmtPct(e.pct)}</span>
          <span className="text-[10px] text-slate-400">{e.band}%{e.demo ? ' · DEMO' : ''}</span>
        </button>
      ))}
      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        <button onClick={() => void testChime('upper')} className={btn} data-testid="test-upper">Test Upper Chime</button>
        <button onClick={() => void testChime('lower')} className={btn} data-testid="test-lower">Test Lower Chime</button>
        <button onClick={onOpenLog} className={btn} data-testid="open-circuit-log">Log ({log.length})</button>
        <button onClick={audio.toggle} aria-pressed={audio.on} data-testid="bar-audio-toggle" className={`${btn} ${audio.on ? 'text-emerald-300' : 'text-slate-400'}`}>
          {audio.on ? '🔔 Audio ON' : '🔕 Audio OFF'}
        </button>
      </span>
    </div>
  );
}

export function CircuitAlerts(props: Props) {
  return (
    <>
      <Overlay log={props.log} />
      <Bar {...props} />
    </>
  );
}
