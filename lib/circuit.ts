// Circuit-limit detection on REAL prices. Yahoo carries no per-stock price band, so unless SmartAPI supplied the exchange limits,
// a stock counts as "at circuit" when its LTP sits on the 5 %, 10 % or 20 % limit of its previous close (tick-rounded) — the bands NSE uses.
const TICK = 0.05;
const roundTick = (p: number) => Math.round(p / TICK) * TICK;

export const CIRCUIT_BANDS = [5, 10, 20] as const;
export type CircuitDir = 'upper' | 'lower';

export interface CircuitQuote {
  symbol: string;
  ltp: number;
  prevClose: number;
  upperCircuit?: number;
  lowerCircuit?: number;
  circuitBand?: number;
  /** true when upper/lower came from the exchange (SmartAPI) rather than being inferred */
  bandKnown?: boolean;
}

export interface CircuitHit {
  symbol: string;
  dir: CircuitDir;
  /** 5 | 10 | 20 (%) */
  band: number;
  ltp: number;
  /** the limit price that was reached */
  limit: number;
  pct: number;
  /** the band came from the exchange rather than being inferred from the price */
  exact: boolean;
}

export const limitPrice = (prevClose: number, band: number, dir: CircuitDir) => roundTick(prevClose * (1 + (dir === 'upper' ? band : -band) / 100));

/** The circuit the quote is currently sitting on, or null. */
export function circuitHit(q: CircuitQuote): CircuitHit | null {
  if (!(q.ltp > 0) || !(q.prevClose > 0)) return null;
  const pct = (q.ltp / q.prevClose - 1) * 100;
  if (q.bandKnown && q.upperCircuit && q.lowerCircuit) {
    const band = q.circuitBand ?? Math.round(Math.abs(((q.upperCircuit / q.prevClose) - 1) * 100));
    if (q.ltp >= q.upperCircuit - TICK / 2) return { symbol: q.symbol, dir: 'upper', band, ltp: q.ltp, limit: q.upperCircuit, pct, exact: true };
    if (q.ltp <= q.lowerCircuit + TICK / 2) return { symbol: q.symbol, dir: 'lower', band, ltp: q.ltp, limit: q.lowerCircuit, pct, exact: true };
    return null;
  }
  const dir: CircuitDir = pct >= 0 ? 'upper' : 'lower';
  for (const band of CIRCUIT_BANDS) {
    const limit = limitPrice(q.prevClose, band, dir);
    if (Math.abs(q.ltp - limit) <= TICK / 2 + 1e-9) return { symbol: q.symbol, dir, band, ltp: q.ltp, limit, pct, exact: false };
  }
  return null;
}

/** "Near circuit": within `within` % points of the nearest 5/10/20 % limit on the side it is moving (and not yet at it). */
export function nearCircuit(q: CircuitQuote, within = 0.5): { dir: CircuitDir; band: number; gapPct: number } | null {
  if (!(q.ltp > 0) || !(q.prevClose > 0) || circuitHit(q)) return null;
  const pct = (q.ltp / q.prevClose - 1) * 100;
  const dir: CircuitDir = pct >= 0 ? 'upper' : 'lower';
  const bands = q.bandKnown && q.circuitBand ? [q.circuitBand] : [...CIRCUIT_BANDS];
  let best: { dir: CircuitDir; band: number; gapPct: number } | null = null;
  for (const band of bands) {
    const gap = band - Math.abs(pct);
    if (gap > 0 && gap <= within && (!best || gap < best.gapPct)) best = { dir, band, gapPct: gap };
  }
  return best;
}

/** Edge-triggered tracker: a hit is confirmed once (inferred bands need a second observation ≥ confirmMs later, which filters a price merely passing a limit). */
export class CircuitTracker {
  private first = new Map<string, number>();
  private fired = new Set<string>();
  constructor(private confirmMs = 8000) {}

  /** Feed one observation; returns the hit exactly once per episode, when it is confirmed. */
  observe(q: CircuitQuote, now: number): CircuitHit | null {
    const hit = circuitHit(q);
    const s = q.symbol;
    if (!hit) {
      this.first.delete(s);
      this.fired.forEach((k) => k.startsWith(s + ':') && this.fired.delete(k));
      return null;
    }
    const key = `${s}:${hit.dir}:${hit.band}`;
    if (this.fired.has(key)) return null;
    if (!hit.exact) {
      const t0 = this.first.get(key);
      if (t0 === undefined) {
        this.first.set(key, now);
        return null;
      }
      if (now - t0 < this.confirmMs) return null;
    }
    this.fired.add(key);
    return hit;
  }
  /** symbols currently confirmed at a circuit (drive the glow) */
  active(): string[] {
    return Array.from(this.fired).map((k) => k.split(':')[0]);
  }
}
