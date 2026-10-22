'use client';

import { useEffect, useRef, useState } from 'react';
import type { CircuitDir } from '@/lib/circuit';
import type { CircuitEvent } from '@/hooks/useCircuitAlerts';
import { fmt, fmtInt, fmtPct } from '@/lib/format';
import { playChime } from '@/lib/audioAlerts';

/** minimum time (ms) each alert stays on screen before it auto-advances */
export const OVERLAY_MS = 3000;

export const OVERLAY_TEXT = {
  lower: { banner: '▼ LOWER CIRCUIT HALT DETECTED', note: 'BEAR MARKET FREEZE • SELLERS ONLY • EXECUTION PAUSED' },
  upper: { banner: '▲ UPPER CIRCUIT BREACH DETECTED', note: 'BULL MARKET BREAKOUT • BUYERS ONLY • CIRCUIT LOCK ACTIVE' },
} as const;

/** "−5%" / "+10%" */
export const bandLabel = (dir: CircuitDir, band: number) => `${dir === 'upper' ? '+' : '−'}${band}%`;

const FRAME: Record<CircuitDir, string> = {
  lower: 'bg-red-950/90 backdrop-blur-2xl border-2 border-red-500/80 shadow-[0_0_120px_rgba(239,68,68,0.7)]',
  upper: 'bg-emerald-950/90 backdrop-blur-2xl border-2 border-emerald-500/80 shadow-[0_0_120px_rgba(16,185,129,0.7)]',
};

/** perspective floor grid: converging depth lines + horizontal rows that bunch toward the horizon */
function Grid({ color, ceiling = false }: { color: string; ceiling?: boolean }) {
  const y0 = ceiling ? 18 : 142; // near edge
  const yh = ceiling ? 70 : 90; // horizon
  const lines: JSX.Element[] = [];
  for (let i = -6; i <= 6; i++) lines.push(<line key={'v' + i} x1={160 + i * 8} y1={yh} x2={160 + i * 40} y2={y0} />);
  for (let i = 0; i <= 6; i++) {
    const t = Math.pow(i / 6, 1.7);
    const y = yh + (y0 - yh) * t;
    const half = 48 + (240 - 48) * t;
    lines.push(<line key={'h' + i} x1={160 - half} y1={y} x2={160 + half} y2={y} opacity={0.35 + 0.65 * t} />);
  }
  return <g stroke={color} strokeWidth="0.8" opacity="0.55">{lines}</g>;
}

/** Roaring bear in side profile (geometric silhouette): shoulder hump, open jaw with teeth, glowing eye. Faces right. */
function Bear() {
  return (
    <g data-testid="bear" transform="translate(-4 4)">
      <path d="M30 120 L36 92 L58 80 L82 70 L100 60 L118 68 L136 64 L152 70 L172 80 L180 90 L162 92 L152 98 L170 104 L174 112 L152 114 L130 108 L120 124 L124 142 L104 142 L98 128 L78 126 L72 142 L50 142 L44 126 L30 124 Z" fill="#3b0a0a" stroke="#ef4444" strokeWidth="2" strokeLinejoin="round" />
      <path d="M126 62 L132 50 L142 62 Z" fill="#3b0a0a" stroke="#ef4444" strokeWidth="2" strokeLinejoin="round" />
      <path d="M160 92 L164 99 L168 92 Z M168 108 L172 101 L174 109 Z" fill="#fee2e2" />
      <path d="M52 84 L58 70 M70 78 L78 64 M88 70 L98 56" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <circle cx="146" cy="76" r="2.6" fill="#fca5a5" /><circle cx="146" cy="76" r="5" fill="#ef4444" opacity="0.35" />
    </g>
  );
}

/** Charging bull in side profile (geometric silhouette): towering shoulder hump, lowered head, two forward horns, glowing eye, snort. Faces right. */
function Bull() {
  return (
    <g data-testid="bull" transform="translate(-4 -4) rotate(-4 90 100)">
      <path d="M28 112 L38 92 L64 86 L88 64 L104 54 L122 64 L136 82 L148 90 L160 98 L172 110 L174 122 L156 126 L142 120 L128 116 L120 128 L126 142 L106 142 L100 132 L92 124 L76 122 L72 142 L52 142 L48 126 L34 128 Z" fill="#052e22" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
      <path d="M136 90 Q150 70 180 52 Q166 80 150 98 Z" fill="#d1fae5" stroke="#10b981" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M126 84 Q130 66 152 50 Q142 72 140 90 Z" fill="#6ee7b7" stroke="#10b981" strokeWidth="1.5" strokeLinejoin="round" opacity="0.9" />
      <path d="M118 80 L108 74 L120 90 Z" fill="#052e22" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
      <path d="M28 112 Q12 104 14 84 M14 84 L10 76 M14 84 L20 76" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" />
      <path d="M72 96 L82 80 M86 92 L96 76" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <path d="M176 116 L188 112 M176 120 L190 122" stroke="#a7f3d0" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" />
      <circle cx="154" cy="104" r="2.6" fill="#a7f3d0" /><circle cx="154" cy="104" r="5" fill="#10b981" opacity="0.35" />
    </g>
  );
}

/** red bear market crash: bear over a 3D grid plane, jagged arrow plummeting beside it */
export function CrashArt() {
  return (
    <svg viewBox="0 0 320 160" className="mx-auto h-44 w-full max-w-2xl drop-shadow-[0_0_20px_rgba(239,68,68,0.8)] sm:h-56" role="img" aria-label="Roaring bear over a crashing price trendline" data-testid="art-crash">
      <defs>
        <linearGradient id="crashGlow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fca5a5" /><stop offset="1" stopColor="#dc2626" /></linearGradient>
      </defs>
      <Grid color="#f87171" />
      <polygon points="40,142 280,142 250,96 70,96" fill="#7f1d1d" opacity="0.35" />
      <Bear />
      <path d="M176 18 L200 36 L212 28 L238 62 L250 54 L276 96 L286 90 L306 128" fill="none" stroke="url(#crashGlow)" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset="1">
        <animate attributeName="stroke-dashoffset" from="1" to="0" dur="0.9s" fill="freeze" />
      </path>
      <polygon points="292,122 314,138 296,150 298,138" fill="#ef4444" stroke="#fecaca" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** green bull market surge: bull bursting up through the ceiling grid, soaring arrow beside it */
export function SoarArt() {
  return (
    <svg viewBox="0 0 320 160" className="mx-auto h-44 w-full max-w-2xl drop-shadow-[0_0_20px_rgba(16,185,129,0.8)] sm:h-56" role="img" aria-label="Charging bull over a soaring price trendline" data-testid="art-soar">
      <defs>
        <linearGradient id="soarGlow" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#059669" /><stop offset="1" stopColor="#6ee7b7" /></linearGradient>
      </defs>
      <Grid color="#34d399" ceiling />
      <polygon points="70,64 250,64 280,18 40,18" fill="#065f46" opacity="0.35" />
      <Bull />
      <path d="M176 142 L200 124 L212 132 L238 98 L250 106 L276 64 L286 70 L306 30" fill="none" stroke="url(#soarGlow)" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset="1">
        <animate attributeName="stroke-dashoffset" from="1" to="0" dur="0.9s" fill="freeze" />
      </path>
      <polygon points="292,36 314,22 296,10 298,22" fill="#10b981" stroke="#a7f3d0" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Full-screen, high-priority alert for each newly confirmed circuit hit (queued if several arrive together).
 * Stays 3 s (OVERLAY_MS) then advances; ✕ / Esc / backdrop click dismisses at once. It is `fixed`, so it never shifts the layout.
 */
export function CircuitAlertOverlay({ log, audioOn = true }: { log: CircuitEvent[]; audioOn?: boolean }) {
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
  // the alarm is tied to the card on screen, so every queued alert gets its own sound (klaxon for lower, arpeggio for upper)
  useEffect(() => {
    if (head && audioOn) playChime(head.dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head]);
  useEffect(() => {
    if (!head) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && next();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [head]);
  if (!head) return null;
  const upper = head.dir === 'upper';
  const T = OVERLAY_TEXT[head.dir];
  const accent = upper ? 'text-emerald-300' : 'text-red-300';
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`${upper ? 'Upper' : 'Lower'} circuit: ${head.symbol}`}
      data-testid="circuit-overlay"
      data-dir={head.dir}
      data-symbol={head.symbol}
      data-band={head.band}
      onClick={next}
      className={`fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden p-4 ${FRAME[head.dir]}`}
    >
      <div aria-hidden className={`pointer-events-none absolute inset-0 animate-pulse ${upper ? 'bg-emerald-500/10' : 'bg-red-500/15'}`} />
      <div onClick={(e) => e.stopPropagation()} className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-3 text-center">
        <button onClick={next} aria-label="Dismiss circuit alert" data-testid="circuit-overlay-close" className="absolute -top-2 right-0 rounded-md border border-white/20 bg-black/30 px-3 py-1.5 text-xs font-semibold text-white hover:bg-black/50 sm:-right-4">✕ Dismiss</button>
        {head.demo && <div data-testid="circuit-overlay-demo" className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold tracking-widest text-amber-300 ring-1 ring-amber-500/40">DEMO SIMULATION — NOT MARKET DATA</div>}
        {upper ? <SoarArt /> : <CrashArt />}
        <h2 data-testid="circuit-overlay-banner" className={upper ? 'bg-gradient-to-r from-emerald-300 via-green-200 to-emerald-400 bg-clip-text text-2xl font-black tracking-wide text-transparent drop-shadow-[0_0_18px_rgba(52,211,153,0.7)] sm:text-3xl' : 'animate-pulse text-2xl font-black tracking-wide text-red-400 drop-shadow-[0_0_18px_rgba(239,68,68,0.8)] sm:text-3xl'}>{T.banner}</h2>
        <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1">
          <span data-testid="circuit-overlay-symbol" className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">{head.symbol}</span>
          {!upper && <span data-testid="circuit-overlay-exch" className="rounded border border-white/30 px-1.5 py-0.5 text-xs font-bold text-white/80">{head.exch}</span>}
          <span data-testid="circuit-overlay-pct" className={`num text-2xl font-bold ${accent}`}>{fmtPct(head.pct)}</span>
        </div>
        <dl className={`grid w-full gap-2 rounded-xl border border-white/15 bg-black/30 p-3 text-left ${upper ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'}`}>
          {[
            ['LTP', `₹${fmt(head.ltp)}`],
            [upper ? 'Band' : 'Circuit band', bandLabel(head.dir, head.band)],
            ['Volume', head.volume > 0 ? fmtInt(head.volume) : 'N/A'],
            ...(upper ? [] : [['Exchange', head.exch]]),
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] uppercase tracking-wide text-white/60">{k}</dt>
              <dd data-testid={`circuit-overlay-${k.toLowerCase().replace(/\s+/g, '-')}`} className="num text-base font-semibold text-white sm:text-lg">{v}</dd>
            </div>
          ))}
        </dl>
        <p data-testid="circuit-overlay-note" className={`text-sm font-semibold tracking-wide sm:text-base ${accent}`}>{T.note}</p>
        <p className="text-[11px] text-white/50">{head.exact ? 'Exchange circuit limit' : `${head.band}% limit`} ₹{fmt(head.limit)}{queue.length > 1 ? ` · +${queue.length - 1} more` : ''}</p>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/40">
        <div key={head.id} className={`h-full ${upper ? 'bg-emerald-400' : 'bg-red-400'}`} style={{ animation: `circuit-countdown ${OVERLAY_MS}ms linear forwards` }} />
      </div>
      <style>{`@keyframes circuit-countdown{from{width:100%}to{width:0}}`}</style>
    </div>
  );
}
