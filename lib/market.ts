import type { AlertKind, Candle, DepthLevel, IndexQuote, Instrument, MarketAlert, OrderBook, Quote, Timeframe } from './types';
import { aggregateSectors, type SectorStat } from './sectors';
import { SEED_SECTORS } from './instruments';
import { CircuitTracker, circuitHit, limitPrice } from './circuit';
import type { YahooRow } from './yahooData';

/* ───────────── price helpers ───────────── */

export const TICK = 0.05;
export const roundTick = (p: number): number => Math.round(p / TICK) * TICK;

/* ───────────── timeframes (IST-shifted clock) ───────────── */

export const IST_OFFSET = 19800;

type Kind = 'intraday' | 'daily' | 'weekly' | 'monthly';
interface TfConfig {
  kind: Kind;
  /** bar length in seconds (intraday); informational for the rest */
  sec: number;
  /** how many bars the chart keeps */
  bars: number;
}

export const TF_CONFIG: Record<Timeframe, TfConfig> = {
  '1m': { kind: 'intraday', sec: 60, bars: 390 },
  '5m': { kind: 'intraday', sec: 300, bars: 300 },
  '15m': { kind: 'intraday', sec: 900, bars: 300 },
  '1h': { kind: 'intraday', sec: 3600, bars: 300 },
  '1D': { kind: 'daily', sec: 86400, bars: 260 },
  '1W': { kind: 'weekly', sec: 7 * 86400, bars: 156 },
  '1M': { kind: 'monthly', sec: 30 * 86400, bars: 60 },
  '1Y': { kind: 'daily', sec: 86400, bars: 252 },
  '5Y': { kind: 'weekly', sec: 7 * 86400, bars: 260 },
  '10Y': { kind: 'monthly', sec: 30 * 86400, bars: 120 },
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

/** The window in which the browser keeps the SmartAPI socket open: 15 min either side of the session (pre-open … post-close), Mon–Fri. */
export const isStreamWindow = (nowMs: number): boolean => isMarketOpen(nowMs + 15 * 60_000) || isMarketOpen(nowMs - 15 * 60_000);

/**
 * live     – market open and the browser's direct SmartAPI socket is streaming exchange ticks
 * snapshot – market closed, the SmartAPI socket is connected and delivering its last prices
 * delayed  – REAL delayed quotes + bars polled from Yahoo Finance (the default; nothing is simulated)
 */
export type FeedMode = 'live' | 'snapshot' | 'delayed';

export const FEED_BADGE: Record<FeedMode, { text: string; title: string; tone: 'down' | 'warn' | 'accent' }> = {
  live: { text: '● SMARTAPI LIVE', title: 'Streaming live ticks directly from Angel One SmartAPI (SmartWebSocketV2) to this browser.', tone: 'down' },
  snapshot: { text: '● SESSION PAUSED (MARKET CLOSED)', title: 'NSE/BSE markets are closed. Showing verified closing session prices. Live feed auto-connects at 09:15 AM IST.', tone: 'warn' },
  delayed: { text: '● SESSION PAUSED (MARKET CLOSED)', title: 'NSE/BSE markets are closed. Showing verified closing session prices. Live feed auto-connects at 09:15 AM IST.', tone: 'accent' },
};

/** While the market is open but the live stream is not in use, the fallback data is up to ~15 min old — say so instead of claiming "last close". */
export function feedBadge(mode: FeedMode, marketOpen: boolean) {
  if (mode === 'delayed' && marketOpen) return { text: '● DELAYED SESSION', title: 'SmartAPI live stream is not in use right now. Showing real NSE session prices, which may lag the exchange; live ticks take over automatically once the stream connects.', tone: 'accent' as const };
  return FEED_BADGE[mode];
}

export type Health = 'ok' | 'warn' | 'off';

export interface LinkStatus {
  health: Health;
  /** short pill text */
  label: string;
  /** one-sentence explanation shown in the status popover */
  detail: string;
}

/** Why the live SmartAPI stream is not in use (the app then shows delayed session data). */
export type LiveReason = 'no_key' | 'unauthorized' | 'not_configured' | 'login_failed' | 'rate_limited' | 'unreachable' | 'stream_failed' | 'outside_hours';

const REASON: Record<LiveReason, string> = {
  no_key: 'NEXT_PUBLIC_SMARTAPI_API_KEY is not set (build-time variable), so the browser cannot open the SmartAPI socket.',
  unauthorized: 'The live feed needs a signed-in Supabase account (the feed token is only issued to verified users).',
  not_configured: 'SMARTAPI_API_KEY, SMARTAPI_CLIENT_CODE, SMARTAPI_PASSWORD and SMARTAPI_TOTP_SECRET are not all set on the server.',
  login_failed: 'SmartAPI rejected the server-side login (check the client code, password and TOTP secret).',
  rate_limited: 'The session endpoint is throttled — retrying shortly.',
  unreachable: 'SmartAPI could not be reached from the server.',
  stream_failed: 'The SmartAPI socket failed after 3 reconnect attempts and a fresh session.',
  outside_hours: 'Outside the streaming window (09:00–15:45 IST, Mon–Fri) — SmartAPI connects automatically when the market is about to open.',
};

/**
 * What the browser can truthfully say about the market feed. The browser opens the SmartAPI socket itself (tokens come from /api/smartapi/session),
 * so "live" means the socket is open AND ticks are flowing. In every other case the app shows real, delayed NSE session data.
 */
export function smartApiStatus(i: { mode: FeedMode; conn: FeedConn; reason?: LiveReason }): LinkStatus {
  const yahoo = 'Showing verified NSE session prices (nothing is simulated); live ticks take over automatically when the stream connects.';
  if (i.conn === 'open') {
    if (i.mode === 'live') return { health: 'ok', label: '● SMARTAPI LIVE', detail: 'Connected directly to Angel One SmartAPI and streaming exchange ticks.' };
    if (i.mode === 'snapshot') return { health: 'ok', label: 'SmartAPI connected', detail: "SmartAPI is connected. The market is closed (09:15–15:30 IST, Mon–Fri) — showing its last prices." };
    return { health: 'ok', label: 'SmartAPI connected', detail: `SmartAPI is connected but no ticks have arrived yet. ${yahoo} Live ticks take over once they flow.` };
  }
  if (i.conn === 'connecting') return { health: 'warn', label: 'Connecting…', detail: `Connecting to SmartAPI… ${yahoo}` };
  const why = i.reason ? `${REASON[i.reason]} ` : '';
  return { health: i.reason === 'outside_hours' || i.reason === 'no_key' || i.reason === 'not_configured' ? 'off' : 'warn', label: 'Offline session', detail: `${why}${yahoo}` };
}

/** A decoded market tick (₹ prices). Produced by lib/smartapiDirect.ts from SmartWebSocketV2 packets. */
/** one applied tick as seen by `engine.onTick` listeners (index ticks use the engine index id, e.g. NIFTY) */
export interface TickEvent { symbol: string; ltp: number; volume: number; ts: number }

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
// REAL data only. Prices, volume, day range and bars come from Yahoo Finance (delayed) via /api/quotes + /api/bars, or from SmartAPI ticks
// streamed directly from SmartAPI. There are no random numbers in here: a symbol with no data is simply absent (touch() → undefined).

const INDEX_META: { id: string; label: string }[] = [
  { id: 'NIFTY', label: 'NIFTY 50' },
  { id: 'SENSEX', label: 'SENSEX' },
  { id: 'BANKNIFTY', label: 'BANK NIFTY' },
  { id: 'INDIAVIX', label: 'INDIA VIX' },
];

/** Alert thresholds (live ticks only). A "surge" is ≥ SURGE_X × the normal level; price surges also need ≥ MIN_SURGE_MOVE %. */
export const SURGE_X = 3;
const MIN_SURGE_MOVE = 1; // %
const NORMAL_MOVE_60S = 0.12; // % — typical 60 s move used as the price-surge baseline
const ALERT_COOLDOWN_MS = 5 * 60_000;
const istDay = (shiftedSec: number) => Math.floor(shiftedSec / 86400);

export class MarketEngine {
  readonly quotes = new Map<string, Quote>();
  readonly indices: IndexQuote[];
  readonly master: Map<string, Instrument>;
  /** exchange depth from SmartAPI; stays empty on Yahoo data (Yahoo has no order book) */
  depth: OrderBook = { bids: [], asks: [] };
  /** total market cap of the loaded quotes, one point per Yahoo batch (newest last) */
  mcapTrend: number[] = [];
  /** newest first */
  alerts: MarketAlert[] = [];
  /** where prices come from — see FeedMode */
  mode: FeedMode = 'delayed';
  /** true while the selected symbol's depth comes from the exchange */
  depthReal = false;
  /** epoch ms of the last live tick applied */
  lastLiveTickAt = 0;
  /** feed telemetry (live mode): arrival times of the last 10 s of ticks, a running delay average (exchange timestamp → browser), total ticks */
  private tickWindow: number[] = [];
  private delayEma: number | null = null;
  tickTotal = 0;
  /** epoch ms of the last Yahoo quote batch applied (0 = nothing loaded yet) */
  lastQuotesAt = 0;
  /** epoch ms of the saved snapshot currently on screen; 0 once a fresh fetch has replaced it (lib/snapshotCache.ts) */
  snapshotAt = 0;
  /** bumps whenever real history arrives, so memoised analytics recompute */
  histVer = 0;

  private liveSeen = new Set<string>();
  private liveAt = new Map<string, number>();
  private shares = new Map<string, number>();
  private hist = new Map<string, Candle[]>();
  private histAt = new Map<string, number>();
  private wantQuotes = new Set<string>();
  private wantHist = new Set<string>();
  private circuits = new CircuitTracker(8000);

  private n = 0;
  private selected = '';
  private tickTimes: number[] = [];
  private trades: { t: number; p: number; v: number }[] = [];
  private startedAt = Date.now();
  private samples: number[] = [];
  /** seconds between price samples: 0.25 on live ticks, 60 when derived from 1-minute bars */
  private sampleSec = 60;
  private secVol = new Map<string, number>();
  private volEwma = new Map<string, number>();
  private snap = new Map<string, { px: number; t: number }>();
  private lastAlert = new Map<string, number>();
  private alertSeq = 1;
  private bars = new Map<string, Candle[]>();

  constructor(universe: Instrument[]) {
    this.master = new Map(universe.map((i) => [i.symbol, i]));
    this.indices = INDEX_META.map((m) => ({ id: m.id, label: m.label, value: 0, prev: 0, change: 0, pct: 0, loaded: false }));
  }

  /** seconds between price samples (0.25 on live ticks, 60 from Yahoo 1-minute bars) */
  get sampleSeconds(): number {
    return this.sampleSec;
  }

  /** at least one real quote has arrived */
  get ready(): boolean {
    return this.quotes.size > 0;
  }

  /** The quote for a symbol, or undefined while Yahoo has not delivered it (the symbol is queued for the next batch). */
  /** zero-delay tick listeners (the chart canvas): called synchronously for every applied exchange tick, before any React batching */
  private tickListeners = new Set<(e: TickEvent) => void>();
  onTick = (fn: (e: TickEvent) => void): (() => void) => {
    this.tickListeners.add(fn);
    return () => void this.tickListeners.delete(fn);
  };
  private emitTick(symbol: string, ltp: number, volume: number, ts: number) {
    for (const fn of this.tickListeners) {
      try { fn({ symbol, ltp, volume, ts }); } catch { /* a faulty listener must never break the feed */ }
    }
  }
  /** total shares (crore) known from the quote provider; undefined until it delivered them */
  sharesOf(symbol: string): number | undefined {
    return this.shares.get(symbol);
  }
  touch(symbol: string): Quote | undefined {
    const q = this.quotes.get(symbol);
    if (!q && this.master.has(symbol)) this.wantQuotes.add(symbol);
    return q;
  }

  /** register interest without reading */
  want(symbols: Iterable<string>) {
    for (const s of symbols) if (this.master.has(s) || this.indices.some((i) => i.id === s)) this.wantQuotes.add(s);
  }
  wantedQuotes(): string[] {
    return Array.from(this.wantQuotes);
  }
  /** history the UI asked for that is missing or older than `maxAgeMs` */
  pendingHistory(now: number, maxAgeMs: number): { symbol: string; tf: Timeframe }[] {
    const out: { symbol: string; tf: Timeframe }[] = [];
    this.wantHist.forEach((k) => {
      const [symbol, tf] = k.split('|');
      if (now - (this.histAt.get(k) ?? 0) > maxAgeMs) out.push({ symbol, tf: tf as Timeframe });
    });
    return out;
  }

  /** live sector heatmap data: equal-weighted average 1D % over every priced stock of each desk (lib/sectors.ts) */
  sectorStats(): SectorStat[] {
    return aggregateSectors(Array.from(this.quotes.values(), (q) => ({ symbol: q.symbol, sector: q.sector, pct: q.prevClose > 0 ? (q.ltp / q.prevClose - 1) * 100 : NaN })));
  }

  totalMcapCr(): number {
    let s = 0;
    this.quotes.forEach((q) => (s += q.mcapCr));
    return s;
  }

  setMode(mode: FeedMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.depthReal = false;
    this.liveSeen.clear();
    if (mode !== 'live') this.depth = { bids: [], asks: [] };
    this.sampleSec = mode === 'live' ? 0.25 : 60;
  }

  /* ── Yahoo (real, delayed) ── */

  /**
   * Hydrate from the previous session's saved REAL snapshot so the terminal can render before the network answers. Only when nothing is
   * loaded yet; stamps quotes with the snapshot time (not now); raises no alerts and does not count as a fresh fetch (`snapshotAt` stays set
   * until `ingestRows` delivers live data).
   */
  ingestSnapshot(rows: YahooRow[], t: number): boolean {
    if (this.ready) return false;
    let any = false;
    for (const r of rows) {
      if (r.isIndex) this.ingestIndex(r);
      else if (this.ingestQuote(r, t)) any = true;
    }
    if (any) this.snapshotAt = t;
    return any;
  }

  /** Current real quotes + loaded indices as rows, for lib/snapshotCache.ts. */
  snapshotRows(): YahooRow[] {
    const out: YahooRow[] = [];
    for (const ix of this.indices) if (ix.loaded && ix.value > 0 && ix.prev > 0) out.push({ symbol: ix.id, ltp: ix.value, prevClose: ix.prev, isIndex: true });
    for (const q of this.quotes.values()) {
      out.push({ symbol: q.symbol, ltp: q.ltp, prevClose: q.prevClose, open: q.open, high: q.high, low: q.low, volume: q.volume, avgVolume: q.avgVolume, mcapCr: q.mcapCr > 0 ? q.mcapCr : undefined, sharesCr: this.shares.get(q.symbol), dividendYield: q.dividendYield, marketTime: q.marketTime });
    }
    return out;
  }

  /** Apply a batch of Yahoo rows. Symbols with fresher SmartAPI ticks keep SmartAPI's price. */
  ingestRows(rows: YahooRow[], now = Date.now()) {
    let any = false;
    for (const r of rows) {
      if (r.isIndex) this.ingestIndex(r);
      else if (this.ingestQuote(r, now)) any = true;
    }
    if (rows.length) this.snapshotAt = 0;
    if (any) {
      this.lastQuotesAt = now;
      this.mcapTrend.push(this.totalMcapCr());
      if (this.mcapTrend.length > 60) this.mcapTrend.shift();
      this.detectAlerts(now);
    }
  }

  private ingestIndex(r: YahooRow) {
    const ix = this.indices.find((i) => i.id === r.symbol);
    if (!ix || (this.liveAt.get(ix.id) ?? 0) > Date.now() - 60_000) return;
    ix.prev = r.prevClose;
    ix.value = r.ltp;
    ix.change = r.ltp - r.prevClose;
    ix.pct = (ix.change / r.prevClose) * 100;
    ix.loaded = true;
  }

  private ingestQuote(r: YahooRow, now: number): boolean {
    const inst = this.master.get(r.symbol);
    if (!inst || !(r.ltp > 0) || !(r.prevClose > 0)) return false;
    let q = this.quotes.get(r.symbol);
    const fresh = !q;
    if (!q) {
      q = {
        ...inst, sector: SEED_SECTORS.get(inst.symbol) ?? inst.sector ?? 'Others',
        ltp: r.ltp, prevClose: r.prevClose, open: r.open ?? r.ltp, high: r.high ?? r.ltp, low: r.low ?? r.ltp, volume: r.volume ?? 0,
        sumPV: 0, sumV: 0, mcapCr: 0, dividendYield: 0, avgVolume: r.avgVolume ?? 0, circuitBand: 20, upperCircuit: 0, lowerCircuit: 0, bandKnown: false, fetchedAt: now,
      };
      this.quotes.set(r.symbol, q);
    }
    const liveRecently = (this.liveAt.get(q.symbol) ?? 0) > now - 60_000;
    if (!liveRecently) {
      q.ltp = r.ltp;
      q.high = r.high ?? Math.max(q.high, r.ltp);
      q.low = r.low ?? Math.min(q.low, r.ltp);
      if (r.volume !== undefined) q.volume = r.volume;
    }
    if (r.open !== undefined) q.open = r.open;
    if (r.prevClose !== q.prevClose || fresh) {
      q.prevClose = r.prevClose;
      if (!q.bandKnown) {
        q.upperCircuit = limitPrice(r.prevClose, 20, 'upper');
        q.lowerCircuit = limitPrice(r.prevClose, 20, 'lower');
      }
    }
    if (r.avgVolume !== undefined) q.avgVolume = r.avgVolume;
    if (r.dividendYield !== undefined) q.dividendYield = r.dividendYield;
    if (r.sharesCr !== undefined) this.shares.set(q.symbol, r.sharesCr);
    const sh = this.shares.get(q.symbol);
    q.mcapCr = sh ? q.ltp * sh : r.mcapCr ?? q.mcapCr;
    q.fetchedAt = now;
    q.marketTime = r.marketTime;
    return true;
  }

  /** Real OHLCV bars from /api/bars. 1-minute bars also drive the session VWAP and the selected symbol's trade tape. */
  ingestBars(symbol: string, tf: Timeframe, candles: Candle[], now = Date.now()) {
    const key = `${symbol}|${tf}`;
    this.hist.set(key, candles);
    this.histAt.set(key, now);
    this.histVer++;
    if (tf !== '1m' || !candles.length) return;
    const q = this.quotes.get(symbol);
    if (q) {
      const day = istDay(candles[candles.length - 1].time);
      let pv = 0;
      let v = 0;
      for (const c of candles) if (istDay(c.time) === day && c.volume > 0) { pv += ((c.high + c.low + c.close) / 3) * c.volume; v += c.volume; }
      q.sumPV = pv;
      q.sumV = v;
    }
    if (symbol === this.selected) this.loadTape();
  }

  /** trade tape + price samples of the selected symbol from its real 1-minute bars (timestamps stay the bars' own, i.e. delayed) */
  private loadTape() {
    const c = this.hist.get(`${this.selected}|1m`);
    if (!c?.length || this.mode === 'live') return;
    const lastDay = istDay(c[c.length - 1].time);
    const todays = c.filter((b) => istDay(b.time) === lastDay);
    this.trades = todays.map((b) => ({ t: (b.time - IST_OFFSET) * 1000, p: b.close, v: b.volume })).filter((x) => x.v > 0);
    this.tickTimes = todays.map((b) => (b.time - IST_OFFSET) * 1000);
    this.samples = c.slice(-240).map((b) => b.close);
    this.sampleSec = 60;
  }

  /** Real candles for a symbol / index id at a timeframe ([] until Yahoo delivers them; the request is queued). */
  historyOf(symbol: string, tf: Timeframe): Candle[] {
    const key = `${symbol}|${tf}`;
    const h = this.hist.get(key);
    if (!h) this.wantHist.add(key);
    return h ?? [];
  }
  /** Daily closes (≈ 1 year) of a symbol or index id. */
  closes(symbol: string, n = 252): number[] {
    return this.historyOf(symbol, '1Y').map((c) => c.close).slice(-n);
  }

  /* ── SmartAPI ticks (live) ── */

  private noteTick(now: number, exchangeTs?: number) {
    this.tickTotal++;
    this.tickWindow.push(now);
    while (this.tickWindow.length && this.tickWindow[0] < now - 10_000) this.tickWindow.shift();
    if (finite(exchangeTs) && exchangeTs > 0) {
      const d = now - exchangeTs;
      if (d >= 0 && d < 60_000) this.delayEma = this.delayEma === null ? d : this.delayEma * 0.9 + d * 0.1;
    }
  }

  /** measured feed health for the telemetry popover — null where nothing has been measured (never a made-up number) */
  telemetry(now = Date.now()): { ticksPerSec: number | null; delayMs: number | null; ticks: number; lastTickAgoMs: number | null } {
    const recent = this.tickWindow.filter((x) => x >= now - 5_000).length;
    const streaming = this.mode === 'live' && this.lastLiveTickAt > 0;
    return { ticksPerSec: streaming ? recent / 5 : null, delayMs: streaming && this.delayEma !== null ? Math.round(this.delayEma) : null, ticks: this.tickTotal, lastTickAgoMs: this.lastLiveTickAt ? now - this.lastLiveTickAt : null };
  }

  /** Apply one exchange tick (live mode). Symbols Yahoo has not delivered yet need a previous close on the tick to be created. */
  applyTick(t: Tick, now = Date.now()) {
    if (!finite(t.ltp) || t.ltp <= 0) return;
    let q = this.quotes.get(t.symbol);
    if (!q) {
      const prev = finite(t.close) && t.close > 0 ? t.close : 0;
      if (!prev) return this.want([t.symbol]);
      this.ingestQuote({ symbol: t.symbol, ltp: t.ltp, prevClose: prev, open: t.open, high: t.high, low: t.low, volume: t.volume }, now);
      q = this.quotes.get(t.symbol);
      if (!q) return;
    }
    this.lastLiveTickAt = now;
    this.noteTick(now, t.ts);
    this.liveAt.set(q.symbol, now);

    if (finite(t.close) && t.close > 0 && t.close !== q.prevClose) {
      q.prevClose = t.close;
      if (!q.bandKnown) {
        q.upperCircuit = limitPrice(t.close, 20, 'upper');
        q.lowerCircuit = limitPrice(t.close, 20, 'lower');
      }
    }
    if (finite(t.upperCircuit) && t.upperCircuit > 0 && finite(t.lowerCircuit) && t.lowerCircuit > 0) {
      q.upperCircuit = t.upperCircuit;
      q.lowerCircuit = t.lowerCircuit;
      q.bandKnown = true;
      q.circuitBand = Math.round(((t.upperCircuit / q.prevClose) - 1) * 100);
    }
    if (finite(t.open) && t.open > 0) q.open = t.open;
    q.ltp = t.ltp;
    q.high = finite(t.high) && t.high > 0 ? t.high : Math.max(q.high, t.ltp);
    q.low = finite(t.low) && t.low > 0 ? t.low : Math.min(q.low, t.ltp);

    let dv = 0;
    if (finite(t.volume) && t.volume >= 0) {
      const first = !this.liveSeen.has(q.symbol);
      dv = first ? 0 : Math.max(0, t.volume - q.volume);
      q.volume = t.volume;
      this.liveSeen.add(q.symbol);
      if (finite(t.avgPrice) && t.avgPrice > 0) {
        q.sumV = t.volume;
        q.sumPV = t.avgPrice * t.volume; // exchange ATP is the day's VWAP already
      } else if (first) {
        q.sumV = t.volume;
        q.sumPV = t.volume * t.ltp;
      } else {
        q.sumV += dv;
        q.sumPV += dv * t.ltp;
      }
    }
    const sh = this.shares.get(q.symbol);
    if (sh) q.mcapCr = q.ltp * sh;
    this.secVol.set(q.symbol, (this.secVol.get(q.symbol) ?? 0) + dv);
    this.pushBar(q.symbol, t.ltp, dv, t.ts ?? now);
    this.emitTick(q.symbol, q.ltp, q.volume, now);

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

  /**
   * Off-market replay (lib/offmarketSimulation.ts): moves ONLY the displayed LTP. No bar, volume, depth, high/low or live flag is touched,
   * so nothing downstream (alerts, VWAP, charts) treats it as a trade. The caller keeps the price inside the session range ±0.05 %.
   */
  setReplayPrice(symbol: string, ltp: number) {
    const q = this.quotes.get(symbol);
    if (q && finite(ltp) && ltp > 0) q.ltp = ltp;
  }

  /* ── ⚡ Demo Circuit Simulator (lib/offmarketSimulator.ts): temporary, restorable overrides; never real data ── */
  private demoStash = new Map<string, Pick<Quote, 'ltp' | 'high' | 'low' | 'upperCircuit' | 'lowerCircuit' | 'circuitBand' | 'bandKnown'>>();
  get demoActive(): boolean {
    return this.demoStash.size > 0;
  }
  isDemo(symbol: string): boolean {
    return this.demoStash.has(symbol);
  }
  demoSet(symbol: string, ltp: number, limits: { upper: number; lower: number; band: number }, now = Date.now()) {
    const q = this.quotes.get(symbol);
    if (!q || !finite(ltp) || ltp <= 0) return;
    if (!this.demoStash.has(symbol)) this.demoStash.set(symbol, { ltp: q.ltp, high: q.high, low: q.low, upperCircuit: q.upperCircuit, lowerCircuit: q.lowerCircuit, circuitBand: q.circuitBand, bandKnown: q.bandKnown });
    q.ltp = ltp;
    q.high = Math.max(q.high, ltp);
    q.low = Math.min(q.low, ltp);
    q.upperCircuit = limits.upper;
    q.lowerCircuit = limits.lower;
    q.circuitBand = limits.band;
    q.bandKnown = true;
    this.liveAt.set(symbol, now); // stops the Yahoo poll overwriting the demo price
  }
  demoRestore() {
    this.demoStash.forEach((o, s) => {
      const q = this.quotes.get(s);
      if (q) Object.assign(q, o);
      this.liveAt.delete(s);
    });
    this.demoStash.clear();
  }

  applyIndexTick(id: string, value: number, prev?: number) {
    const ix = this.indices.find((i) => i.id === id);
    if (!ix || !finite(value) || value <= 0) return;
    if (finite(prev) && prev > 0) ix.prev = prev;
    if (!(ix.prev > 0)) return;
    this.liveAt.set(id, Date.now());
    ix.value = value;
    ix.change = value - ix.prev;
    ix.pct = (ix.change / ix.prev) * 100;
    ix.loaded = true;
    this.emitTick(id, value, 0, Date.now());
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

  /** Trades of the selected symbol in the `windowMs` ending at the newest trade (live: now). */
  recentTrades(windowMs: number, now = Date.now()): { t: number; p: number; v: number }[] {
    const end = this.mode === 'live' ? now : this.trades[this.trades.length - 1]?.t ?? now;
    const cutoff = end - windowMs;
    const out: { t: number; p: number; v: number }[] = [];
    for (let i = this.trades.length - 1; i >= 0; i--) {
      if (this.trades[i].t < cutoff) break;
      out.push(this.trades[i]);
    }
    return out.reverse();
  }

  /** Last `n` price samples of the selected symbol (live: 250 ms apart; otherwise 1-minute closes). */
  priceSamples(n = 240): number[] {
    return this.samples.slice(-n);
  }

  /** realised volatility of the selected symbol, annualised, % (null until enough samples) */
  realisedVol(): number | null {
    const s = this.samples;
    if (s.length < 20) return null;
    const rets: number[] = [];
    for (let i = 1; i < s.length; i++) rets.push(Math.log(s[i] / s[i - 1]));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    return sd * Math.sqrt((6.25 * 3600 / this.sampleSec) * 252) * 100;
  }

  /** live ticks per minute (0 on Yahoo data — it carries no tick stream) */
  ticksPerMin(): number {
    if (this.mode !== 'live') return 0;
    const now = Date.now();
    const elapsed = Math.min(60000, Math.max(5000, now - this.startedAt));
    const inWindow = this.tickTimes.filter((t) => now - t <= 60000).length;
    return Math.round((inWindow * 60000) / elapsed);
  }

  /** Rolling VWAP = Σ(P·V) / ΣV over the `windowMs` ending at the newest trade of the selected symbol. */
  rollingVwap(windowMs = 5 * 60_000): number | null {
    let pv = 0;
    let v = 0;
    for (const t of this.recentTrades(windowMs)) {
      pv += t.p * t.v;
      v += t.v;
    }
    return v > 0 ? pv / v : null;
  }

  /** Housekeeping every 250 ms. Nothing moves here: prices only change when real data is applied. */
  step(selected: string, now: number) {
    this.n++;
    if (selected !== this.selected) {
      this.selected = selected;
      this.tickTimes = [];
      this.trades = [];
      this.samples = [];
      this.startedAt = now;
      this.want([selected]);
      this.historyOf(selected, '1m');
      this.loadTape();
    }
    if (this.mode === 'live') {
      const sel = this.quotes.get(selected);
      if (sel) {
        this.samples.push(sel.ltp);
        if (this.samples.length > 240) this.samples.shift();
        if (this.tickTimes.length > 4000) this.tickTimes = this.tickTimes.filter((t) => now - t <= 60000);
        if (this.trades.length > 6000) this.trades = this.trades.filter((t) => now - t.t <= 10 * 60_000);
      }
      if (this.n % 4 === 0) {
        this.mcapTrend[Math.max(0, this.mcapTrend.length - 1)] = this.totalMcapCr();
        this.detectAlerts(now);
      }
      if (this.n % 240 === 0) {
        this.mcapTrend.push(this.totalMcapCr());
        if (this.mcapTrend.length > 60) this.mcapTrend.shift();
      }
    }
  }

  /* ── alerts: circuit limits (all modes); volume / price surges from live ticks ── */
  private emit(kind: AlertKind, q: Quote, value: number, message: string, now: number) {
    const key = q.symbol + ':' + kind;
    if (now - (this.lastAlert.get(key) ?? 0) < ALERT_COOLDOWN_MS) return;
    this.lastAlert.set(key, now);
    this.alerts = [{ id: this.alertSeq++, kind, symbol: q.symbol, time: now, value, message }, ...this.alerts].slice(0, 30);
  }

  private detectAlerts(now: number) {
    const live = this.mode === 'live';
    this.quotes.forEach((q) => {
      const s = q.symbol;
      if (this.demoStash.has(s)) return; // demo prices never reach the real alert desk
      const pct = (q.ltp / q.prevClose - 1) * 100;
      const hit = this.circuits.observe(q, now);
      if (hit) this.emit(hit.dir === 'upper' ? 'UPPER_CIRCUIT' : 'LOWER_CIRCUIT', q, pct, `${s} hit ${hit.dir} circuit (${hit.band}% band) at ₹${q.ltp.toFixed(2)}`, now);
      if (!live) return;

      const v = this.secVol.get(s) ?? 0;
      const base = this.volEwma.get(s) ?? 1500;
      if (v > SURGE_X * base && v > 3000) this.emit('VOLUME_SURGE', q, v / base, `${s} volume running ${(v / base).toFixed(1)}× normal`, now);
      this.volEwma.set(s, base * 0.95 + v * 0.05);
      this.secVol.set(s, 0);

      const sn = this.snap.get(s);
      if (!sn) this.snap.set(s, { px: q.ltp, t: now });
      else if (now - sn.t >= 60_000) {
        const mv = (q.ltp / sn.px - 1) * 100;
        const ratio = Math.abs(mv) / NORMAL_MOVE_60S;
        if (ratio >= SURGE_X && Math.abs(mv) >= MIN_SURGE_MOVE) this.emit('PRICE_SURGE', q, ratio, `${s} ${mv > 0 ? 'surged' : 'dropped'} ${Math.abs(mv).toFixed(2)}% in 60s (${ratio.toFixed(0)}× normal)`, now);
        this.snap.set(s, { px: q.ltp, t: now });
      }
    });
  }

  /** symbols currently confirmed at a circuit */
  circuitSymbols(): string[] {
    return this.circuits.active();
  }
}

/* ───────────── Angel One SmartAPI feed adapter ───────────── */

export type FeedConn = 'idle' | 'connecting' | 'open' | 'closed';

