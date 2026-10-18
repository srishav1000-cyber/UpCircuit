// Chart drawing model + pure geometry helpers (no DOM, no chart-library imports → unit-testable).
// Anchors are stored in DATA space — (time, price) — so drawings survive zoom / pan / resize / live bars and timeframe switches.

export type Tool = 'cursor' | 'trend' | 'hline' | 'fib' | 'text' | 'ruler';

export interface Pt {
  /** IST-shifted seconds (same axis as the candles) */
  t: number;
  p: number;
}

export type Drawing =
  | { id: string; kind: 'trend' | 'fib' | 'ruler'; a: Pt; b: Pt }
  | { id: string; kind: 'hline'; a: Pt }
  | { id: string; kind: 'text'; a: Pt; text: string };

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const MAX_DRAWINGS = 60;

/** Fib retracement from `a` (start) to `b` (end): level 0 sits at the end, 1 at the start. */
export const fibPrice = (a: Pt, b: Pt, level: number) => b.p - (b.p - a.p) * level;

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Typical bar spacing in seconds (median of the last gaps) — used to extrapolate times beyond the data. */
export function barInterval(bars: Bar[], fallback = 60): number {
  if (bars.length < 2) return fallback;
  const gaps: number[] = [];
  for (let i = Math.max(1, bars.length - 20); i < bars.length; i++) gaps.push(bars[i].time - bars[i - 1].time);
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)] || fallback;
}

/** time → fractional logical index (bar number). Interpolates between bars, extrapolates past either end. */
export function timeToLogical(bars: Bar[], t: number, interval: number): number {
  const n = bars.length;
  if (n === 0) return 0;
  if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / interval;
  if (t <= bars[0].time) return (t - bars[0].time) / interval;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
}

/** inverse of timeToLogical */
export function logicalToTime(bars: Bar[], idx: number, interval: number): number {
  const n = bars.length;
  if (n === 0) return 0;
  if (idx >= n - 1) return bars[n - 1].time + (idx - (n - 1)) * interval;
  if (idx <= 0) return bars[0].time + idx * interval;
  const lo = Math.floor(idx);
  return bars[lo].time + (idx - lo) * (bars[lo + 1].time - bars[lo].time);
}

/** Magnet: snap to the nearest bar's time and to its nearest O / H / L / C price. */
export function snapToBar(bars: Bar[], pt: Pt, interval: number): Pt {
  if (bars.length === 0) return pt;
  const i = Math.min(bars.length - 1, Math.max(0, Math.round(timeToLogical(bars, pt.t, interval))));
  const b = bars[i];
  const p = [b.open, b.high, b.low, b.close].reduce((best, x) => (Math.abs(x - pt.p) < Math.abs(best - pt.p) ? x : best));
  return { t: b.time, p };
}

export interface RulerStats {
  dPrice: number;
  dPct: number;
  bars: number;
  seconds: number;
}
export function rulerStats(a: Pt, b: Pt, bars: Bar[], interval: number): RulerStats {
  return {
    dPrice: b.p - a.p,
    dPct: a.p ? ((b.p - a.p) / a.p) * 100 : 0,
    bars: Math.round(timeToLogical(bars, b.t, interval) - timeToLogical(bars, a.t, interval)),
    seconds: b.t - a.t,
  };
}

export function formatDuration(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1).replace(/\.0$/, '')}h`;
  return `${Math.round(s / 86400)}d`;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const pt = (x: unknown): Pt | null => {
  const o = x as Pt;
  return o && finite(o.t) && finite(o.p) ? { t: o.t, p: o.p } : null;
};

/** Validate + load persisted drawings (never trusts storage). */
export function parseDrawings(raw: string | null): Drawing[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: Drawing[] = [];
    for (const d of arr) {
      const id = typeof d?.id === 'string' ? d.id.slice(0, 24) : null;
      const a = pt(d?.a);
      if (!id || !a) continue;
      if (d.kind === 'hline') out.push({ id, kind: 'hline', a });
      else if (d.kind === 'text' && typeof d.text === 'string' && d.text.trim()) out.push({ id, kind: 'text', a, text: d.text.slice(0, 80) });
      else if (d.kind === 'trend' || d.kind === 'fib' || d.kind === 'ruler') {
        const b = pt(d.b);
        if (b) out.push({ id, kind: d.kind, a, b });
      }
    }
    return out.slice(0, MAX_DRAWINGS);
  } catch {
    return [];
  }
}

/** Shift a drawing by (Δlogical bars, Δprice) — used when dragging. */
export function moveDrawing(d: Drawing, dBars: number, dPrice: number, bars: Bar[], interval: number): Drawing {
  const mv = (q: Pt): Pt => ({ t: logicalToTime(bars, timeToLogical(bars, q.t, interval) + dBars, interval), p: q.p + dPrice });
  return 'b' in d ? { ...d, a: mv(d.a), b: mv(d.b) } : { ...d, a: mv(d.a) };
}
