// Backtest runner for the heuristic depth flags (lib/heuristicFlags.ts): replays top-5 depth sequences through DepthFlagTracker and reports
// how often it triggers and — when ground-truth labels exist — precision and recall.
//
//   npx tsx scripts/backtest-heuristics.ts                      # synthetic sessions (seeded), labels known
//   npx tsx scripts/backtest-heuristics.ts --input depth.jsonl  # recorded L2 sequence (labels optional)
//   options: --symbols 6 --days 4 --step-ms 500 --seed 1 --out docs/backtest-heuristics.json
//
// Recorded input, one JSON object per line, time-ordered per symbol:
//   {"t":1731300000000,"symbol":"ABC","ltp":101.5,"bids":[[101.45,2400],…],"asks":[[101.5,1900],…]}        // a depth snapshot
//   {"label":"spoof_wall"|"flicker"|"benign_fill_wall"|"benign_displacement","symbol":"ABC","side":"bid","from":ms,"to":ms}   // optional ground truth
//
// HONESTY NOTE. On synthetic data the labels come from the same generator that defines what a "pattern" looks like, so precision and recall
// here measure whether the detector's thresholds agree with that definition and how often ordinary noise trips it — they are NOT evidence about
// how often real markets contain manipulation, and they say nothing about intent. Without labels, precision is reported as N/A.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DepthFlagTracker, FLAG_PARAMS, CONFIRM_PARAMS, confirmFlag, makeCooldown, obiOfBook, type DepthFlag } from '../lib/heuristicFlags';
import { windowSurge, istDayOf, SURGE_WINDOW_MIN, BUCKETS, type IntradayProfile } from '../lib/volumeBaseline';
import type { DepthLevel } from '../lib/types';

/* ───────────────────────── types ───────────────────────── */
export type EpisodeClass = 'spoof_wall' | 'flicker' | 'benign_fill_wall' | 'benign_displacement';
export interface Episode { cls: EpisodeClass; symbol: string; side: 'bid' | 'ask'; from: number; to: number }
export interface Snapshot { t: number; symbol: string; ltp: number; bids: DepthLevel[]; asks: DepthLevel[]; /** cumulative traded volume of the session so far (synthetic runs; absent in recorded input without it) */ vol?: number }
export interface BacktestResult {
  config: Record<string, unknown>;
  data: { snapshots: number; symbols: number; labelled: boolean; episodes: Record<string, number> };
  flags: { total: number; byKind: Record<string, number>; bySeverity: Record<string, number>; per1000Snapshots: number };
  /** null = N/A (no labels) */
  precision: number | null;
  truePositives: number | null; falsePositives: number | null;
  falsePositiveCauses: Record<string, number> | null;
  recall: Record<string, { episodes: number; detected: number; rate: number | null; medianDelayMs: number | null }> | null;
  params: typeof FLAG_PARAMS;
  notes: string[];
  /** Week 11 (present when the sweep ran): both modes side by side, the threshold grid, sensitivity runs and the assumptions behind the volume signal */
  schemaVersion?: number;
  modes?: SweepResult['modes'];
  sweep?: Pick<SweepResult, 'axes' | 'fixed' | 'cells'>;
  sensitivity?: SweepResult['sensitivity'];
  assumptions?: SweepResult['assumptions'];
}

/* ───────────────────────── helpers ───────────────────────── */
function rng(seed: number): () => number { let s = seed >>> 0 || 1; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const median = (xs: number[]): number | null => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const POSITIVE: Record<EpisodeClass, boolean> = { spoof_wall: true, flicker: true, benign_fill_wall: false, benign_displacement: false };
const KIND_OF: Record<EpisodeClass, 'wall' | 'add_cancel'> = { spoof_wall: 'wall', flicker: 'add_cancel', benign_fill_wall: 'wall', benign_displacement: 'add_cancel' };
const GRACE_MS = FLAG_PARAMS.FLICKER_MS;       // a flag may land this long after an episode ends (an add/cancel needs the cancel to be seen)

/* ───────────────────────── synthetic generator ─────────────────────────
 * Sparse tick-grid book per symbol (the feed's "best five populated levels"): each price tick is populated with probability 0.6, quantities are
 * log-normal, drift slowly, and the mid price random-walks. Injected episodes (labelled):
 *   spoof_wall           one visible level on a side balloons to ~10× the typical level for 8–25 s, then vanishes; the market never trades near it
 *   flicker              3–6 times: an EMPTY tick inside the visible range gets a large order for 1–3 s, then it is cancelled
 *   benign_fill_wall     a ~10× level rests on the bid and the price then walks down THROUGH it — genuine liquidity that gets filled
 *   benign_displacement  better-priced orders arrive one tick at a time and push a large level out of the visible five
 * Everything else is background noise (re-quoting, drifting quantities, price moves) and any flag raised there is a false positive.
 */
export function synthesize(opts: { symbols: number; days: number; stepMs: number; seed: number; noise?: number }): { snaps: Snapshot[]; episodes: Episode[] } {
  const R = rng(opts.seed), N = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const logn = (mu: number, sd: number) => Math.exp(mu + sd * N());
  const noise = opts.noise ?? 0.45;                                              // log-normal sd of resting quantity per level — the main synthetic-noise assumption
  const TICK = 0.05, SESSION_MS = 6.25 * 3600_000, steps = Math.floor(SESSION_MS / opts.stepMs);
  const snaps: Snapshot[] = [], episodes: Episode[] = [];
  const dayStart = Date.UTC(2026, 10, 2, 3, 45);                                   // 09:15 IST

  for (let s = 0; s < opts.symbols; s++) {
    const symbol = `BT${String(s).padStart(2, '0')}`;
    for (let d = 0; d < opts.days; d++) {
      const t0 = dayStart + d * 86_400_000 + s * 7;                                  // symbols are independent; the offset only de-synchronises them
      let mid = 200 + R() * 1800;
      const qtyB = new Map<number, number>(), qtyA = new Map<number, number>(), onB = new Map<number, boolean>(), onA = new Map<number, boolean>();
      const q = (m: Map<number, number>, on: Map<number, boolean>, i: number): number => {
        if (!on.has(i)) { on.set(i, R() < 0.6); m.set(i, 2600 * logn(0, noise)); }
        return on.get(i) ? (m.get(i) as number) : 0;
      };
      type Ov = { side: 'bid' | 'ask'; idx: number; qty: number; from: number; to: number };
      const overrides: Ov[] = [];
      // schedule episodes at random, well separated times
      const plan: { cls: EpisodeClass; at: number }[] = [];
      const slots = 14, slotLen = Math.floor(steps / slots);
      const classes: EpisodeClass[] = ['spoof_wall', 'flicker', 'benign_fill_wall', 'benign_displacement'];
      for (let k = 0; k < slots; k++) if (R() < 0.7) plan.push({ cls: classes[Math.floor(R() * classes.length)], at: k * slotLen + Math.floor(R() * slotLen * 0.3) + 200 });
      const byStep = new Map(plan.map((p) => [p.at, p.cls]));
      let walk: { until: number; dir: number } | null = null;                       // scripted price move for the fill episode

      for (let i = 0; i < steps; i++) {
        const t = t0 + i * opts.stepMs;
        const cls = byStep.get(i);
        const bestBidIdx = () => Math.floor(mid / TICK + 1e-9);
        const idxOf = (side: 'bid' | 'ask', n: number): number => {                 // price index of the n-th (0-based) POPULATED level of a side
          let k = side === 'bid' ? bestBidIdx() : bestBidIdx() + 1, seen = -1;
          for (;;) { if ((side === 'bid' ? q(qtyB, onB, k) : q(qtyA, onA, k)) > 0) { seen++; if (seen === n) return k; } k += side === 'bid' ? -1 : 1; }
        };
        if (cls === 'spoof_wall') {
          const side = R() < 0.5 ? 'bid' : 'ask', lvl = 1 + Math.floor(R() * 3), dur = (8 + R() * 17) * 1000;
          const idx = idxOf(side, lvl);
          overrides.push({ side, idx, qty: 26_000 * logn(0, 0.2), from: t, to: t + dur });
          episodes.push({ cls, symbol, side, from: t, to: t + dur });
        } else if (cls === 'flicker') {
          const side = R() < 0.5 ? 'bid' : 'ask', cycles = 3 + Math.floor(R() * 4);
          let at = t;
          // an EMPTY tick strictly inside the visible book (between the best and the 4th populated level); if there is none, no episode is staged
          const a = idxOf(side, 0), z = idxOf(side, 3), lo = Math.min(a, z), hi = Math.max(a, z);
          let gap = -1;
          for (let k = lo + 1; k < hi; k++) if ((side === 'bid' ? q(qtyB, onB, k) : q(qtyA, onA, k)) === 0) { gap = k; break; }
          if (gap < 0) continue;
          for (let c = 0; c < cycles; c++) {
            const on = 1000 + R() * 2000, off = 1500 + R() * 2500;
            overrides.push({ side, idx: gap, qty: 9000 * logn(0, 0.15), from: at, to: at + on });
            at += on + off;
          }
          episodes.push({ cls, symbol, side, from: t, to: at });
        } else if (cls === 'benign_fill_wall') {
          const lvl = 1 + Math.floor(R() * 2), idx = idxOf('bid', lvl), dur = 14_000;
          overrides.push({ side: 'bid', idx, qty: 26_000 * logn(0, 0.2), from: t, to: t + dur });
          walk = { until: i + Math.ceil(dur / opts.stepMs), dir: -1 };
          episodes.push({ cls, symbol, side: 'bid', from: t, to: t + dur + GRACE_MS });
        } else if (cls === 'benign_displacement') {
          // a large (but wall-sized-below-threshold) order sits at the 5th visible bid; two better-priced bids then arrive 1 s apart and push it out of the visible five
          const deep = idxOf('bid', 4), top = idxOf('bid', 0);
          const empties: number[] = [];
          for (let k = top + 1; empties.length < 2 && k < top + 40; k++) if (q(qtyB, onB, k) === 0 && k * TICK < mid) empties.push(k);
          if (empties.length < 2) continue;
          const end = t + 12_000;
          overrides.push({ side: 'bid', idx: deep, qty: 9000, from: t, to: end });
          empties.forEach((k, n) => overrides.push({ side: 'bid', idx: k, qty: 2600, from: t + 3000 + n * 1000, to: end }));
          episodes.push({ cls, symbol, side: 'bid', from: t, to: end + GRACE_MS });
        }

        // price: random walk, plus the scripted walk-through for the fill episode
        if (walk && i < walk.until) mid += walk.dir * (TICK * 0.9 + Math.abs(N()) * TICK * 0.3); else { if (R() < 0.12) mid += (R() < 0.5 ? -1 : 1) * TICK; walk = walk && i >= walk.until ? null : walk; }      // liquid-stock behaviour: the mid moves at most one tick, a few times a minute
        // quantity drift: ~12 % of populated visible levels re-quote by a few tens of percent
        for (const [m, on] of [[qtyB, onB], [qtyA, onA]] as const) for (const k of [...m.keys()]) if (on.get(k) && R() < 0.0006) m.set(k, Math.max(300, 2600 * logn(0, noise)));   // re-quote: redraw from the stationary distribution (no random-walk drift)
        for (let k = overrides.length - 1; k >= 0; k--) if (overrides[k].to < t) overrides.splice(k, 1);

        const level = (side: 'bid' | 'ask'): DepthLevel[] => {
          const out: DepthLevel[] = [];
          const m = side === 'bid' ? qtyB : qtyA, on = side === 'bid' ? onB : onA;
          let k = side === 'bid' ? bestBidIdx() : bestBidIdx() + 1, guard = 0;
          while (out.length < 5 && guard++ < 400) {
            const ov = overrides.find((o) => o.side === side && o.idx === k && t >= o.from && t < o.to);
            const base = q(m, on, k);
            const qty = ov ? ov.qty : base;
            if (qty > 0) out.push({ price: round(k * TICK, 2), qty: Math.round(qty * (1 - out.length * 0.05)), orders: 1 + Math.floor(qty / 2500) });
            k += side === 'bid' ? -1 : 1;
          }
          return out;
        };
        snaps.push({ t, symbol, ltp: round(mid, 2), bids: level('bid'), asks: level('ask') });
      }
    }
  }
  snaps.sort((a, b) => a.t - b.t || (a.symbol < b.symbol ? -1 : 1));
  return { snaps, episodes };
}


/* ───────────────────────── scoring (shared by baseline, composite and the sweep) ───────────────────────── */
type FlagLite = Pick<DepthFlag, 'symbol' | 'kind' | 'side' | 'ts'>;
export interface Score { tp: number; fp: number; causes: Record<string, number>; recall: NonNullable<BacktestResult['recall']> }
export function scoreFlags(flags: readonly FlagLite[], episodes: Episode[]): Score {
  // match every flag to the episode (if any) whose window, symbol, side and pattern kind it fits
  const hitBy = new Map<Episode, number[]>();            // episode → flag delays
  let tp = 0, fp = 0;
  const causes: Record<string, number> = {};
  const bySym = new Map<string, Episode[]>();
  for (const e of episodes) (bySym.get(e.symbol) ?? bySym.set(e.symbol, []).get(e.symbol)!).push(e);
  for (const f of flags) {
    const sameWindow = (bySym.get(f.symbol) ?? []).filter((e) => f.ts >= e.from && f.ts <= e.to + GRACE_MS);
    const pos = sameWindow.find((e) => POSITIVE[e.cls] && e.side === f.side && KIND_OF[e.cls] === f.kind);
    if (pos) { tp++; (hitBy.get(pos) ?? hitBy.set(pos, []).get(pos)!).push(f.ts - pos.from); continue; }
    fp++;
    const ben = sameWindow.find((e) => !POSITIVE[e.cls] && KIND_OF[e.cls] === f.kind);
    const cause = ben ? ben.cls : sameWindow.length ? 'wrong_side_or_kind_near_episode' : `background_noise_${f.kind}`;
    causes[cause] = (causes[cause] ?? 0) + 1;
  }
  const recall: Score['recall'] = {};
  for (const cls of ['spoof_wall', 'flicker'] as const) {
    const eps = episodes.filter((e) => e.cls === cls);
    const delays = eps.flatMap((e) => (hitBy.get(e) ? [Math.min(...(hitBy.get(e) as number[]))] : []));
    recall[cls] = { episodes: eps.length, detected: delays.length, rate: eps.length ? round(delays.length / eps.length) : null, medianDelayMs: median(delays) };
  }
  return { tp, fp, causes, recall };
}

/* ───────────────────────── evaluation ───────────────────────── */
export function evaluate(snaps: Snapshot[], episodes: Episode[] | null, config: Record<string, unknown> = {}): BacktestResult {
  const tracker = new DepthFlagTracker();
  const flags: DepthFlag[] = [];
  for (const s of snaps) for (const f of tracker.observe(s.symbol, { bids: s.bids, asks: s.asks }, s.ltp, s.t)) flags.push(f);

  const byKind: Record<string, number> = {}, bySeverity: Record<string, number> = {};
  for (const f of flags) { byKind[f.kind] = (byKind[f.kind] ?? 0) + 1; bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1; }
  const symbols = new Set(snaps.map((s) => s.symbol)).size;
  const epCount: Record<string, number> = {};
  for (const e of episodes ?? []) epCount[e.cls] = (epCount[e.cls] ?? 0) + 1;

  const base: BacktestResult = {
    config, data: { snapshots: snaps.length, symbols, labelled: !!episodes && episodes.length > 0, episodes: epCount },
    flags: { total: flags.length, byKind, bySeverity, per1000Snapshots: snaps.length ? round((flags.length / snaps.length) * 1000, 3) : 0 },
    precision: null, truePositives: null, falsePositives: null, falsePositiveCauses: null, recall: null, params: FLAG_PARAMS,
    notes: [],
  };
  if (!episodes || !episodes.length) { base.notes.push('No ground-truth labels: precision and recall are N/A. Trigger counts only.'); return base; }

  const sc = scoreFlags(flags, episodes);
  const { tp, fp, causes, recall } = sc;
  base.precision = tp + fp ? round(tp / (tp + fp)) : null;
  base.truePositives = tp; base.falsePositives = fp; base.falsePositiveCauses = causes; base.recall = recall;
  base.notes.push(
    'Labels define "pattern" the same way the generator does: results show agreement with that definition, not how often real markets are manipulated, and nothing about intent.',
    'benign_fill_wall: a large order that rests and is then FILLED still looks like a wall while it rests — counted as a false positive, because a wall alone cannot tell liquidity from a spoof.',
    'precision = flags matching a labelled pattern ÷ all flags; recall = labelled episodes with ≥ 1 matching flag ÷ labelled episodes.',
  );
  return base;
}


/* ───────────────────────── synthetic volume layer (Week 11) ─────────────────────────
 * The depth generator above is untouched (so the baseline numbers are reproducible bit-for-bit). Traded volume is generated AFTERWARDS from a separate
 * seeded stream, so it can only ever be an additional signal, never a change to the book.
 *   • base rate  = a U-shaped typical intraday profile (heavy open and close) × a slow mean-reverting log-normal regime (sd ≈ 0.15, τ ≈ 20 min) × per-step noise
 *   • bursts     = volume runs at 2–4× for 5–15 min. Background bursts occur at random (default 2 per symbol-day).
 *   • COUPLING   = the ASSUMPTION that labelled episodes tend to be accompanied by a burst that is already running 6–12 min before the pattern appears (a
 *                  trailing 15-minute ratio needs that long to react) and lasts until 3 min after it ends; probability per class below. This is the one place
 *                  where the generator encodes "manipulation correlates with volume". It is an assumption, not a measurement — `sensitivity.volumeCouplingOff` in the output
 *                  shows what the composite does when it is false.
 *     benign_fill_wall gets the highest coupling on purpose: a wall that is genuinely traded through IS volume, so volume cannot tell it from a spoof.
 */
export interface VolumeCoupling { spoof_wall: number; flicker: number; benign_fill_wall: number; benign_displacement: number; backgroundBurstsPerDay: number }
export const DEFAULT_COUPLING: VolumeCoupling = { spoof_wall: 0.7, flicker: 0.7, benign_fill_wall: 0.9, benign_displacement: 0.1, backgroundBurstsPerDay: 2 };
export const NO_COUPLING: VolumeCoupling = { spoof_wall: 0, flicker: 0, benign_fill_wall: 0, benign_displacement: 0, backgroundBurstsPerDay: 2 };

/** typical full-day volume of synthetic symbol `BTnn` */
export const synthFullDay = (symbol: string): number => 3_000_000 + 400_000 * (Number(symbol.replace(/\D/g, '')) || 0);
/** normalised U-shaped intraday shape → median cumulative profile (25 buckets) scaled to `fullDay` */
export function synthProfile(fullDay: number): IntradayProfile {
  const w = Array.from({ length: BUCKETS }, (_, k) => 1 + 1.4 * Math.exp(-k / 2.5) + 0.9 * Math.exp(-(BUCKETS - 1 - k) / 2.5));
  const tot = w.reduce((a, b) => a + b, 0); let c = 0;
  return { cum: w.map((x) => (c += (x / tot) * fullDay)), sessions: 20, status: 'ok' };
}

/** cumulative session volume per snapshot, aligned with `snaps` (the array must already be time-sorted) */
export function synthesizeVolume(snaps: Snapshot[], episodes: Episode[], seed: number, coupling: VolumeCoupling = DEFAULT_COUPLING): Float64Array {
  const R = rng((seed ^ 0x9e3779b1) >>> 0), N = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const U = (a: number, b: number) => a + (b - a) * R();
  const out = new Float64Array(snaps.length);
  const groups = new Map<string, number[]>();
  snaps.forEach((x, i) => { const k = `${x.symbol}|${istDayOf(x.t)}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(i); });
  const epBySym = new Map<string, Episode[]>();
  for (const e of episodes) (epBySym.get(e.symbol) ?? epBySym.set(e.symbol, []).get(e.symbol)!).push(e);
  for (const [key, idx] of groups) {
    const symbol = key.split('|')[0], t0 = snaps[idx[0]].t, t1 = snaps[idx[idx.length - 1]].t;
    const full = synthFullDay(symbol), prof = synthProfile(full);
    const bursts: { from: number; to: number; mult: number }[] = [];
    for (const e of epBySym.get(symbol) ?? []) {
      if (e.from < t0 || e.from > t1) continue;
      if (R() < coupling[e.cls]) { const from = e.from - U(6, 12) * 60_000; bursts.push({ from, to: e.to + 180_000, mult: U(2.2, 4.0) }); }
    }
    let n = 0; for (let L = Math.exp(-coupling.backgroundBurstsPerDay), p = 1; (p *= R()) > L; ) n++;
    for (let k = 0; k < n; k++) { const from = t0 + R() * (t1 - t0); bursts.push({ from, to: from + U(300_000, 900_000), mult: U(2, 3.5) }); }
    let x = 0, cum = 0, prevT = t0;
    for (const i of idx) {
      const t = snaps[i].t, dt = Math.max(0, t - prevT); prevT = t;
      const m = Math.max(1, ...bursts.filter((b) => t >= b.from && t < b.to).map((b) => b.mult));
      const tau = 20 * 60_000; x += -x * (dt / tau) + 0.15 * Math.sqrt((2 * dt) / tau) * N();
      const minute = (t - t0) / 60_000, k = Math.min(BUCKETS - 1, Math.floor(minute / 15));
      const slope = (prof.cum[k] - (k ? prof.cum[k - 1] : 0)) / 15 / 60_000;               // shares per ms in this bucket
      cum += slope * dt * m * Math.exp(x) * Math.exp(0.3 * N() - 0.045);
      out[i] = cum;
    }
  }
  return out;
}

/** R(t) for snapshot i, using only snapshots at or before it (no look-ahead). null = N/A */
export function makeSurgeLookup(snaps: Snapshot[], vol: Float64Array | null): (i: number) => number | null {
  if (!vol) return () => null;
  const groups = new Map<string, number[]>(), groupOf = new Int32Array(snaps.length), list: number[][] = [], profiles: IntradayProfile[] = [];
  snaps.forEach((x, i) => {
    const k = `${x.symbol}|${istDayOf(x.t)}`; let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); list.push(g); profiles.push(synthProfile(synthFullDay(x.symbol))); }
    g.push(i); groupOf[i] = list.indexOf(g);
  });
  const W = SURGE_WINDOW_MIN * 60_000;
  return (i) => {
    const gi = groupOf[i], g = list[gi], now = snaps[i].t;
    let lo = 0, hi = g.length - 1;                                      // last snapshot of this symbol-day at or before now − W (else the first)
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (snaps[g[mid]].t <= now - W) lo = mid; else hi = mid - 1; }
    const j = g[lo], then = snaps[j].t <= now - W ? vol[j] : 0, span = snaps[j].t <= now - W ? W : now - snaps[g[0]].t;
    return windowSurge(profiles[gi], vol[i], then, now, span);
  };
}

/* ───────────────────────── composite (multi-signal) evaluation + sweep ───────────────────────── */
interface Cand { f: DepthFlag; i: number; spreadRatio: number | null; obi: number[] }
export interface Metrics { flags: number; tp: number; fp: number; precision: number | null; recallSpoof: number | null; recallFlicker: number | null; recall: number | null; f1: number | null; per1000: number }
export const LAMBDAS = [0.2, 0.4, 0.5, 0.6, 0.8] as const;           // 0.5 = the platform's own decay (LEVEL_WEIGHTS); the other four are the requested grid
export const WALL_MULTS = [2.5, 3, 4, 5] as const;
export const SURGES = [1.0, 1.5, 1.8, 2.2] as const;

/** one tracker pass at a wall multiple: every candidate (no cooldown) with its signals at that instant */
function collect(snaps: Snapshot[], wallMult: number): Cand[] {
  const tr = new DepthFlagTracker({ wallMult }), out: Cand[] = [];
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i], { flags, spreadRatio } = tr.candidates(s.symbol, { bids: s.bids, asks: s.asks }, s.ltp, s.t);
    if (!flags.length) continue;
    const obi = LAMBDAS.map((l) => obiOfBook(s.bids, s.asks, l) ?? NaN);
    for (const f of flags) out.push({ f, i, spreadRatio, obi });
  }
  return out;
}
function metrics(flags: FlagLite[], snapCount: number, episodes: Episode[]): Metrics {
  const sc = scoreFlags(flags, episodes), n = flags.length;
  const eps = (sc.recall.spoof_wall?.episodes ?? 0) + (sc.recall.flicker?.episodes ?? 0), det = (sc.recall.spoof_wall?.detected ?? 0) + (sc.recall.flicker?.detected ?? 0);
  const precision = n ? sc.tp / n : null, recall = eps ? det / eps : null;
  return {
    flags: n, tp: sc.tp, fp: sc.fp, precision: precision === null ? null : round(precision), recallSpoof: sc.recall.spoof_wall?.rate ?? null, recallFlicker: sc.recall.flicker?.rate ?? null,
    recall: recall === null ? null : round(recall), f1: precision !== null && recall !== null && precision + recall > 0 ? round((2 * precision * recall) / (precision + recall)) : null, per1000: snapCount ? round((n / snapCount) * 1000, 3) : 0,
  };
}
/** baseline flags from candidates: cooldown only (identical to DepthFlagTracker.observe in baseline mode) */
function baselineFlags(c: Cand[]): DepthFlag[] { const gate = makeCooldown(); return c.filter((x) => gate(x.f, x.f.ts)).map((x) => x.f); }
/** composite flags: confirmation BEFORE the cooldown (an unconfirmed candidate never mutes a later confirmed one) */
function compositeFlags(c: Cand[], surge: (i: number) => number | null, lambdaIdx: number, o: { surgeMin: number; useVolume?: boolean }): DepthFlag[] {
  const gate = makeCooldown(), out: DepthFlag[] = [];
  for (const x of c) {
    const conf = confirmFlag({ obi: Number.isNaN(x.obi[lambdaIdx]) ? null : x.obi[lambdaIdx], volRatio: o.useVolume === false ? null : surge(x.i), spreadRatio: x.spreadRatio }, { SURGE_MIN: o.surgeMin });
    if (conf.confirmed && gate(x.f, x.f.ts)) out.push(x.f);
  }
  return out;
}
const cmp = (b: Metrics, c: Metrics) => ({
  precisionBefore: b.precision, precisionAfter: c.precision, fpBefore: b.fp, fpAfter: c.fp, fpReductionPct: b.fp ? round(((b.fp - c.fp) / b.fp) * 100, 1) : null,
  recallBefore: b.recall, recallAfter: c.recall, recallDelta: b.recall !== null && c.recall !== null ? round(c.recall - b.recall) : null,
});

export interface SweepResult {
  axes: { lambda: number[]; wallMultiple: number[]; surge: number[] };
  fixed: { obiMin: number; spreadMult: number; minSignals: number };
  cells: { lambda: number; wallMultiple: number; surge: number; baseline: Metrics; composite: Metrics; fpReductionPct: number | null }[];
  modes: { baseline: Metrics; confirmed_composite: Metrics & { params: Record<string, number> }; comparison: ReturnType<typeof cmp> };
  sensitivity: { volumeCouplingOff: Metrics; volumeSignalDisabled: Metrics };
  assumptions: { volumeCoupling: VolumeCoupling; surgeWindowMin: number; spreadWindow: number; note: string };
}
export function runSweep(snaps: Snapshot[], episodes: Episode[], vol: Float64Array | null, volOff: Float64Array | null): SweepResult {
  const surge = makeSurgeLookup(snaps, vol), surgeOff = makeSurgeLookup(snaps, volOff);
  const cells: SweepResult['cells'] = [];
  let headline: SweepResult['modes'] | null = null, sens: SweepResult['sensitivity'] | null = null;
  const defL = LAMBDAS.indexOf(CONFIRM_PARAMS.LAMBDA as (typeof LAMBDAS)[number]);
  for (const wm of WALL_MULTS) {
    const cand = collect(snaps, wm);
    const base = metrics(baselineFlags(cand), snaps.length, episodes);
    LAMBDAS.forEach((lambda, li) => {
      for (const r of SURGES) {
        const comp = metrics(compositeFlags(cand, surge, li, { surgeMin: r }), snaps.length, episodes);
        cells.push({ lambda, wallMultiple: wm, surge: r, baseline: base, composite: comp, fpReductionPct: cmp(base, comp).fpReductionPct });
      }
    });
    if (wm === FLAG_PARAMS.WALL_MULT) {
      const comp = metrics(compositeFlags(cand, surge, defL, { surgeMin: CONFIRM_PARAMS.SURGE_MIN }), snaps.length, episodes);
      headline = { baseline: base, confirmed_composite: { ...comp, params: { lambda: CONFIRM_PARAMS.LAMBDA, wallMultiple: wm, obiMin: CONFIRM_PARAMS.OBI_MIN, surgeMin: CONFIRM_PARAMS.SURGE_MIN, spreadMult: CONFIRM_PARAMS.SPREAD_MULT, minSignals: CONFIRM_PARAMS.MIN_SIGNALS } }, comparison: cmp(base, comp) };
      sens = {
        volumeCouplingOff: metrics(compositeFlags(cand, surgeOff, defL, { surgeMin: CONFIRM_PARAMS.SURGE_MIN }), snaps.length, episodes),
        volumeSignalDisabled: metrics(compositeFlags(cand, surge, defL, { surgeMin: CONFIRM_PARAMS.SURGE_MIN, useVolume: false }), snaps.length, episodes),
      };
    }
  }
  return {
    axes: { lambda: [...LAMBDAS], wallMultiple: [...WALL_MULTS], surge: [...SURGES] },
    fixed: { obiMin: CONFIRM_PARAMS.OBI_MIN, spreadMult: CONFIRM_PARAMS.SPREAD_MULT, minSignals: CONFIRM_PARAMS.MIN_SIGNALS },
    cells, modes: headline!, sensitivity: sens!,
    assumptions: {
      volumeCoupling: DEFAULT_COUPLING, surgeWindowMin: SURGE_WINDOW_MIN, spreadWindow: CONFIRM_PARAMS.SPREAD_WINDOW,
      note: 'Order-book imbalance and spread are computed from the synthetic book itself. Volume is generated separately and its link to labelled episodes (volumeCoupling) is an ASSUMPTION; sensitivity.volumeCouplingOff shows the composite without it. All signals use data available at the flag time only (no look-ahead). Synthetic replay — not evidence about real-market manipulation.',
    },
  };
}

/* ───────────────────────── recorded input ───────────────────────── */
export async function loadJsonl(path: string): Promise<{ snaps: Snapshot[]; episodes: Episode[] }> {
  const snaps: Snapshot[] = [], episodes: Episode[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { throw new Error(`${path}:${n}: not valid JSON`); }
    if (typeof o.label === 'string') {
      if (!(o.label in POSITIVE)) throw new Error(`${path}:${n}: unknown label "${o.label}"`);
      episodes.push({ cls: o.label as EpisodeClass, symbol: String(o.symbol).toUpperCase(), side: o.side === 'ask' ? 'ask' : 'bid', from: Number(o.from), to: Number(o.to) });
      continue;
    }
    const lv = (a: unknown): DepthLevel[] => (Array.isArray(a) ? a : []).map((x) => ({ price: Number((x as number[])[0]), qty: Number((x as number[])[1]), orders: Number((x as number[])[2] ?? 1) }));
    if (!Number.isFinite(Number(o.t)) || typeof o.symbol !== 'string') throw new Error(`${path}:${n}: a snapshot needs "t" (epoch ms) and "symbol"`);
    snaps.push({ t: Number(o.t), symbol: o.symbol.toUpperCase(), ltp: Number(o.ltp), bids: lv(o.bids), asks: lv(o.asks) });
  }
  snaps.sort((a, b) => a.t - b.t);
  return { snaps, episodes };
}

/* ───────────────────────── report ───────────────────────── */
function print(r: BacktestResult): void {
  const pct = (x: number | null) => (x === null ? 'N/A' : `${(x * 100).toFixed(1)} %`);
  console.log(`\nHeuristic flag backtest — ${r.data.snapshots.toLocaleString('en-IN')} snapshots · ${r.data.symbols} symbols · labels: ${r.data.labelled ? 'yes' : 'no'}`);
  console.log(`flags: ${r.flags.total} (${Object.entries(r.flags.byKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}) · severity ${Object.entries(r.flags.bySeverity).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} · ${r.flags.per1000Snapshots} per 1 000 snapshots`);
  if (r.data.labelled) {
    console.log(`episodes: ${Object.entries(r.data.episodes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`precision ${pct(r.precision)}  (TP ${r.truePositives}, FP ${r.falsePositives})`);
    console.log(`false-positive causes: ${Object.entries(r.falsePositiveCauses ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    for (const [k, v] of Object.entries(r.recall ?? {})) console.log(`recall ${k.padEnd(10)} ${pct(v.rate)}  (${v.detected}/${v.episodes})  median delay ${v.medianDelayMs === null ? 'N/A' : `${(v.medianDelayMs / 1000).toFixed(1)} s`}`);
  } else console.log('precision / recall: N/A (no labels)');
  console.log(`\n${r.notes.join('\n')}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string | number): string | number => { const i = argv.indexOf(`--${k}`); return i < 0 || !argv[i + 1] ? d : typeof d === 'number' ? Number(argv[i + 1]) : argv[i + 1]; };
  const input = String(get('input', '')), out = String(get('out', ''));
  const cfg = { symbols: Number(get('symbols', 4)), days: Number(get('days', 3)), stepMs: Number(get('step-ms', 500)), seed: Number(get('seed', 1)), noise: Number(get('noise', 0.45)) };
  if (!Object.values(cfg).every((v) => Number.isFinite(v) && v > 0)) { console.error('bad numeric argument'); process.exit(2); }
  const data = input ? await loadJsonl(input) : synthesize(cfg);
  const res = evaluate(data.snaps, data.episodes, input ? { input } : { source: 'synthetic', ...cfg });
  print(res);
  if (!input && data.episodes.length && !argv.includes('--no-sweep')) {
    const vol = synthesizeVolume(data.snaps, data.episodes, cfg.seed, DEFAULT_COUPLING), volOff = synthesizeVolume(data.snaps, data.episodes, cfg.seed, NO_COUPLING);
    const sw = runSweep(data.snaps, data.episodes, vol, volOff);
    const m = sw.modes, pc = (x: number | null) => (x === null ? 'N/A' : `${(x * 100).toFixed(1)} %`);
    console.log(`\nconfirmed_composite (λ ${CONFIRM_PARAMS.LAMBDA}, wall ×${FLAG_PARAMS.WALL_MULT}, R ≥ ${CONFIRM_PARAMS.SURGE_MIN}, ≥ ${CONFIRM_PARAMS.MIN_SIGNALS} of 3 signals)`);
    console.log(`  precision ${pc(m.baseline.precision)} → ${pc(m.confirmed_composite.precision)} · FP ${m.baseline.fp} → ${m.confirmed_composite.fp} (−${m.comparison.fpReductionPct} %) · recall ${pc(m.baseline.recall)} → ${pc(m.confirmed_composite.recall)} · flags/1000 ${m.baseline.per1000} → ${m.confirmed_composite.per1000}`);
    console.log(`  if volume is NOT coupled to episodes: precision ${pc(sw.sensitivity.volumeCouplingOff.precision)}, recall ${pc(sw.sensitivity.volumeCouplingOff.recall)} · volume signal disabled: precision ${pc(sw.sensitivity.volumeSignalDisabled.precision)}, recall ${pc(sw.sensitivity.volumeSignalDisabled.recall)}`);
    Object.assign(res, { schemaVersion: 2, modes: sw.modes, sweep: { axes: sw.axes, fixed: sw.fixed, cells: sw.cells }, sensitivity: sw.sensitivity, assumptions: sw.assumptions });
  }
  if (out) { writeFileSync(out, JSON.stringify(res, null, 2) + '\n'); console.log(`wrote ${out}`); }
}
if (process.argv[1] && /backtest-heuristics\.(ts|js|mjs|cjs)$/.test(process.argv[1])) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
