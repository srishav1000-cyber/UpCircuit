// Heuristic flags on top-5 order depth: large resting-order WALLS and rapid ADD / CANCEL ("flicker") patterns.
//
// These are screening heuristics over a 5-level snapshot stream, NOT evidence of manipulation or intent. Large orders and fast cancels
// are also produced by iceberg execution, market makers re-quoting, and ordinary risk management. Every flag therefore carries
//   label: 'Heuristic Flag / Possible Manipulation Pattern', heuristic: true, definitive: false
// and the UI must show that label next to it. Pure and I/O-free: used by the daemon (daemon/engine.ts) and by the browser (SurveillanceWorkspace).
//
// What can and cannot be seen: only the best 5 levels per side. A level that leaves the visible 5 may simply have been pushed down the book
// by better-priced orders, and a new level may simply have been revealed by one leaving — the tracker ignores both, and ignores a vanished
// order when the last trade was at or through its price (that is a fill, not a cancel).
import type { DepthLevel } from './types';

export const FLAG_LABEL = 'Heuristic Flag / Possible Manipulation Pattern' as const;
export const FLAG_DISCLAIMER = 'A pattern in resting orders only. It is not proof of manipulation or of anyone\'s intent — icebergs, market-maker re-quoting and normal risk management look similar.';

export type FlagKind = 'wall' | 'add_cancel';
export type FlagSide = 'bid' | 'ask';
export type FlagSeverity = 'watch' | 'elevated';

export interface DepthFlag {
  key: string;
  symbol: string;
  kind: FlagKind;
  side: FlagSide;
  severity: FlagSeverity;
  /** wall: the wall's price; add_cancel: null */
  price: number | null;
  /** wall: the wall's quantity; add_cancel: number of add→cancel cycles */
  qty: number | null;
  detail: string;
  /** exchange / observation time, epoch ms */
  ts: number;
  label: typeof FLAG_LABEL;
  heuristic: true;
  definitive: false;
}

export const FLAG_PARAMS = {
  TOP_N: 5,
  /** wall: needs at least this many levels on the side to compare against */
  WALL_MIN_LEVELS: 3,
  /** wall: absolute floor (shares) — a "wall" of 50 shares is noise */
  WALL_MIN_QTY: 1000,
  /** wall: level qty ≥ this × median of the OTHER levels on that side … */
  WALL_MULT: 4,
  /** … and ≥ this share of the side's top-5 total */
  WALL_MIN_SHARE: 0.45,
  /** elevated when ≥ this × median and ≥ this share */
  WALL_MULT_HIGH: 8,
  WALL_SHARE_HIGH: 0.6,
  /** add/cancel: an order counts when ≥ this many shares … */
  LEVEL_MIN_QTY: 500,
  /** … and ≥ this share of its side's top-5 total */
  LEVEL_MIN_SHARE: 0.2,
  /** a cancel ≥ this fraction of the level's size counts as gone */
  GONE_FRACTION: 0.8,
  /** appeared and vanished within this window = one cycle */
  FLICKER_MS: 5_000,
  /** cycles are counted over this window */
  WINDOW_MS: 30_000,
  /** cycles within the window: watch / elevated */
  CYCLES_WATCH: 3,
  CYCLES_HIGH: 5,
  /** the same flag is not re-emitted sooner than this */
  COOLDOWN_MS: 60_000,
  /** idle symbols are forgotten after this */
  IDLE_MS: 10 * 60_000,
} as const;

const P = FLAG_PARAMS;
const clean = (a: readonly DepthLevel[] | undefined, side: FlagSide): DepthLevel[] =>
  (a ?? [])
    .filter((l) => l && Number.isFinite(l.price) && Number.isFinite(l.qty) && l.price > 0 && l.qty > 0)
    .sort((x, y) => (side === 'bid' ? y.price - x.price : x.price - y.price))
    .slice(0, P.TOP_N);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (n: number) => n.toLocaleString('en-IN');
const mk = (symbol: string, kind: FlagKind, side: FlagSide, severity: FlagSeverity, price: number | null, qty: number | null, detail: string, ts: number): DepthFlag =>
  ({ key: `${symbol}|${kind}|${side}`, symbol, kind, side, severity, price, qty, detail, ts, label: FLAG_LABEL, heuristic: true, definitive: false });

/** Large resting-order walls in a single snapshot (stateless). At most one per side — the largest qualifying level. */
export function detectWalls(symbol: string, bids: readonly DepthLevel[], asks: readonly DepthLevel[], ts: number): DepthFlag[] {
  const out: DepthFlag[] = [];
  for (const side of ['bid', 'ask'] as const) {
    const lv = clean(side === 'bid' ? bids : asks, side);
    if (lv.length < P.WALL_MIN_LEVELS) continue;
    const total = lv.reduce((s, l) => s + l.qty, 0);
    let best: { l: DepthLevel; mult: number; share: number } | null = null;
    for (const l of lv) {
      const others = lv.filter((x) => x !== l).map((x) => x.qty);
      const med = median(others);
      if (!(med > 0)) continue;
      const mult = l.qty / med, share = l.qty / total;
      if (l.qty >= P.WALL_MIN_QTY && mult >= P.WALL_MULT && share >= P.WALL_MIN_SHARE && (!best || l.qty > best.l.qty)) best = { l, mult, share };
    }
    if (best) {
      const high = best.mult >= P.WALL_MULT_HIGH && best.share >= P.WALL_SHARE_HIGH;
      out.push(mk(symbol, 'wall', side, high ? 'elevated' : 'watch', best.l.price, best.l.qty,
        `${side === 'bid' ? 'Bid' : 'Ask'} wall: ${fmt(best.l.qty)} @ ${best.l.price} is ${best.mult.toFixed(1)}× the median of the other levels and ${(best.share * 100).toFixed(0)}% of the side's top-5 quantity.`, ts));
    }
  }
  return out;
}

interface SideState {
  prev: Map<number, number> | null;
  prevWorst: number | null;
  prevCount: number;
  /** price → when a large order appeared there */
  adds: Map<number, { at: number; qty: number }>;
  /** timestamps of completed add→cancel cycles */
  cycles: number[];
}
interface SymState { bid: SideState; ask: SideState; seen: number; lastEmit: Map<string, number> }
const newSide = (): SideState => ({ prev: null, prevWorst: null, prevCount: 0, adds: new Map(), cycles: [] });

/** Stateful detector: feed it every depth snapshot of a symbol (in time order). Returns the flags that are NEW on this snapshot. */
export class DepthFlagTracker {
  private readonly syms = new Map<string, SymState>();

  /** @param ltp last traded price (decides fill vs cancel); @param ts observation time, epoch ms */
  observe(symbol: string, depth: { bids: readonly DepthLevel[]; asks: readonly DepthLevel[] }, ltp: number, ts: number): DepthFlag[] {
    const sym = symbol.toUpperCase();
    let st = this.syms.get(sym);
    if (!st) this.syms.set(sym, (st = { bid: newSide(), ask: newSide(), seen: ts, lastEmit: new Map() }));
    st.seen = ts;
    const out: DepthFlag[] = [];
    const emit = (f: DepthFlag) => {
      const last = st!.lastEmit.get(f.key + (f.price ?? ''));
      if (last !== undefined && ts - last < P.COOLDOWN_MS) return;
      st!.lastEmit.set(f.key + (f.price ?? ''), ts);
      out.push(f);
    };
    for (const w of detectWalls(sym, depth.bids, depth.asks, ts)) emit(w);
    for (const side of ['bid', 'ask'] as const) {
      const f = this.side(sym, side, st[side], clean(side === 'bid' ? depth.bids : depth.asks, side), ltp, ts);
      if (f) emit(f);
    }
    return out;
  }

  private side(sym: string, side: FlagSide, s: SideState, lv: DepthLevel[], ltp: number, ts: number): DepthFlag | null {
    const cur = new Map(lv.map((l) => [l.price, l.qty]));
    const total = lv.reduce((a, l) => a + l.qty, 0);
    const worst = lv.length ? lv[lv.length - 1].price : null;
    const beyond = (p: number, edge: number) => (side === 'bid' ? p < edge : p > edge);       // p lies deeper in the book than `edge`
    const bigEnough = (q: number, tot: number) => q >= P.LEVEL_MIN_QTY && q >= P.LEVEL_MIN_SHARE * tot;

    if (s.prev && lv.length >= P.WALL_MIN_LEVELS) {
      const prevTotal = [...s.prev.values()].reduce((a, q) => a + q, 0);
      // cancels: a previously seen large order is (almost) gone, was not displaced out of the visible 5, and the market did not trade through it
      for (const [p, q] of s.prev) {
        if (!bigEnough(q, prevTotal)) continue;
        const now = cur.get(p) ?? 0;
        if (now > q * (1 - P.GONE_FRACTION)) continue;
        const displaced = lv.length >= P.TOP_N && worst !== null && beyond(p, worst);
        const filled = ltp > 0 && (side === 'bid' ? ltp <= p : ltp >= p);
        if (displaced || filled) { s.adds.delete(p); continue; }
        const add = s.adds.get(p);
        if (add && ts - add.at <= P.FLICKER_MS) s.cycles.push(ts);
        s.adds.delete(p);
      }
      // adds: a large order appears at a price that was not just revealed by another level leaving the visible 5
      for (const [p, q] of cur) {
        const was = s.prev.get(p) ?? 0;
        if (q < was * 2 + P.LEVEL_MIN_QTY || !bigEnough(q, total)) continue;
        const revealed = s.prevCount >= P.TOP_N && s.prevWorst !== null && beyond(p, s.prevWorst);
        if (!revealed) s.adds.set(p, { at: ts, qty: q });
      }
    }
    for (const [p, a] of s.adds) if (ts - a.at > P.FLICKER_MS) s.adds.delete(p);
    s.cycles = s.cycles.filter((t) => ts - t <= P.WINDOW_MS);
    s.prev = cur; s.prevWorst = worst; s.prevCount = lv.length;

    const n = s.cycles.length;
    if (n < P.CYCLES_WATCH) return null;
    return mk(sym, 'add_cancel', side, n >= P.CYCLES_HIGH ? 'elevated' : 'watch', null, n,
      `${n} large ${side} orders (≥ ${fmt(P.LEVEL_MIN_QTY)} shares and ≥ ${P.LEVEL_MIN_SHARE * 100}% of the side) appeared and vanished within ${P.FLICKER_MS / 1000} s in the last ${P.WINDOW_MS / 1000} s, without the market trading through them.`, ts);
  }

  /** drop symbols not seen for IDLE_MS */
  prune(now: number): number {
    let n = 0;
    for (const [k, v] of this.syms) if (now - v.seen > P.IDLE_MS) { this.syms.delete(k); n++; }
    return n;
  }
  get size(): number { return this.syms.size; }
  reset(symbol?: string): void { if (symbol) this.syms.delete(symbol.toUpperCase()); else this.syms.clear(); }
}
