import type { AlertKind, Candle, DepthLevel, IndexQuote, Instrument, MarketAlert, OrderBook, Quote, Timeframe } from './types';
import { SEED_SECTORS } from './instruments';

/* ───────────── deterministic helpers ───────────── */

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rnd: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const TICK = 0.05;
export const roundTick = (p: number): number => Math.round(p / TICK) * TICK;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** NOTE: all prices are SIMULATED. Replace MarketEngine with a real feed adapter for production. */
export function basePrice(symbol: string): number {
  const r = mulberry32(hashStr(symbol + ':px'))();
  return roundTick(40 + Math.pow(r, 3) * 4960);
}
export const sharesCr = (symbol: string) => 1 + Math.pow(mulberry32(hashStr(symbol + ':sh'))(), 1.7) * 280;
export const dailyVolume = (symbol: string) => 150_000 + mulberry32(hashStr(symbol + ':vol'))() * 6_000_000;
export const dividendYieldOf = (symbol: string) => Math.round(mulberry32(hashStr(symbol + ':dy'))() * 380) / 100; // 0–3.8 %
/** NSE price bands are 2/5/10/20 %. F&O stocks have none; the simulator just assigns one per symbol. */
export const circuitBandOf = (symbol: string): number => [5, 10, 20, 20][hashStr(symbol + ':band') % 4];

/* ───────────── timeframes (IST-shifted clock) ───────────── */

export const IST_OFFSET = 19800;

type Kind = 'intraday' | 'daily' | 'weekly' | 'monthly';
interface TfConfig {
  kind: Kind;
  /** bar length in seconds (intraday); informational for the rest */
  sec: number;
  bars: number;
  /** per-bar return σ, calibrated to ~30 % annualised volatility */
  sigma: number;
  /** trading days covered by one bar (for volume scaling) */
  days: number;
}

export const TF_CONFIG: Record<Timeframe, TfConfig> = {
  '1m': { kind: 'intraday', sec: 60, bars: 390, sigma: 0.00098, days: 1 / 375 },
  '5m': { kind: 'intraday', sec: 300, bars: 300, sigma: 0.0022, days: 1 / 75 },
  '15m': { kind: 'intraday', sec: 900, bars: 300, sigma: 0.0038, days: 1 / 25 },
  '1h': { kind: 'intraday', sec: 3600, bars: 300, sigma: 0.0076, days: 1 / 6.25 },
  '1D': { kind: 'daily', sec: 86400, bars: 260, sigma: 0.019, days: 1 },
  '1W': { kind: 'weekly', sec: 7 * 86400, bars: 156, sigma: 0.0425, days: 5 },
  '1M': { kind: 'monthly', sec: 30 * 86400, bars: 60, sigma: 0.087, days: 21 },
  '1Y': { kind: 'daily', sec: 86400, bars: 252, sigma: 0.019, days: 1 },
  '5Y': { kind: 'weekly', sec: 7 * 86400, bars: 260, sigma: 0.0425, days: 5 },
  '10Y': { kind: 'monthly', sec: 30 * 86400, bars: 120, sigma: 0.087, days: 21 },
};
export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '1D', '1W', '1M', '1Y', '5Y', '10Y'];
export const isIntraday = (tf: Timeframe) => TF_CONFIG[tf].kind === 'intraday';

const isWeekend = (shiftedSec: number) => {
  const d = new Date(shiftedSec * 1000).getUTCDay();
  return d === 0 || d === 6;
};

/** Start-of-bar timestamp for `nowMs`, in IST-shifted seconds. Daily bars skip weekends; weeks start Monday. */
export function bucketTime(tf: Timeframe, nowMs: number): number {
  const shifted = Math.floor(nowMs / 1000) + IST_OFFSET;
  const cfg = TF_CONFIG[tf];
  switch (cfg.kind) {
    case 'intraday':
      return Math.floor(shifted / cfg.sec) * cfg.sec;
    case 'daily': {
      let t = Math.floor(shifted / 86400) * 86400;
      while (isWeekend(t)) t -= 86400;
      return t;
    }
    case 'weekly': {
      const day = Math.floor(shifted / 86400) * 86400;
      const dow = new Date(day * 1000).getUTCDay(); // 0 = Sun
      return day - ((dow + 6) % 7) * 86400;
    }
    case 'monthly': {
      const d = new Date(shifted * 1000);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    }
  }
}

function prevBucket(tf: Timeframe, t: number): number {
  const cfg = TF_CONFIG[tf];
  switch (cfg.kind) {
    case 'intraday':
      return t - cfg.sec;
    case 'daily': {
      let p = t - 86400;
      while (isWeekend(p)) p -= 86400;
      return p;
    }
    case 'weekly':
      return t - 7 * 86400;
    case 'monthly': {
      const d = new Date(t * 1000);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000;
    }
  }
}

/* ───────────── history with a shared market + sector factor ───────────── */

const factorCache = new Map<string, number[]>();
function factor(key: string, n: number): number[] {
  const k = key + '#' + n;
  let f = factorCache.get(k);
  if (!f) {
    const r = mulberry32(hashStr(key));
    f = Array.from({ length: n }, () => gauss(r));
    factorCache.set(k, f);
  }
  return f;
}

/**
 * Deterministic OHLCV history. Returns share a common market factor (and a sector factor), so
 * cross-symbol Pearson correlations are realistic (~0.25 across sectors, ~0.4 within one).
 */
export function generateHistory(symbol: string, tf: Timeframe, endPrice: number, nowMs: number, sector?: string): Candle[] {
  const cfg = TF_CONFIG[tf];
  const n = cfg.bars;
  const sig = cfg.sigma;
  const rnd = mulberry32(hashStr(symbol + ':' + tf));
  const sec = sector ?? SEED_SECTORS.get(symbol) ?? 'Others';
  const isIndex = sec === 'INDEX';

  const mkt = factor('MKT:' + tf, n);
  const sct = factor('SEC:' + sec + ':' + tf, n);
  const wm = isIndex ? 0.95 : 0.35 + 0.4 * mulberry32(hashStr(symbol + ':beta'))();
  const ws = isIndex ? 0 : 0.35;
  const wi = Math.sqrt(Math.max(0.05, 1 - wm * wm - ws * ws));
  const drift = 0.12 * ((sig * sig) / 0.09); // ~12 % annual drift

  const dayVol = dailyVolume(symbol);
  const barVol = dayVol * cfg.days;

  const times: number[] = new Array(n);
  let t = bucketTime(tf, nowMs);
  for (let i = n - 1; i >= 0; i--) {
    times[i] = t;
    t = prevBucket(tf, t);
  }

  const raw: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const z = wm * mkt[i] + ws * sct[i] + wi * gauss(rnd);
    const c = o * Math.exp(drift + z * sig - 0.5 * sig * sig);
    const hi = Math.max(o, c) * (1 + rnd() * sig * 0.6);
    const lo = Math.min(o, c) * (1 - rnd() * sig * 0.6);
    raw.push({ time: times[i], open: o, high: hi, low: lo, close: c, volume: Math.round(barVol * (0.5 + rnd() * 1.1)) });
    p = c;
  }
  const k = endPrice / raw[n - 1].close;
  return raw.map((b) => ({
    time: b.time,
    open: r2(b.open * k),
    high: r2(b.high * k),
    low: r2(b.low * k),
    close: r2(b.close * k),
    volume: b.volume,
  }));
}

/* ───────────── order-book helpers ───────────── */

export const spreadOf = (ltp: number) => Math.max(TICK, roundTick(ltp * 0.0002));
export function topOfBook(ltp: number): { bid: number; ask: number } {
  const s = spreadOf(ltp);
  const bid = roundTick(ltp - s / 2);
  return { bid, ask: r2(bid + s) };
}

/* ───────────── market hours & feed status ───────────── */

export const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15 IST
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST

/** True during the NSE/BSE cash session: Mon–Fri 09:15–15:30 IST. Exchange holidays are NOT modelled. */
export function isMarketOpen(nowMs: number): boolean {
  const d = new Date(nowMs + IST_OFFSET * 1000);
  const dow = d.getUTCDay();
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow >= 1 && dow <= 5 && min >= MARKET_OPEN_MIN && min < MARKET_CLOSE_MIN;
}

/**
 * live       – market open and the SmartAPI relay is streaming
 * simulated  – market open but no feed is connected (random walk; NOT real prices)
 * snapshot   – market closed but the relay is connected and delivering ticks (last-session data, no simulation)
 * replay     – market closed: accelerated replay of the last session's 1-minute returns + random walk
 */
export type FeedMode = 'live' | 'simulated' | 'replay' | 'snapshot';

export const FEED_BADGE: Record<FeedMode, { text: string; title: string; tone: 'down' | 'warn' | 'accent' }> = {
  live: { text: '🔴 LIVE MARKET', title: 'Streaming from Angel One SmartAPI (SmartWebSocketV2)', tone: 'down' },
  replay: { text: '🟡 OFF-MARKET REPLAY', title: 'Market closed (09:15–15:30 IST, Mon–Fri). Prices are a simulated replay.', tone: 'warn' },
  snapshot: { text: '🟡 OFF-MARKET · RELAY DATA', title: 'Market closed (09:15–15:30 IST, Mon–Fri). Showing the last prices delivered by the SmartAPI relay.', tone: 'warn' },
  simulated: { text: '🟠 SIMULATED · FEED OFFLINE', title: 'Market is open but no live feed is connected. Prices are simulated.', tone: 'accent' },
};

/** which upstream the relay is currently using (reported on every tick / heartbeat) */
export type FeedSource = 'angel' | 'yahoo';

export type Health = 'ok' | 'warn' | 'off';

export interface LinkStatus {
  health: Health;
  /** short pill text */
  label: string;
  /** one-sentence explanation shown in the status popover */
  detail: string;
}

/**
 * What the browser can truthfully say about the SmartAPI link. The browser only ever talks to the relay, so "connected"
 * means: relay socket open AND (during market hours) ticks flowing. Credentials themselves are validated by the relay at its
 * start-up; outside market hours an open relay socket is the strongest signal available.
 *   relayConfigured – NEXT_PUBLIC_FEED_WS_URL is set     serverCreds – SMARTAPI_* are also present on the web server
 */
export function smartApiStatus(i: { mode: FeedMode; conn: FeedConn; relayConfigured: boolean; serverCreds?: boolean; source?: FeedSource }): LinkStatus {
  if (!i.relayConfigured) {
    const off = i.mode === 'replay' ? 'Running the off-market simulated replay.' : 'Running the simulated feed.';
    return i.serverCreds
      ? { health: 'warn', label: 'Relay not linked', detail: `SmartAPI credentials are set on this server, but NEXT_PUBLIC_FEED_WS_URL is not — the browser has no feed to connect to. ${off}` }
      : { health: 'off', label: i.mode === 'replay' ? 'Replay' : 'Simulated', detail: `SmartAPI is not configured. ${off}` };
  }
  if (i.conn === 'open') {
    if (i.mode === 'live')
      return { health: 'ok', label: '🟢 LIVE FEED', detail: i.source === 'yahoo' ? 'Relay connected — streaming quotes from the Yahoo Finance fallback (SmartAPI is offline or not configured; may be delayed).' : 'Relay connected and streaming exchange ticks from Angel One SmartAPI.' };
    if (i.mode === 'snapshot') return { health: 'ok', label: 'Relay connected', detail: 'Relay connected and delivering ticks. The market is closed (09:15–15:30 IST, Mon–Fri) — showing the relay\'s last prices, no simulation.' };
    if (i.mode === 'replay') return { health: 'ok', label: 'Relay ready', detail: 'Relay connected. The market is closed (09:15–15:30 IST, Mon–Fri) — showing the off-market replay; live ticks resume at the open.' };
    return { health: 'warn', label: 'No ticks yet', detail: 'Relay connected but no ticks have arrived during market hours — check the relay logs (login / subscription).' };
  }
  if (i.conn === 'closed') return { health: 'warn', label: 'Relay offline', detail: 'The relay socket dropped or could not be reached; retrying with back-off. Prices are simulated meanwhile.' };
  return { health: 'warn', label: 'Connecting…', detail: 'Connecting to the SmartAPI relay…' };
}

/** A decoded market tick (₹ prices). Produced by the relay from SmartWebSocketV2 packets. */
export interface Tick {
  symbol: string;
  ltp: number;
  /** cumulative traded volume for the day */
  volume?: number;
  lastQty?: number;
  avgPrice?: number;
  open?: number;
  high?: number;
  low?: number;
  /** previous close */
  close?: number;
  upperCircuit?: number;
  lowerCircuit?: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
  /** exchange timestamp, epoch ms */
  ts?: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const cleanLevels = (a: unknown): DepthLevel[] =>
  Array.isArray(a) ? a.filter((l) => l && finite(l.price) && finite(l.qty) && l.price > 0).slice(0, 5).map((l) => ({ price: l.price, qty: l.qty, orders: finite(l.orders) ? l.orders : 0 })) : [];

/* ───────────── the engine ───────────── */

interface IndexState extends IndexQuote {
  sigma: number;
}

const INDEX_SEED: { id: string; label: string; prev: number; pct: number; sigma: number }[] = [
  { id: 'NIFTY', label: 'NIFTY 50', prev: 24850.4, pct: 0.41, sigma: 0.00008 },
  { id: 'SENSEX', label: 'SENSEX', prev: 81320.15, pct: 0.38, sigma: 0.00008 },
  { id: 'BANKNIFTY', label: 'BANK NIFTY', prev: 53410.9, pct: -0.25, sigma: 0.0001 },
  { id: 'INDIAVIX', label: 'INDIA VIX', prev: 13.84, pct: 1.12, sigma: 0.0007 },
];

/** Alert thresholds. A "surge" is ≥ SURGE_X × the normal level; price surges also need ≥ MIN_SURGE_MOVE %. */
export const SURGE_X = 3;
const MIN_SURGE_MOVE = 1; // %
const NORMAL_MOVE_60S = 0.12; // % — typical 60 s move used as the price-surge baseline
const ALERT_COOLDOWN_MS = 5 * 60_000;

interface SimEvent {
  symbol: string;
  kind: 'circuit' | 'volume' | 'price';
  dir: 1 | -1;
  left: number; // 1 s blocks remaining
}

export class MarketEngine {
  readonly quotes = new Map<string, Quote>();
  readonly indices: IndexState[];
  readonly master: Map<string, Instrument>;
  depth: OrderBook = { bids: [], asks: [] };
  mcapTrend: number[] = [];
  /** newest first */
  alerts: MarketAlert[] = [];
  /** Inject occasional circuit / surge events so the banner has something to show on a synthetic feed. */
  simulateEvents = true;
  /** where prices come from — see FeedMode */
  mode: FeedMode = 'replay';
  /** true while the selected symbol's depth comes from the exchange rather than the simulator */
  depthReal = false;
  /** epoch ms of the last live tick applied */
  lastLiveTickAt = 0;
  /** symbols whose exchange cumulative volume has been baselined in live mode (the first tick only sets the baseline) */
  private liveSeen = new Set<string>();

  private rnd = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
  private n = 0;
  private selected = '';
  private tickTimes: number[] = [];
  private trades: { t: number; p: number; v: number }[] = [];
  private startedAt = Date.now();
  private samples: number[] = [];
  private bidQty: number[] = [];
  private askQty: number[] = [];

  private secVol = new Map<string, number>();
  private volEwma = new Map<string, number>();
  private snap = new Map<string, { px: number; t: number }>();
  private atLimit = new Set<string>();
  private lastAlert = new Map<string, number>();
  private events: SimEvent[] = [];
  private nextEventAt = Date.now() + 12_000;
  private alertSeq = 1;
  private bars = new Map<string, Candle[]>();
  /** off-market "▶ Replay last session" for one symbol (see startSessionReplay) */
  private session: { symbol: string; bars: { o: number; h: number; l: number; c: number; v: number }[]; startedAt: number; lastPos: number; close: number; real: boolean } | null = null;

  constructor(universe: Instrument[]) {
    this.master = new Map(universe.map((i) => [i.symbol, i]));
    // simulate every sector-tagged (seeded) name; others are created lazily on touch()
    for (const i of universe) if (SEED_SECTORS.has(i.symbol)) this.create(i);
    this.indices = INDEX_SEED.map((s) => {
      const value = s.prev * (1 + s.pct / 100);
      return { id: s.id, label: s.label, prev: s.prev, value, change: value - s.prev, pct: s.pct, sigma: s.sigma };
    });
    this.seedMcapTrend();
  }

  private create(i: Instrument): Quote {
    const prev = basePrice(i.symbol);
    const band = circuitBandOf(i.symbol);
    const rnd = mulberry32(hashStr(i.symbol + ':day'));
    const dayPct = (rnd() - 0.5) * 0.04; // ±2 %
    const upper = roundTick(prev * (1 + band / 100));
    const lower = roundTick(prev * (1 - band / 100));
    const ltp = Math.min(upper, Math.max(lower, roundTick(prev * (1 + dayPct))));
    const vol = Math.round(dailyVolume(i.symbol) * (0.25 + rnd() * 0.4));
    const q: Quote = {
      ...i,
      ltp,
      prevClose: prev,
      open: roundTick(prev * (1 + (rnd() - 0.5) * 0.01)),
      high: roundTick(Math.max(ltp, prev) * (1 + rnd() * 0.006)),
      low: roundTick(Math.min(ltp, prev) * (1 - rnd() * 0.006)),
      volume: vol,
      sumPV: vol * ltp * (1 + (rnd() - 0.5) * 0.002),
      sumV: vol,
      mcapCr: 0,
      dividendYield: dividendYieldOf(i.symbol),
      avgVolume: dailyVolume(i.symbol),
      circuitBand: band,
      upperCircuit: upper,
      lowerCircuit: lower,
    };
    q.mcapCr = q.ltp * sharesCr(i.symbol);
    this.quotes.set(i.symbol, q);
    this.volEwma.set(i.symbol, 1500);
    this.snap.set(i.symbol, { px: q.ltp, t: Date.now() });
    return q;
  }

  /** Make sure a symbol is being simulated and return its quote. */
  touch(symbol: string): Quote | undefined {
    const existing = this.quotes.get(symbol);
    if (existing) return existing;
    const inst = this.master.get(symbol);
    return inst ? this.create({ ...inst, sector: SEED_SECTORS.get(symbol) ?? inst.sector ?? 'Others' }) : undefined;
  }

  totalMcapCr(): number {
    let s = 0;
    this.quotes.forEach((q) => (s += q.mcapCr));
    return s;
  }

  private seedMcapTrend() {
    const total = this.totalMcapCr();
    const rnd = mulberry32(hashStr('mcap-trend'));
    const arr: number[] = [];
    let v = 1;
    for (let i = 0; i < 60; i++) {
      v *= 1 + (rnd() - 0.46) * 0.012;
      arr.push(v);
    }
    const k = total / arr[arr.length - 1];
    this.mcapTrend = arr.map((x) => x * k);
  }

  /** Switch the price source. Live mode stops the random walk and synthetic alert events. */
  setMode(mode: FeedMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // synthetic alert events only make sense for the open-market simulation; a closed market is calm
    this.simulateEvents = mode === 'simulated';
    this.session = null;
    this.depthReal = false;
    this.liveSeen.clear();
    if (mode !== 'live') this.depth = { bids: [], asks: [] };
    this.bidQty = [];
    this.askQty = [];
  }

  /** Apply one exchange tick (live mode). Unknown symbols are ignored. */
  applyTick(t: Tick, now = Date.now()) {
    if (!finite(t.ltp) || t.ltp <= 0) return;
    const q = this.touch(t.symbol);
    if (!q) return;
    this.lastLiveTickAt = now;

    if (finite(t.close) && t.close > 0 && t.close !== q.prevClose) {
      q.prevClose = t.close;
      q.upperCircuit = roundTick(t.close * (1 + q.circuitBand / 100));
      q.lowerCircuit = roundTick(t.close * (1 - q.circuitBand / 100));
    }
    if (finite(t.upperCircuit) && t.upperCircuit > 0) q.upperCircuit = t.upperCircuit;
    if (finite(t.lowerCircuit) && t.lowerCircuit > 0) q.lowerCircuit = t.lowerCircuit;
    if (finite(t.open) && t.open > 0) q.open = t.open;
    q.ltp = t.ltp;
    q.high = finite(t.high) && t.high > 0 ? t.high : Math.max(q.high, t.ltp);
    q.low = finite(t.low) && t.low > 0 ? t.low : Math.min(q.low, t.ltp);

    let dv = 0;
    if (finite(t.volume) && t.volume >= 0) {
      // the first tick per symbol only baselines cumulative volume — diffing against simulated volume would fake a surge
      const first = !this.liveSeen.has(q.symbol);
      dv = first ? 0 : Math.max(0, t.volume - q.volume);
      q.volume = t.volume;
      this.liveSeen.add(q.symbol);
      if (first && !(finite(t.avgPrice) && t.avgPrice > 0)) {
        q.sumV = t.volume;
        q.sumPV = t.volume * t.ltp;
      } else if (finite(t.avgPrice) && t.avgPrice > 0) {
        // exchange ATP is the day's VWAP already
        q.sumV = t.volume;
        q.sumPV = t.avgPrice * t.volume;
      } else {
        q.sumV += dv;
        q.sumPV += dv * t.ltp;
      }
    }
    q.mcapCr = q.ltp * sharesCr(q.symbol);
    this.secVol.set(q.symbol, (this.secVol.get(q.symbol) ?? 0) + dv);
    this.pushBar(q.symbol, t.ltp, dv, t.ts ?? now);

    if (q.symbol === this.selected) {
      const v = dv > 0 ? dv : t.lastQty ?? 0;
      if (v > 0) {
        this.tickTimes.push(now);
        this.trades.push({ t: now, p: t.ltp, v });
      }
      const bids = cleanLevels(t.depth?.bids);
      const asks = cleanLevels(t.depth?.asks);
      if (bids.length && asks.length) {
        this.depth = { bids, asks };
        this.depthReal = true;
      }
    }
  }

  applyIndexTick(id: string, value: number, prev?: number) {
    const ix = this.indices.find((i) => i.id === id);
    if (!ix || !finite(value) || value <= 0) return;
    if (finite(prev) && prev > 0) ix.prev = prev;
    ix.value = value;
    ix.change = value - ix.prev;
    ix.pct = (ix.change / ix.prev) * 100;
  }

  /** 1-minute OHLCV candles built from live ticks (IST-shifted seconds). Volume = Σ tick volume deltas. */
  private pushBar(symbol: string, ltp: number, dv: number, tsMs: number) {
    const time = bucketTime('1m', tsMs);
    let arr = this.bars.get(symbol);
    if (!arr) this.bars.set(symbol, (arr = []));
    const last = arr[arr.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, ltp);
      last.low = Math.min(last.low, ltp);
      last.close = ltp;
      last.volume += dv;
    } else if (!last || time > last.time) {
      arr.push({ time, open: ltp, high: ltp, low: ltp, close: ltp, volume: dv });
      if (arr.length > 800) arr.shift();
    }
  }

  /** Live-built candles aggregated to an intraday timeframe (empty when none have been received). */
  liveBars(symbol: string, tf: Timeframe): Candle[] {
    const src = this.bars.get(symbol);
    if (!src?.length || !isIntraday(tf)) return [];
    const sec = TF_CONFIG[tf].sec;
    const out: Candle[] = [];
    for (const c of src) {
      const time = Math.floor(c.time / sec) * sec;
      const last = out[out.length - 1];
      if (last && last.time === time) {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
        last.volume += c.volume;
      } else out.push({ ...c, time });
    }
    return out;
  }

  /** Trades of the selected symbol in the last `windowMs` (for VWAP bands, tick histogram). */
  recentTrades(windowMs: number, now = Date.now()): { t: number; p: number; v: number }[] {
    const cutoff = now - windowMs;
    const out: { t: number; p: number; v: number }[] = [];
    for (let i = this.trades.length - 1; i >= 0; i--) {
      if (this.trades[i].t < cutoff) break;
      out.push(this.trades[i]);
    }
    return out.reverse();
  }

  /** Last `n` price samples (250 ms apart) of the selected symbol. */
  priceSamples(n = 240): number[] {
    return this.samples.slice(-n);
  }

  /** symbol currently being replayed (null = none) and whether the bars are real exchange bars */
  get replaying(): { symbol: string; real: boolean; progress: number } | null {
    const r = this.session;
    return r ? { symbol: r.symbol, real: r.real, progress: Math.min(1, r.lastPos / r.bars.length) } : null;
  }

  /**
   * Off-market only. Replays the previous session of `symbol` at one 1-minute bar per second: price walks open → low/high → close
   * along each bar's own OHLC (no random ticks), volume accumulates from the bar volumes, then rests at the close.
   * `realBars` = actual previous-session 1-minute bars (e.g. Yahoo via /api/session) — scaled so the final close equals the quote's
   * resting price; without them the deterministic synthetic 1-minute series is used.
   */
  startSessionReplay(symbol: string, realBars?: { open: number; high: number; low: number; close: number; volume: number }[], now = Date.now()): boolean {
    if (this.mode === 'live') return false;
    const q = this.touch(symbol);
    if (!q) return false;
    const close = q.ltp;
    const real = !!realBars && realBars.length >= 30;
    const src = real ? realBars! : generateHistory(symbol, '1m', close, now, q.sector).slice(-375);
    const k = close / src[src.length - 1].close;
    const bars = src.map((b) => ({ o: b.open * k, h: b.high * k, l: b.low * k, c: b.close * k, v: b.volume }));
    this.session = { symbol, bars, startedAt: now, lastPos: 0, close, real };
    const o = Math.min(q.upperCircuit, Math.max(q.lowerCircuit, roundTick(bars[0].o)));
    q.ltp = o;
    q.open = o;
    q.high = o;
    q.low = o;
    q.volume = 0;
    q.sumV = 0;
    q.sumPV = 0;
    q.mcapCr = q.ltp * sharesCr(symbol);
    return true;
  }

  stopSessionReplay() {
    const r = this.session;
    if (!r) return;
    const q = this.quotes.get(r.symbol);
    if (q) this.setPrice(q, r.close, 0);
    this.session = null;
  }

  /** Closed market: nothing trades. The selected symbol only moves while a session replay is running. */
  private stepClosed(sel: Quote | undefined, now: number) {
    const r = this.session;
    if (r && sel && r.symbol === sel.symbol) {
      const pos = (now - r.startedAt) / MarketEngine.SESSION_BAR_MS;
      if (pos >= r.bars.length) {
        this.setPrice(sel, r.close, 0);
        this.session = null;
      } else {
        const i = Math.floor(pos);
        const f = pos - i;
        const b = r.bars[i];
        const [a1, a2] = b.c >= b.o ? [b.l, b.h] : [b.h, b.l]; // bullish bar: dips first, then rallies
        const px = f < 1 / 3 ? b.o + (a1 - b.o) * (f * 3) : f < 2 / 3 ? a1 + (a2 - a1) * ((f - 1 / 3) * 3) : a2 + (b.c - a2) * ((f - 2 / 3) * 3);
        const vol = Math.max(0, Math.round(((pos - r.lastPos) * b.v) || 0));
        r.lastPos = pos;
        this.setPrice(sel, px, vol);
        this.tickTimes.push(now);
        if (vol > 0) this.trades.push({ t: now, p: sel.ltp, v: vol });
        this.updateDepth(sel);
      }
    } else if (sel && this.depth.bids.length === 0) {
      this.updateDepth(sel); // build the (static) book once; the spread then stays calm
    }
    if (sel) {
      this.samples.push(sel.ltp);
      if (this.samples.length > 240) this.samples.shift();
      if (this.tickTimes.length > 4000) this.tickTimes = this.tickTimes.filter((t) => now - t <= 60000);
      if (this.trades.length > 6000) this.trades = this.trades.filter((t) => now - t.t <= 10 * 60_000);
    }
    if (this.n % 4 === 0) {
      this.mcapTrend[this.mcapTrend.length - 1] = this.totalMcapCr();
      this.detectAlerts(now);
    }
    if (this.n % 240 === 0) {
      this.mcapTrend.push(this.totalMcapCr());
      if (this.mcapTrend.length > 60) this.mcapTrend.shift();
    }
  }

  static readonly SESSION_BAR_MS = 1000;

  /** realised volatility of the selected symbol, annualised, % (null until enough samples) */
  realisedVol(): number | null {
    const s = this.samples;
    if (s.length < 20) return null;
    const rets: number[] = [];
    for (let i = 1; i < s.length; i++) rets.push(Math.log(s[i] / s[i - 1]));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    return sd * Math.sqrt(4 * 22500 * 252) * 100; // 4 samples/s, 6.25 h session
  }

  ticksPerMin(): number {
    const now = Date.now();
    const elapsed = Math.min(60000, Math.max(5000, now - this.startedAt));
    const inWindow = this.tickTimes.filter((t) => now - t <= 60000).length;
    return Math.round((inWindow * 60000) / elapsed);
  }

  /** Rolling VWAP = Σ(P·V) / ΣV over the last `windowMs` of the selected symbol's trades. */
  rollingVwap(windowMs = 5 * 60_000): number | null {
    const cutoff = Date.now() - windowMs;
    let pv = 0;
    let v = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i];
      if (t.t < cutoff) break;
      pv += t.p * t.v;
      v += t.v;
    }
    return v > 0 ? pv / v : null;
  }

  /** Advance the simulation by one 250 ms step. */
  step(selected: string, now: number) {
    if (selected !== this.selected) {
      if (this.session && this.session.symbol !== selected) this.stopSessionReplay(); // leaving the replayed stock → it returns to its close
      this.selected = selected;
      this.tickTimes = [];
      this.trades = [];
      this.samples = [];
      this.startedAt = now;
      this.bidQty = [];
      this.askQty = [];
    }
    const sel = this.touch(selected);
    this.n++;
    const rnd = this.rnd;

    if (this.mode === 'live') {
      // prices arrive through applyTick(); only housekeeping happens here
      if (sel) {
        this.samples.push(sel.ltp);
        if (this.samples.length > 240) this.samples.shift();
        if (this.tickTimes.length > 4000) this.tickTimes = this.tickTimes.filter((t) => now - t <= 60000);
        if (this.trades.length > 6000) this.trades = this.trades.filter((t) => now - t.t <= 10 * 60_000);
      }
      if (this.n % 4 === 0) {
        this.mcapTrend[this.mcapTrend.length - 1] = this.totalMcapCr();
        this.detectAlerts(now);
      }
      if (this.n % 240 === 0) {
        this.mcapTrend.push(this.totalMcapCr());
        if (this.mcapTrend.length > 60) this.mcapTrend.shift();
      }
      return;
    }

    if (this.mode === 'replay') {
      this.stepClosed(sel, now);
      return;
    }

    if (sel) {
    const k = Math.floor(rnd() * 4); // 0–3 trades this step
      for (let j = 0; j < k; j++) {
        const v = 1 + Math.floor(rnd() * 400);
        this.move(sel, 0.00004, v);
        this.tickTimes.push(now);
        this.trades.push({ t: now, p: sel.ltp, v });
      }
      this.samples.push(sel.ltp);
      if (this.samples.length > 240) this.samples.shift();
      if (this.tickTimes.length > 4000) this.tickTimes = this.tickTimes.filter((t) => now - t <= 60000);
      if (this.trades.length > 6000) this.trades = this.trades.filter((t) => now - t.t <= 10 * 60_000);
      this.updateDepth(sel);
    }

    if (this.n % 4 === 0) {
      this.quotes.forEach((q) => {
        if (q.symbol !== selected) this.move(q, 0.00014, 1 + Math.floor(rnd() * 3000));
      });
      for (const ix of this.indices) {
        ix.value = Math.max(0.01, ix.value * (1 + gauss(rnd) * ix.sigma));
        ix.change = ix.value - ix.prev;
        ix.pct = (ix.change / ix.prev) * 100;
      }
      this.mcapTrend[this.mcapTrend.length - 1] = this.totalMcapCr();
      if (this.simulateEvents) this.runEvents(now);
      this.detectAlerts(now);
    }
    if (this.n % 240 === 0) {
      this.mcapTrend.push(this.totalMcapCr());
      if (this.mcapTrend.length > 60) this.mcapTrend.shift();
    }
  }

  private move(q: Quote, sigma: number, vol: number, drift = 0) {
    const pct = (q.ltp / q.prevClose - 1) * 100;
    const pull = -Math.sign(pct) * Math.max(0, Math.abs(pct) - 8) * 0.0004; // soft ±8 % band
    this.setPrice(q, q.ltp * (1 + gauss(this.rnd) * sigma + pull + drift), vol);
  }

  /** Apply a price (clamped to the circuit band, tick-rounded) and its volume to a quote's day statistics. */
  private setPrice(q: Quote, raw: number, vol: number) {
    q.ltp = Math.min(q.upperCircuit, Math.max(q.lowerCircuit, Math.max(TICK, roundTick(raw))));
    if (q.ltp > q.high) q.high = q.ltp;
    if (q.ltp < q.low) q.low = q.ltp;
    q.volume += vol;
    q.sumV += vol;
    q.sumPV += vol * q.ltp;
    q.mcapCr = q.ltp * sharesCr(q.symbol);
    this.secVol.set(q.symbol, (this.secVol.get(q.symbol) ?? 0) + vol);
  }

  /* ── synthetic events (simulation only) ── */
  private runEvents(now: number) {
    if (now >= this.nextEventAt) {
      const pool = Array.from(this.quotes.keys()).filter((s) => s !== this.selected);
      if (pool.length) {
        const symbol = pool[Math.floor(this.rnd() * pool.length)];
        const r = this.rnd();
        const kind: SimEvent['kind'] = r < 0.4 ? 'circuit' : r < 0.7 ? 'volume' : 'price';
        this.events.push({ symbol, kind, dir: this.rnd() < 0.5 ? 1 : -1, left: kind === 'circuit' ? 60 : 8 });
      }
      this.nextEventAt = now + 35_000 + this.rnd() * 35_000;
    }
    this.events = this.events.filter((e) => {
      const q = this.quotes.get(e.symbol);
      if (!q) return false;
      if (e.kind === 'volume') this.move(q, 0.00014, 9000 + Math.floor(this.rnd() * 6000));
      else if (e.kind === 'price') this.move(q, 0.00014, 2000, e.dir * 0.0022);
      else {
        this.move(q, 0.00014, 4000, e.dir * (q.circuitBand / 100 / 9));
        if (q.ltp >= q.upperCircuit || q.ltp <= q.lowerCircuit) return false;
      }
      return --e.left > 0;
    });
  }

  /* ── alert detection: circuit limits, ≥3× volume, ≥3× price move ── */
  private emit(kind: AlertKind, q: Quote, value: number, message: string, now: number) {
    const key = q.symbol + ':' + kind;
    if (now - (this.lastAlert.get(key) ?? 0) < ALERT_COOLDOWN_MS) return;
    this.lastAlert.set(key, now);
    this.alerts = [{ id: this.alertSeq++, kind, symbol: q.symbol, time: now, value, message }, ...this.alerts].slice(0, 30);
  }

  private detectAlerts(now: number) {
    this.quotes.forEach((q) => {
      const s = q.symbol;
      const pct = (q.ltp / q.prevClose - 1) * 100;

      // circuit limits (fire once per touch; re-arm after the price leaves the limit)
      const up = q.ltp >= q.upperCircuit;
      const lo = q.ltp <= q.lowerCircuit;
      if (up || lo) {
        if (!this.atLimit.has(s)) {
          this.atLimit.add(s);
          this.emit(up ? 'UPPER_CIRCUIT' : 'LOWER_CIRCUIT', q, pct, `${s} hit ${up ? 'upper' : 'lower'} circuit (${q.circuitBand}% band) at ₹${q.ltp.toFixed(2)}`, now);
        }
      } else this.atLimit.delete(s);

      // volume: last second vs. EWMA baseline
      const v = this.secVol.get(s) ?? 0;
      const base = this.volEwma.get(s) ?? 1500;
      if (v > SURGE_X * base && v > 3000) this.emit('VOLUME_SURGE', q, v / base, `${s} volume running ${(v / base).toFixed(1)}× normal`, now);
      this.volEwma.set(s, base * 0.95 + v * 0.05);
      this.secVol.set(s, 0);

      // price: 60 s move vs. normal 60 s move
      const sn = this.snap.get(s);
      if (sn && now - sn.t >= 60_000) {
        if (this.mode === 'replay' && s === this.selected) {
          this.snap.set(s, { px: q.ltp, t: now }); // replay runs ~60× faster than real time; a 60 s move there isn't a surge
          return;
        }
        const mv = (q.ltp / sn.px - 1) * 100;
        const ratio = Math.abs(mv) / NORMAL_MOVE_60S;
        if (ratio >= SURGE_X && Math.abs(mv) >= MIN_SURGE_MOVE) {
          this.emit('PRICE_SURGE', q, ratio, `${s} ${mv > 0 ? 'surged' : 'dropped'} ${Math.abs(mv).toFixed(2)}% in 60s (${ratio.toFixed(0)}× normal)`, now);
        }
        this.snap.set(s, { px: q.ltp, t: now });
      }
    });
  }

  private updateDepth(q: Quote) {
    const rnd = this.rnd;
    if (this.bidQty.length === 0) {
      for (let i = 0; i < 5; i++) {
        this.bidQty.push(Math.round(80 + rnd() * 2200));
        this.askQty.push(Math.round(80 + rnd() * 2200));
      }
    } else if (rnd() < 0.7) {
      const side = rnd() < 0.5 ? this.bidQty : this.askQty;
      const i = Math.floor(rnd() * 5);
      side[i] = Math.max(20, Math.round(side[i] * (1 + gauss(rnd) * 0.25)));
    }
    const { bid, ask } = topOfBook(q.ltp);
    const bids = [];
    const asks = [];
    for (let i = 0; i < 5; i++) {
      bids.push({ price: r2(bid - i * TICK * (1 + (i > 1 ? 1 : 0))), qty: this.bidQty[i], orders: 1 + Math.floor(this.bidQty[i] / 180) });
      asks.push({ price: r2(ask + i * TICK * (1 + (i > 1 ? 1 : 0))), qty: this.askQty[i], orders: 1 + Math.floor(this.askQty[i] / 180) });
    }
    this.depth = { bids, asks };
  }
}

/* ───────────── Angel One SmartAPI feed adapter ───────────── */

export type FeedConn = 'idle' | 'connecting' | 'open' | 'closed';

/**
 * Browser adapter for the SmartAPI relay (scripts/angel-relay.ts).
 *
 * Browsers cannot set the auth headers SmartWebSocketV2 requires and must never hold the API key / password / TOTP
 * secret, so the relay logs in server-side, subscribes via SmartWebSocketV2, decodes the binary packets and forwards
 * them here as JSON:
 *   → { t: 'sub', symbols: string[] }                       (client → relay)
 *   ← { t: 'tick', symbol, ltp, volume, open, high, low, close, avgPrice, depth, ts, … }
 *   ← { t: 'index', id, value, prev }
 *   ← { t: 'hb' }                                          (heartbeat, every ~15 s)
 */
export class SmartApiFeed {
  status: FeedConn = 'idle';
  ticks = 0;
  lastMessageAt = 0;
  /** last time a price tick / index tick arrived (heartbeats don't count) */
  lastTickAt = 0;
  /** upstream reported by the relay (angel | yahoo); undefined until the first tagged message */
  source: FeedSource | undefined;

  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private wanted = new Set<string>();
  private sent = new Set<string>();
  private stopped = false;

  constructor(
    private url: string,
    private engine: MarketEngine,
    private onStatus: (s: FeedConn) => void = () => {},
    private WS: typeof WebSocket | undefined = typeof WebSocket !== 'undefined' ? WebSocket : undefined,
  ) {}

  private set(s: FeedConn) {
    if (this.status !== s) {
      this.status = s;
      this.onStatus(s);
    }
  }

  connect() {
    if (!this.WS || this.stopped || this.ws) return;
    this.set('connecting');
    let ws: WebSocket;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.ticks = 0;
      this.lastMessageAt = Date.now();
      this.sent.clear();
      this.set('open');
      this.flushSubs();
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      if (typeof ev.data === 'string') this.handle(ev.data);
    };
    ws.onclose = () => {
      this.ws = null;
      this.set('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
    if (!this.watchdog) {
      // a silent socket (no tick or heartbeat for 45 s) is treated as dead
      this.watchdog = setInterval(() => {
        if (this.ws && this.status === 'open' && Date.now() - this.lastMessageAt > 45_000) this.ws.close();
      }, 10_000);
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  /** Declare which symbols the UI needs; only the diff is sent to the relay. */
  setSymbols(symbols: Iterable<string>) {
    this.wanted = new Set(symbols);
    this.flushSubs();
  }

  private flushSubs() {
    if (!this.ws || this.status !== 'open') return;
    const fresh = Array.from(this.wanted).filter((s) => !this.sent.has(s));
    if (fresh.length === 0) return;
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      this.ws.send(JSON.stringify({ t: 'sub', symbols: chunk }));
      chunk.forEach((s) => this.sent.add(s));
    }
  }

  private handle(raw: string) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.src === 'angel' || m.src === 'yahoo') this.source = m.src;
    if (m.t === 'tick' && typeof m.symbol === 'string' && m.symbol.length <= 24 && finite(m.ltp)) {
      this.ticks++;
      this.lastTickAt = Date.now();
      this.engine.applyTick(m as unknown as Tick);
    } else if (m.t === 'index' && typeof m.id === 'string' && finite(m.value)) {
      this.lastTickAt = Date.now();
      this.engine.applyIndexTick(m.id, m.value, finite(m.prev) ? m.prev : undefined);
    }
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = this.watchdog = null;
    this.ws?.close();
    this.ws = null;
    this.set('idle');
  }
}

/**
 * Candles for an index chart. Indices carry no tick depth / volume, so the series is synthesised (deterministic, anchored
 * to the live value). Never throws and never returns malformed bars: a missing / non-finite value falls back to the
 * previous close, and any invalid OHLC bar is repaired — so the chart always has something valid to draw.
 */
export function indexHistory(label: string, tf: Timeframe, value: number, fallbackPrev: number, nowMs: number): Candle[] {
  const end = Number.isFinite(value) && value > 0 ? value : Number.isFinite(fallbackPrev) && fallbackPrev > 0 ? fallbackPrev : 100;
  let bars: Candle[] = [];
  try {
    bars = generateHistory(label, tf, end, nowMs, 'INDEX');
  } catch {
    bars = [];
  }
  const ok = (c: Candle) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.open > 0 && c.close > 0;
  if (bars.length === 0 || !bars.every(ok)) {
    // minimal random-walk fallback
    const rnd = mulberry32(hashStr(label + ':fb:' + tf));
    const n = TF_CONFIG[tf].bars;
    const times: number[] = new Array(n);
    let t = bucketTime(tf, nowMs);
    for (let i = n - 1; i >= 0; i--) {
      times[i] = t;
      t = prevBucket(tf, t);
    }
    let p = end;
    const rev: Candle[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const c = p;
      const o = c / (1 + (rnd() - 0.5) * 2 * TF_CONFIG[tf].sigma);
      rev.push({ time: times[i], open: r2(o), high: r2(Math.max(o, c) * (1 + rnd() * TF_CONFIG[tf].sigma * 0.4)), low: r2(Math.min(o, c) * (1 - rnd() * TF_CONFIG[tf].sigma * 0.4)), close: r2(c), volume: 0 });
      p = o;
    }
    bars = rev.reverse();
  }
  // enforce high ≥ max(o,c), low ≤ min(o,c), no volume for indices
  return bars.map((c) => ({ ...c, high: Math.max(c.high, c.open, c.close), low: Math.min(c.low, c.open, c.close), volume: 0 }));
}
