// ⚡ Demo Circuit Simulator — an explicit, user-triggered DEMO for evaluators when the market is closed.
// It is NOT market data: prices are a deterministic ease-in from the stock's last real price to a circuit limit (no RNG), they are shown
// with a "DEMO" tag, they are never persisted (market_ticks), never e-mailed, and the real quotes are restored when the demo ends.
import { limitPrice, type CircuitDir } from './circuit';

export const DEMO_SYMBOLS = ['RELIANCE', 'HFCL', 'PNB'];
export const DEMO_RAMP_MS = 10_000; // time to reach the limit
export const DEMO_HOLD_MS = 6_000; // time spent sitting on it (3 s overlay + margin)
export const DEMO_STEP_MS = 250;
export const DEMO_BANDS = [5, 10, 20] as const; // the three targets use different bands, so band escalation is visible too

export interface DemoQuote {
  symbol: string;
  ltp: number;
  prevClose: number;
}
export interface DemoTarget {
  symbol: string;
  dir: CircuitDir;
  band: number;
  start: number;
  /** the limit price being driven to */
  end: number;
  upper: number;
  lower: number;
}

/** Picks up to `max` targets: DEMO_SYMBOLS first (if priced), then `fallback` order. Directions alternate upper / lower / upper. */
export function planDemo(quotes: Map<string, DemoQuote> | ((s: string) => DemoQuote | undefined), fallback: string[] = [], max = 3): DemoTarget[] {
  const get = typeof quotes === 'function' ? quotes : (s: string) => quotes.get(s);
  const picked: DemoQuote[] = [];
  for (const s of [...DEMO_SYMBOLS, ...fallback]) {
    const q = get(s);
    if (q && q.ltp > 0 && q.prevClose > 0 && !picked.some((p) => p.symbol === q.symbol)) picked.push(q);
    if (picked.length >= max) break;
  }
  return picked.map((q, i) => {
    const band = DEMO_BANDS[i % DEMO_BANDS.length];
    const dir: CircuitDir = i % 2 === 0 ? 'upper' : 'lower';
    const upper = limitPrice(q.prevClose, band, 'upper');
    const lower = limitPrice(q.prevClose, band, 'lower');
    return { symbol: q.symbol, dir, band, start: q.ltp, end: dir === 'upper' ? upper : lower, upper, lower };
  });
}

/** Price `elapsedMs` into the demo: quadratic ease-in over DEMO_RAMP_MS, then pinned exactly on the limit. */
export function demoPrice(t: DemoTarget, elapsedMs: number): number {
  const p = Math.min(1, Math.max(0, elapsedMs / DEMO_RAMP_MS));
  return p >= 1 ? t.end : t.start + (t.end - t.start) * p * p;
}

export const demoDone = (elapsedMs: number): boolean => elapsedMs >= DEMO_RAMP_MS + DEMO_HOLD_MS;
