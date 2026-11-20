// Deterministic "market burst" replay: a scripted multi-stock tick + 5-level depth scenario that is pushed through the REAL pipeline
// (DepthFlagTracker → obiOfBook/topFiveImbalance → VolumeWindow R(t) → confirmFlag). It is synthetic and labelled as such everywhere it is shown;
// it never touches the engine's quotes, the cloud, or any stored record — the runner only holds its own in-memory state.
import { DepthFlagTracker, type DepthFlag } from './heuristicFlags';
import { topFiveImbalance, obiValue } from './depthImbalance';
import { VolumeWindow, expectedCumAt, BUCKETS, type IntradayProfile } from './volumeBaseline';
import { NEAR_PCT } from './analytics/proximity';
import type { DepthLevel } from './types';

export const REPLAY_DISCLOSURE = 'SIMULATION — synthetic ticks and order-book depth scripted for demonstration. Nothing here is market data, nothing is stored, and no real alert is sent.';
export const REPLAY_START_MS = Date.UTC(2026, 10, 18, 5, 30);        // Wed 18 Nov 2026, 11:00 IST — inside the session so R(t) and the profile are defined
export const REPLAY_STEP_MS = 5_000;
export const REPLAY_MINUTES = 24;

export interface ReplayFrame { t: number; symbol: string; ltp: number; bids: DepthLevel[]; asks: DepthLevel[]; volume: number; prevClose: number; upper: number; lower: number }
export interface ReplayPhase { atMin: number; symbol: string; text: string }
export interface ReplayScenario { frames: ReplayFrame[]; profiles: Record<string, IntradayProfile>; phases: ReplayPhase[]; symbols: string[]; startMs: number; stepMs: number }

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r2 = (x: number) => Math.round(x * 100) / 100;

/** U-shaped typical day (heavy open and close), cumulative at the end of each 15-minute bucket */
export function replayProfile(fullDay: number): IntradayProfile {
  const w = Array.from({ length: BUCKETS }, (_, k) => 1 + 1.6 * Math.exp(-k / 2) + 1.2 * Math.exp(-(BUCKETS - 1 - k) / 2));
  const tot = w.reduce((a, b) => a + b, 0); let c = 0;
  return { status: 'ok', sessions: 20, cum: w.map((x) => { c += x; return Math.round((c / tot) * fullDay); }) };
}

interface Plan {
  symbol: string; prev: number; band: number; fullDay: number; tick: number;
  /** volume multiple of the typical pace at minute m */
  vol: (m: number) => number;
  /** price as % change from prev close at minute m */
  chg: (m: number) => number;
  /** resting quantity per level (best first) at minute m — the book keeps a fixed price grid and moves at most one tick per step, so only the scripted quantities change */
  book: (m: number) => { bid: number[]; ask: number[] };
}
const flat = (q: number) => [q, q, q, q, q];
const at = (a: number[], i: number, q: number) => a.map((x, k) => (k === i ? q : x));

const PLANS: Plan[] = [
  { // confirmed: volume burst from minute 3, then a large bid wall at minute 10–12 and a flickering ask order at minute 15–17
    symbol: 'RELIANCE', prev: 1500, band: 10, fullDay: 9_000_000, tick: 0.05,
    vol: (m) => (m >= 3 && m < 18 ? 4 : 1), chg: (m) => 0.2 + 0.01 * m,
    book: (m) => {
      if (m >= 10 && m < 12) return { bid: at(flat(1200), 2, 14_000), ask: flat(900) };
      if (m >= 15 && m < 17.4 && Math.floor((m * 60) / 5) % 2 === 0) return { bid: flat(1000), ask: at(flat(1000), 1, 6000) };
      return { bid: flat(1000), ask: flat(1000) };
    },
  },
  { // baseline-only: a bid wall while the ask side is nearly as heavy and volume is normal — a single-rule flag that the confirmation filter suppresses
    symbol: 'TCS', prev: 4000, band: 10, fullDay: 2_500_000, tick: 0.05,
    vol: () => 1, chg: (m) => -0.1 + 0.005 * m,
    book: (m) => (m >= 8 && m < 9.7 ? { bid: at(flat(900), 2, 6500), ask: flat(3000) } : { bid: flat(1500), ask: flat(1500) }),
  },
  { // circuit approach: volume builds from minute 12 while the price climbs to the upper band; the ask side thins out
    symbol: 'INFY', prev: 1600, band: 10, fullDay: 6_000_000, tick: 0.2,
    vol: (m) => (m >= 12 ? 2.6 : 1), chg: (m) => Math.min(10, 8.0 + (2 * m) / 21),
    book: (m) => (m >= 16 ? { bid: flat(2600), ask: [320, 180, 140, 120, 100] } : { bid: flat(1800), ask: flat(1800) }),
  },
];

export const REPLAY_PHASES: ReplayPhase[] = [
  { atMin: 0, symbol: '—', text: 'Warm-up: normal volume and balanced books (R(t) needs ≥ 5 min of history, so it reads N/A for a moment).' },
  { atMin: 3, symbol: 'RELIANCE', text: 'Volume burst starts (≈ 4× the typical pace).' },
  { atMin: 8, symbol: 'TCS', text: 'A bid wall appears while the ask side is just as heavy and volume is normal — expect a Baseline Flag only.' },
  { atMin: 10, symbol: 'RELIANCE', text: 'A 14 000-share bid wall appears during the burst — expect a Multi-Signal Confirmed flag (OBI + volume).' },
  { atMin: 12, symbol: 'INFY', text: 'Volume builds as the price climbs towards the upper circuit.' },
  { atMin: 15, symbol: 'RELIANCE', text: 'A large ask order appears and vanishes repeatedly (add/cancel pattern).' },
  { atMin: 16, symbol: 'INFY', text: 'Ask-side depth thins out near the circuit — exit-risk territory.' },
  { atMin: 21, symbol: 'INFY', text: 'Price touches the upper circuit band.' },
];

export function buildReplay(seed = 11): ReplayScenario {
  const rnd = rng(seed), frames: ReplayFrame[] = [], profiles: Record<string, IntradayProfile> = {};
  const n = (REPLAY_MINUTES * 60_000) / REPLAY_STEP_MS;
  for (const p of PLANS) {
    const prof = (profiles[p.symbol] = replayProfile(p.fullDay));
    let cum = Math.round(expectedCumAt(prof, REPLAY_START_MS) ?? 0);
    const upper = r2(p.prev * (1 + p.band / 100)), lower = r2(p.prev * (1 - p.band / 100));
    const snap = (x: number) => Math.round(x / p.tick) * p.tick;
    let bp = snap(p.prev * (1 + p.chg(0) / 100) - p.tick);                           // best bid, on the tick grid
    for (let i = 0; i <= n; i++) {
      const t = REPLAY_START_MS + i * REPLAY_STEP_MS, m = (i * REPLAY_STEP_MS) / 60_000;
      const typical = (expectedCumAt(prof, t + REPLAY_STEP_MS) ?? 0) - (expectedCumAt(prof, t) ?? 0);
      if (i > 0) cum += Math.max(0, Math.round(typical * p.vol(m) * (0.92 + 0.16 * rnd())));
      const target = snap(Math.min(upper, p.prev * (1 + p.chg(m) / 100)) - p.tick);
      bp += Math.max(-p.tick, Math.min(p.tick, target - bp));                          // at most one tick per step: a real book does not teleport
      const ltp = Math.min(upper, Math.max(lower, r2(bp + p.tick)));
      const sh = p.book(m);
      const lv = (qs: number[], dir: 1 | -1, start: number): DepthLevel[] => qs.map((q, k) => ({ price: r2(start + dir * p.tick * k), qty: Math.round(q * (0.97 + 0.06 * rnd())), orders: 1 + (q > 3000 ? 3 : 0) }));
      frames.push({ t, symbol: p.symbol, ltp, bids: lv(sh.bid, -1, r2(bp)), asks: lv(sh.ask, 1, r2(bp + 2 * p.tick)), volume: cum, prevClose: p.prev, upper, lower });
    }
  }
  frames.sort((a, b) => a.t - b.t || (a.symbol < b.symbol ? -1 : 1));
  return { frames, profiles, phases: REPLAY_PHASES, symbols: PLANS.map((p) => p.symbol), startMs: REPLAY_START_MS, stepMs: REPLAY_STEP_MS };
}

/* ───────────── the runner: real pipeline, private state ───────────── */
export type SimAlertKind = 'confirmed_flag' | 'volume_surge' | 'order_imbalance' | 'circuit_proximity' | 'circuit_touch';
export interface SimAlert { t: number; symbol: string; kind: SimAlertKind; text: string; channel: 'simulated-push' }
export interface ReplayReading { t: number; symbol: string; ltp: number; volume: number; obi: number | null; volRatio: number | null; spreadRatio: number | null; toUpperPct: number | null; toLowerPct: number | null; flags: DepthFlag[]; alerts: SimAlert[]; bids: DepthLevel[]; asks: DepthLevel[] }

export const SIM_RULES = { surge: 1.8, obi: 0.6, cooldownMs: 5 * 60_000 } as const;

export class ReplayRunner {
  private i = 0;
  private readonly tracker = new DepthFlagTracker({ evaluate: true });
  private readonly vol = new VolumeWindow();
  private readonly lastAlert = new Map<string, number>();
  private readonly touched = new Set<string>();
  readonly readings: ReplayReading[] = [];
  readonly flags: DepthFlag[] = [];
  readonly alerts: SimAlert[] = [];
  constructor(readonly scenario: ReplayScenario = buildReplay()) {}
  get done(): boolean { return this.i >= this.scenario.frames.length; }
  get progress(): number { return this.scenario.frames.length ? this.i / this.scenario.frames.length : 1; }
  reset(): void { this.i = 0; this.tracker.reset(); this.vol.clear(); this.lastAlert.clear(); this.touched.clear(); this.readings.length = 0; this.flags.length = 0; this.alerts.length = 0; }

  /** processes every frame that shares the next timestamp (one tick of all symbols) */
  stepTick(): ReplayReading[] {
    const fr = this.scenario.frames, out: ReplayReading[] = [];
    if (this.done) return out;
    const t = fr[this.i].t;
    while (this.i < fr.length && fr[this.i].t === t) out.push(this.one(fr[this.i++]));
    return out;
  }
  runAll(): ReplayReading[] { const all: ReplayReading[] = []; while (!this.done) all.push(...this.stepTick()); return all; }

  private gate(key: string, t: number): boolean { const l = this.lastAlert.get(key); if (l !== undefined && t - l < SIM_RULES.cooldownMs) return false; this.lastAlert.set(key, t); return true; }
  private one(f: ReplayFrame): ReplayReading {
    const prof = this.scenario.profiles[f.symbol];
    this.vol.push(f.symbol, f.t, f.volume);
    const volRatio = this.vol.ratio(f.symbol, prof, f.t, f.volume);
    const imb = topFiveImbalance(f.bids, f.asks);
    const obi = imb ? obiValue(imb, 'weighted') : null;
    const flags = this.tracker.observe(f.symbol, { bids: f.bids, asks: f.asks }, f.ltp, f.t, { volRatio });
    const spreadRatio = flags[0]?.confirmation?.spreadRatio ?? null;
    const toUpperPct = f.upper > 0 ? ((f.upper - f.ltp) / f.upper) * 100 : null, toLowerPct = f.lower > 0 ? ((f.ltp - f.lower) / f.lower) * 100 : null;
    const alerts: SimAlert[] = [], push = (kind: SimAlertKind, text: string, key: string = kind) => { if (this.gate(`${f.symbol}|${key}`, f.t)) alerts.push({ t: f.t, symbol: f.symbol, kind, text, channel: 'simulated-push' }); };
    for (const fl of flags) if (fl.confirmation?.confirmed) push('confirmed_flag', `${f.symbol}: Multi-Signal Confirmed ${fl.kind === 'wall' ? 'resting-order wall' : 'rapid add/cancel'} (${fl.confirmation.hits.join(' + ')})`, `confirmed_flag|${fl.kind}`);
    if (volRatio !== null && volRatio >= SIM_RULES.surge) push('volume_surge', `${f.symbol}: 15-min volume ${volRatio.toFixed(1)}× its typical pace`);
    if (obi !== null && Math.abs(obi) >= SIM_RULES.obi) push('order_imbalance', `${f.symbol}: top-5 imbalance ${obi >= 0 ? '+' : '−'}${Math.abs(obi).toFixed(2)}`);
    if (toUpperPct !== null && toUpperPct <= NEAR_PCT && toUpperPct > 0) push('circuit_proximity', `${f.symbol}: ${toUpperPct.toFixed(2)}% below the upper circuit`);
    if (f.ltp >= f.upper && !this.touched.has(f.symbol)) { this.touched.add(f.symbol); alerts.push({ t: f.t, symbol: f.symbol, kind: 'circuit_touch', text: `${f.symbol}: touched the upper circuit ₹${f.upper.toFixed(2)}`, channel: 'simulated-push' }); }
    this.flags.push(...flags); this.alerts.push(...alerts);
    const rd: ReplayReading = { t: f.t, symbol: f.symbol, ltp: f.ltp, volume: f.volume, obi, volRatio, spreadRatio, toUpperPct, toLowerPct, flags, alerts, bids: f.bids, asks: f.asks };
    this.readings.push(rd);
    return rd;
  }
}
