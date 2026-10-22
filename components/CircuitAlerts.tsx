'use client';

import type { CircuitDir } from '@/lib/circuit';
import type { CircuitEvent } from '@/hooks/useCircuitAlerts';
import { testChime } from '@/lib/audioAlerts';
import { fmt, fmtPct } from '@/lib/format';

/** Pulsing glow for a card / pill at a circuit limit — emerald for upper, crimson for lower. */
export const GLOW: Record<CircuitDir, string> = {
  upper: 'border-emerald-500 shadow-[0_0_25px_rgba(16,185,129,0.7)] animate-pulse',
  lower: 'border-red-500 shadow-[0_0_25px_rgba(239,68,68,0.7)] animate-pulse',
};
const TONE: Record<CircuitDir, { text: string; badge: string; bar: string }> = {
  upper: { text: 'text-emerald-400', badge: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40', bar: 'bg-emerald-500' },
  lower: { text: 'text-rose-400', badge: 'bg-rose-500/15 text-rose-300 ring-rose-500/40', bar: 'bg-rose-500' },
};

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
  return <Bar {...props} />;
}
