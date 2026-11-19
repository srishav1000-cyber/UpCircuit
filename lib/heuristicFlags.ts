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
import { weightedObi } from './depthImbalance';

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
  /** Week 11: present when the multi-signal confirmation was evaluated for this flag (see confirmFlag) */
  confirmation?: Confirmation;
}

/* ───────────── Week 11: multi-signal confirmation ─────────────
 * A single-rule flag ("baseline") is only a pattern in resting orders. `confirmed_composite` additionally requires ≥ MIN_SIGNALS of three
 * independent readings, all computed from data available AT the flag's time (no look-ahead):
 *   obi     |OBI_λ| ≥ OBI_MIN       exponentially weighted top-5 order-book imbalance, w_i = e^(−λ(i−1))   (lib/depthImbalance.ts)
 *   volume  R(t) ≥ SURGE_MIN        traded volume over the last 15 min ÷ what the intraday profile expects for the same 15 min (lib/volumeBaseline.ts)
 *   spread  spread ≥ SPREAD_MULT × the symbol's rolling median spread (previous SPREAD_WINDOW snapshots, ≥ SPREAD_MIN_SAMPLES of them)
 * A reading that cannot be computed (no volume baseline, too little spread history) is N/A and simply cannot confirm. Confirmation raises
 * the evidence for "unusual", not for "manipulative": it is still a heuristic and never proof.
 */
export type FlagMode = 'baseline' | 'confirmed_composite';
export type ConfirmSignal = 'obi' | 'volume' | 'spread';
export const CONFIRM_PARAMS = { LAMBDA: 0.5, OBI_MIN: 0.35, SURGE_MIN: 1.8, SPREAD_MULT: 1.5, MIN_SIGNALS: 2, SPREAD_WINDOW: 120, SPREAD_MIN_SAMPLES: 30 } as const;
export type ConfirmParams = { [K in keyof typeof CONFIRM_PARAMS]: number };
export interface ConfirmSignals { obi: number | null; volRatio: number | null; spreadRatio: number | null }
export interface Confirmation extends ConfirmSignals { hits: ConfirmSignal[]; confirmed: boolean; params: { lambda: number; obiMin: number; surgeMin: number; spreadMult: number; minSignals: number } }
export const FLAG_TAG = { baseline: 'Baseline Flag', confirmed_composite: 'Multi-Signal Confirmed' } as const;
/** the tag the UI shows for a flag */
export const flagTag = (f: { confirmation?: Pick<Confirmation, 'confirmed'> | null }): (typeof FLAG_TAG)[FlagMode] => (f.confirmation?.confirmed ? FLAG_TAG.confirmed_composite : FLAG_TAG.baseline);

/** level weights for decay λ: w_i = exp(−λ·(i−1)), i = 1 (best price) … 5 */
export const levelWeights = (lambda: number, n = 5): number[] => Array.from({ length: n }, (_, i) => Math.exp(-lambda * i));
/** exponentially weighted top-5 OBI of a raw book snapshot (null when the book is empty) */
export function obiOfBook(bids: readonly DepthLevel[], asks: readonly DepthLevel[], lambda: number): number | null {
  const q = (a: readonly DepthLevel[], side: 'bid' | 'ask') => a.filter((l) => l && l.price > 0 && l.qty > 0).sort((x, y) => (side === 'bid' ? y.price - x.price : x.price - y.price)).slice(0, 5).map((l) => l.qty);
  return weightedObi(q(bids, 'bid'), q(asks, 'ask'), levelWeights(lambda));
}
/** best ask − best bid of a snapshot; null when either side is empty or the book is crossed */
export function topSpread(bids: readonly DepthLevel[], asks: readonly DepthLevel[]): number | null {
  let bb = 0, ba = Infinity;
  for (const l of bids) if (l && l.qty > 0 && l.price > bb) bb = l.price;
  for (const l of asks) if (l && l.qty > 0 && l.price < ba) ba = l.price;
  return bb > 0 && Number.isFinite(ba) && ba > bb ? ba - bb : null;
}

/** pure: which of the three readings corroborate a candidate flag */
export function confirmFlag(sig: ConfirmSignals, over: Partial<ConfirmParams> = {}): Confirmation {
  const p = { ...CONFIRM_PARAMS, ...over };
  const hits: ConfirmSignal[] = [];
  if (sig.obi !== null && Number.isFinite(sig.obi) && Math.abs(sig.obi) >= p.OBI_MIN) hits.push('obi');
  if (sig.volRatio !== null && Number.isFinite(sig.volRatio) && sig.volRatio >= p.SURGE_MIN) hits.push('volume');
  if (sig.spreadRatio !== null && Number.isFinite(sig.spreadRatio) && sig.spreadRatio >= p.SPREAD_MULT) hits.push('spread');
  return { ...sig, hits, confirmed: hits.length >= p.MIN_SIGNALS, params: { lambda: p.LAMBDA, obiMin: p.OBI_MIN, surgeMin: p.SURGE_MIN, spreadMult: p.SPREAD_MULT, minSignals: p.MIN_SIGNALS } };
}

/** rebuild a Confirmation from the stored list of corroborating signals (depth_flags.confirmed_by); the readings themselves are not stored */
export function confirmationFromHits(hits: readonly string[] | null | undefined, over: Partial<ConfirmParams> = {}): Confirmation | undefined {
  if (!Array.isArray(hits)) return undefined;
  const p = { ...CONFIRM_PARAMS, ...over };
  const h = hits.filter((x): x is ConfirmSignal => x === 'obi' || x === 'volume' || x === 'spread');
  return { obi: null, volRatio: null, spreadRatio: null, hits: h, confirmed: h.length >= p.MIN_SIGNALS, params: { lambda: p.LAMBDA, obiMin: p.OBI_MIN, surgeMin: p.SURGE_MIN, spreadMult: p.SPREAD_MULT, minSignals: p.MIN_SIGNALS } };
}

/** the repeat-suppression rule shared by DepthFlagTracker.observe and the offline backtest: the same flag (symbol|kind|side|price) is not re-emitted within COOLDOWN_MS */
export interface Cooldown { (f: DepthFlag, ts: number): boolean; prune(nowMs: number): void; clear(symbol?: string): void }
export function makeCooldown(cooldownMs: number = FLAG_PARAMS.COOLDOWN_MS): Cooldown {
  const last = new Map<string, number>();
  const gate = ((f: DepthFlag, ts: number): boolean => {
    const k = f.key + (f.price ?? '');
    const prev = last.get(k);
    if (prev !== undefined && ts - prev < cooldownMs) return false;
    last.set(k, ts);
    return true;
  }) as Cooldown;
  gate.prune = (now) => { for (const [k, t] of last) if (now - t >= cooldownMs) last.delete(k); };
  gate.clear = (symbol) => { if (!symbol) last.clear(); else for (const k of [...last.keys()]) if (k.startsWith(symbol.toUpperCase() + '|')) last.delete(k); };
  return gate;
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
export function detectWalls(symbol: string, bids: readonly DepthLevel[], asks: readonly DepthLevel[], ts: number, wallMult: number = P.WALL_MULT): DepthFlag[] {
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
      if (l.qty >= P.WALL_MIN_QTY && mult >= wallMult && share >= P.WALL_MIN_SHARE && (!best || l.qty > best.l.qty)) best = { l, mult, share };
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
interface SymState { bid: SideState; ask: SideState; seen: number; spreads: number[] }
const newSide = (): SideState => ({ prev: null, prevWorst: null, prevCount: 0, adds: new Map(), cycles: [] });

/** Stateful detector: feed it every depth snapshot of a symbol (in time order). Returns the flags that are NEW on this snapshot. */
export interface TrackerOptions {
  /** 'baseline' (default, Week 10 behaviour) or 'confirmed_composite' (only flags corroborated by ≥ MIN_SIGNALS readings are emitted) */
  mode?: FlagMode;
  /** attach a `confirmation` to every emitted flag even in baseline mode (so the UI can tag it) */
  evaluate?: boolean;
  confirm?: Partial<ConfirmParams>;
  /** wall detection multiple (default FLAG_PARAMS.WALL_MULT) */
  wallMult?: number;
}
export interface ObserveContext {
  /** R(t): last-15-min traded volume ÷ expected for the same 15 min; null / undefined = N/A */
  volRatio?: number | null;
}

export class DepthFlagTracker {
  private readonly syms = new Map<string, SymState>();
  private readonly cooldown = makeCooldown();
  readonly mode: FlagMode;
  private readonly evaluate: boolean;
  private readonly cp: ConfirmParams;
  private readonly wallMult: number;
  constructor(opts: TrackerOptions = {}) {
    this.mode = opts.mode ?? 'baseline';
    this.evaluate = !!opts.evaluate || this.mode === 'confirmed_composite';
    this.cp = { ...CONFIRM_PARAMS, ...(opts.confirm ?? {}) };
    this.wallMult = opts.wallMult ?? P.WALL_MULT;
  }

  /** @param ltp last traded price (decides fill vs cancel); @param ts observation time, epoch ms */
  observe(symbol: string, depth: { bids: readonly DepthLevel[]; asks: readonly DepthLevel[] }, ltp: number, ts: number, ctx: ObserveContext = {}): DepthFlag[] {
    const { flags, spreadRatio } = this.candidates(symbol, depth, ltp, ts);
    const out: DepthFlag[] = [];
    for (const f of flags) {
      let flag = f;
      if (this.evaluate) {
        const c = confirmFlag({ obi: obiOfBook(depth.bids, depth.asks, this.cp.LAMBDA), volRatio: ctx.volRatio ?? null, spreadRatio }, this.cp);
        flag = { ...f, confirmation: c };
        if (this.mode === 'confirmed_composite' && !c.confirmed) continue;       // unconfirmed candidates are dropped BEFORE the cooldown, so they never mute a later confirmed one
      }
      if (this.cooldown(flag, ts)) out.push(flag);
    }
    return out;
  }

  /** Every pattern candidate on this snapshot (no cooldown, no confirmation) plus the current spread ÷ rolling-median spread. State (cycles, spread history) is updated exactly once per snapshot. */
  candidates(symbol: string, depth: { bids: readonly DepthLevel[]; asks: readonly DepthLevel[] }, ltp: number, ts: number): { flags: DepthFlag[]; spreadRatio: number | null } {
    const sym = symbol.toUpperCase();
    let st = this.syms.get(sym);
    if (!st) this.syms.set(sym, (st = { bid: newSide(), ask: newSide(), seen: ts, spreads: [] }));
    st.seen = ts;
    // spread ratio against the PREVIOUS samples only (no look-ahead), then record this one
    const sp = topSpread(depth.bids, depth.asks);
    let spreadRatio: number | null = null;
    if (sp !== null) {
      if (st.spreads.length >= this.cp.SPREAD_MIN_SAMPLES) { const m = median(st.spreads); if (m > 0) spreadRatio = sp / m; }
      st.spreads.push(sp); if (st.spreads.length > this.cp.SPREAD_WINDOW) st.spreads.shift();
    }
    const out: DepthFlag[] = detectWalls(sym, depth.bids, depth.asks, ts, this.wallMult);
    for (const side of ['bid', 'ask'] as const) {
      const f = this.side(sym, side, st[side], clean(side === 'bid' ? depth.bids : depth.asks, side), ltp, ts);
      if (f) out.push(f);
    }
    return { flags: out, spreadRatio };
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
    this.cooldown.prune(now);
    return n;
  }
  get size(): number { return this.syms.size; }
  reset(symbol?: string): void { if (symbol) this.syms.delete(symbol.toUpperCase()); else this.syms.clear(); this.cooldown.clear(symbol); }
}
