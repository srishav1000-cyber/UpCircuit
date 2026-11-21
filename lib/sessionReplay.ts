// Post-market Historical Session Replay ("Market DVR"): everything here is PURE — it turns one recorded NSE session into precomputed frames
// and moments, and holds the playback clock maths. Nothing in this file touches live quotes, the surveillance engine, the network or the database;
// the API route does the I/O and hands the raw rows / Yahoo body to `assembleReplay`.
import type { SessionBar } from './yahoo';
import type { TickRow } from './offmarketSimulation';
import { BUCKETS, SESSION_CLOSE_MIN, SESSION_OPEN_MIN, windowSurge, type IntradayProfile } from './volumeBaseline';
import { limitPrice, type CircuitDir } from './circuit';

export const IST_OFFSET_S = 19800;
export const SESSION_MINUTES = SESSION_CLOSE_MIN - SESSION_OPEN_MIN;          // 375 (09:15 → 15:30 IST)
export const SESSION_SECONDS = SESSION_MINUTES * 60;                          // 22 500
export const OR_END_MIN = 9 * 60 + 30;                                        // Opening Range = 09:15 – 09:30 IST
export const SURGE_THRESHOLD = 1.8;                                           // R(t) ≥ 1.8 → "surge"
export const CIRCUIT_NEAR_PCT = 2;                                            // within 2 % of the circuit limit
export const MIN_SESSION_BARS = 30;                                           // fewer usable 1-minute bars than this is not a replayable session
export const MIN_RECORDED_MINUTES = 30;                                       // recorded Supabase ticks must cover ≥ this many distinct minutes, else fall through to Yahoo
export const REPLAY_DAYS = 5;

export type ReplayProvenance = 'Supabase Recorded Ticks' | 'Yahoo 1m Intraday Bars' | 'Synthetic Fallback';
export type OrState = 'forming' | 'inside' | 'above' | 'below';
export type MomentKind = 'orb_up' | 'orb_down' | 'surge' | 'vwap_cross_up' | 'vwap_cross_down' | 'circuit_near' | 'circuit_touch';
export type RBasis = 'median-profile' | 'session-average-pace';

export const DEPTH_DISCLOSURE = 'L2 order-book depth heuristics (OBI, walls, add/cancel, spread) need live or recorded depth snapshots. This replay is OHLCV-only, so those signals are N/A here — they are never inferred from candles.';
export const SYNTHETIC_DISCLOSURE = 'SYNTHETIC FALLBACK — a deterministic generated session, NOT market data. Shown only because no recorded or Yahoo data could be loaded.';

export interface ReplayFrame {
  i: number;
  /** bar start, epoch seconds (UTC) */
  t: number;
  /** IST HH:MM */
  time: string;
  open: number; high: number; low: number; close: number;
  /** this minute's volume */
  volume: number;
  /** cumulative day volume at the END of this minute */
  cumVolume: number;
  /** running cumulative VWAP (typical price × volume); null while no volume has traded */
  vwap: number | null;
  orHigh: number | null; orLow: number | null; orState: OrState;
  /** 15-minute volume surge R(t); null = N/A (first 5 min, silent window, no profile) */
  r: number | null;
  /** distance (%) to the NEAREST circuit limit, null = N/A (needs prevClose AND a band) */
  circuitGapPct: number | null;
  circuitSide: CircuitDir | null;
  nearCircuit: boolean;
}
export interface ReplayMoment { i: number; time: string; kind: MomentKind; label: string; detail: string }

export interface ReplaySession {
  symbol: string;
  date: string;
  provenance: ReplayProvenance;
  synthetic: boolean;
  frames: ReplayFrame[];
  moments: ReplayMoment[];
  orHigh: number | null; orLow: number | null;
  prevClose: number | null;
  band: number | null;
  circuit: { upper: number; lower: number } | null;
  rBasis: RBasis;
  availableDates: string[];
  notes: string[];
  depth: 'N/A';
  depthNote: string;
}

/* ───────────────────────────── IST helpers ───────────────────────────── */
export const istDate = (tSec: number): string => new Date((tSec + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
export const istMinute = (tSec: number): number => Math.floor((((tSec + IST_OFFSET_S) % 86400) + 86400) % 86400 / 60);
export const istHHMM = (tSec: number): string => { const m = istMinute(tSec); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
/** epoch seconds of `YYYY-MM-DD HH:MM` IST */
export const istEpoch = (date: string, minuteOfDay: number): number => Date.parse(`${date}T00:00:00Z`) / 1000 - IST_OFFSET_S + minuteOfDay * 60;
export const isReplayDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Last `n` COMPLETED NSE trading days (newest first). Weekday-based: NSE holidays are NOT modelled (Yahoo's own dates win when they differ). Today counts only after 15:30 IST. */
export function lastTradingDays(nowMs: number, n = REPLAY_DAYS): string[] {
  const out: string[] = [];
  const nowS = nowMs / 1000;
  let day = istDate(nowS);
  const done = istMinute(nowS) >= SESSION_CLOSE_MIN;
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const step = (d: string, by: number) => new Date(Date.parse(`${d}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
  if (!(done && dow(day) >= 1 && dow(day) <= 5)) day = step(day, -1);
  while (out.length < n) {
    if (dow(day) >= 1 && dow(day) <= 5) out.push(day);
    day = step(day, -1);
  }
  return out;
}
export const defaultReplayDate = (nowMs: number): string => lastTradingDays(nowMs, 1)[0];

/* ───────────────────────────── sources → 1-minute bars ───────────────────────────── */
/** Keep only bars inside 09:15 ≤ t < 15:30 IST on `date`; sorted, one per minute (the later duplicate wins), non-finite prices dropped. */
export function filterSessionBars(bars: SessionBar[], date: string): SessionBar[] {
  const byMin = new Map<number, SessionBar>();
  for (const b of bars) {
    if (![b.open, b.high, b.low, b.close].every(Number.isFinite) || b.close <= 0) continue;
    if (istDate(b.t) !== date) continue;
    const m = istMinute(b.t);
    if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) continue;
    byMin.set(m, { ...b, volume: Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0 });
  }
  return [...byMin.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}

/** Recorded ticks (cumulative day volume) → 1-minute bars: OHLC from LTP, per-minute volume = increase of cumulative volume. Only minutes that have ticks yield a bar. */
export function ticksToMinuteBars(ticks: TickRow[], date: string): SessionBar[] {
  const rows = ticks.filter((k) => Number.isFinite(k.ltp) && k.ltp > 0 && istDate(k.ts / 1000) === date).sort((a, b) => a.ts - b.ts);
  const groups = new Map<number, TickRow[]>();
  for (const k of rows) {
    const m = istMinute(k.ts / 1000);
    if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) continue;
    const g = groups.get(m) ?? [];
    g.push(k);
    groups.set(m, g);
  }
  const out: SessionBar[] = [];
  let prevCum = 0;
  for (const m of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(m)!;
    const ltps = g.map((k) => k.ltp);
    const cum = Number.isFinite(g[g.length - 1].volume) ? g[g.length - 1].volume : prevCum;
    const vol = Math.max(0, cum - prevCum);
    prevCum = Math.max(prevCum, cum);
    out.push({ t: istEpoch(date, m), open: ltps[0], high: Math.max(...ltps), low: Math.min(...ltps), close: ltps[ltps.length - 1], volume: vol });
  }
  return out;
}

/** Yahoo v8 chart (interval=1m, range=5d) → every session it carries: { date, bars, prevClose } oldest → newest. prevClose = previous listed session's last close (null for the first). */
export function parseYahooSessions(body: unknown): { date: string; bars: SessionBar[]; prevClose: number | null }[] {
  const r = (body as { chart?: { result?: { timestamp?: unknown[]; indicators?: { quote?: Record<string, unknown[]>[] } }[] } })?.chart?.result?.[0];
  const ts = r?.timestamp, q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
  const all: SessionBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i], o = num(q.open?.[i]), h = num(q.high?.[i]), l = num(q.low?.[i]), c = num(q.close?.[i]);
    if (typeof t !== 'number' || o === undefined || h === undefined || l === undefined || c === undefined) continue;
    const v = q.volume?.[i];
    all.push({ t, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: typeof v === 'number' && v > 0 ? v : 0 });
  }
  const dates = [...new Set(all.map((b) => istDate(b.t)))].sort();
  const out: { date: string; bars: SessionBar[]; prevClose: number | null }[] = [];
  let prev: number | null = null;
  for (const d of dates) {
    const bars = filterSessionBars(all.filter((b) => istDate(b.t) === d), d);
    if (bars.length < MIN_SESSION_BARS) continue;
    out.push({ date: d, bars, prevClose: prev });
    prev = bars[bars.length - 1].close;
  }
  return out;
}

/** Deterministic labelled test data (mulberry32 on a string hash): random-walk price, U-shaped volume. NEVER market data. */
export function syntheticBars(symbol: string, date: string): SessionBar[] {
  let h = 1779033703 ^ (symbol + date).length;
  for (const c of symbol + date) { h = Math.imul(h ^ c.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let s = h >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const out: SessionBar[] = [];
  let p = 1000;
  for (let k = 0; k < SESSION_MINUTES; k++) {
    const o = p;
    p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.0016 + (k === 40 ? 0.006 : 0)));
    const u = Math.abs(k - SESSION_MINUTES / 2) / (SESSION_MINUTES / 2);          // 1 at the edges, 0 midday
    const vol = Math.round(8000 * (0.35 + u * u * 1.6) * (0.6 + rnd() * 0.8) * (k >= 150 && k < 165 ? 4 : 1));
    out.push({ t: istEpoch(date, SESSION_OPEN_MIN + k), open: o, high: Math.max(o, p) * (1 + rnd() * 0.0004), low: Math.min(o, p) * (1 - rnd() * 0.0004), close: p, volume: vol });
  }
  return out;
}

/* ───────────────────────────── frames + moments ───────────────────────────── */
/** Session-average-pace profile (volume spread evenly over the 25 fifteen-minute buckets) — the declared fallback when no median profile is supplied. */
export function uniformDayProfile(dayVolume: number): IntradayProfile {
  return { status: 'ok', sessions: 1, cum: Array.from({ length: BUCKETS }, (_, k) => Math.round((dayVolume * (k + 1)) / BUCKETS)) };
}

export interface BuildOpts { prevClose?: number | null; band?: number | null; profile?: IntradayProfile | null }

export function buildFrames(bars: SessionBar[], opts: BuildOpts = {}): { frames: ReplayFrame[]; moments: ReplayMoment[]; orHigh: number | null; orLow: number | null; rBasis: RBasis; circuit: { upper: number; lower: number } | null } {
  const dayVol = bars.reduce((a, b) => a + b.volume, 0);
  const useMedian = !!opts.profile && opts.profile.status === 'ok';
  const profile = useMedian ? opts.profile! : dayVol > 0 ? uniformDayProfile(dayVol) : null;
  const rBasis: RBasis = useMedian ? 'median-profile' : 'session-average-pace';
  const prev = opts.prevClose && opts.prevClose > 0 ? opts.prevClose : null;
  const band = opts.band && opts.band > 0 ? opts.band : null;
  const circuit = prev && band ? { upper: limitPrice(prev, band, 'upper'), lower: limitPrice(prev, band, 'lower') } : null;

  const frames: ReplayFrame[] = [];
  const moments: ReplayMoment[] = [];
  let cum = 0, pv = 0, orH = -Infinity, orL = Infinity;
  let firstUp = false, firstDown = false, surgeOn = false, nearOn = false, touchOn = false, side = 0;
  const ends: number[] = [], cums: number[] = [];                                // bar END (ms) and cumulative volume at it, for the 15-min look-back
  const add = (i: number, time: string, kind: MomentKind, label: string, detail: string) => moments.push({ i, time, kind, label, detail });

  bars.forEach((b, i) => {
    const m = istMinute(b.t);
    cum += b.volume;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    const vwap = cum > 0 ? pv / cum : null;
    const inOr = m < OR_END_MIN;
    if (inOr) { orH = Math.max(orH, b.high); orL = Math.min(orL, b.low); }
    const haveOr = Number.isFinite(orH);
    let orState: OrState = inOr ? 'forming' : !haveOr ? 'inside' : b.close > orH ? 'above' : b.close < orL ? 'below' : 'inside';

    const endMs = (b.t + 60) * 1000;
    ends.push(endMs); cums.push(cum);
    let then = 0;
    for (let k = ends.length - 1; k >= 0; k--) if (ends[k] <= endMs - 15 * 60_000) { then = cums[k]; break; }
    const r = profile ? windowSurge(profile, cum, then, endMs) : null;

    let gap: number | null = null, gside: CircuitDir | null = null, near = false;
    if (circuit) {
      const up = ((circuit.upper - b.close) / circuit.upper) * 100, lo = ((b.close - circuit.lower) / circuit.lower) * 100;
      gap = Math.min(up, lo); gside = up <= lo ? 'upper' : 'lower'; near = gap <= CIRCUIT_NEAR_PCT;
    }
    const f: ReplayFrame = { i, t: b.t, time: istHHMM(b.t), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, cumVolume: cum, vwap, orHigh: haveOr ? orH : null, orLow: haveOr ? orL : null, orState, r, circuitGapPct: gap, circuitSide: gside, nearCircuit: near };
    frames.push(f);

    if (!inOr && haveOr) {
      if (orState === 'above' && !firstUp) { firstUp = true; add(i, f.time, 'orb_up', 'Opening Range breakout ↑', `close ${b.close.toFixed(2)} > OR high ${orH.toFixed(2)}`); }
      if (orState === 'below' && !firstDown) { firstDown = true; add(i, f.time, 'orb_down', 'Opening Range breakdown ↓', `close ${b.close.toFixed(2)} < OR low ${orL.toFixed(2)}`); }
    }
    if (r !== null) {
      if (r >= SURGE_THRESHOLD && !surgeOn) { surgeOn = true; add(i, f.time, 'surge', `Volume surge R(t) = ${r.toFixed(2)}×`, `15-min volume vs ${rBasis === 'median-profile' ? 'median-profile expectation' : 'session-average pace'} (≥ ${SURGE_THRESHOLD})`); }
      else if (r < SURGE_THRESHOLD) surgeOn = false;
    }
    if (vwap !== null && i > 0) {
      const sgn = b.close > vwap ? 1 : b.close < vwap ? -1 : 0;
      if (sgn !== 0) {
        if (side !== 0 && sgn !== side) add(i, f.time, sgn > 0 ? 'vwap_cross_up' : 'vwap_cross_down', sgn > 0 ? 'Crossed above VWAP' : 'Crossed below VWAP', `close ${b.close.toFixed(2)} vs VWAP ${vwap.toFixed(2)}`);
        side = sgn;
      }
    }
    if (circuit) {
      if (near && !nearOn) add(i, f.time, 'circuit_near', `Within ${CIRCUIT_NEAR_PCT}% of ${gside} circuit`, `${gap!.toFixed(2)}% from ${gside === 'upper' ? circuit.upper.toFixed(2) : circuit.lower.toFixed(2)}`);
      nearOn = near;
      const touch = b.high >= circuit.upper || b.low <= circuit.lower;
      if (touch && !touchOn) add(i, f.time, 'circuit_touch', `Touched ${b.high >= circuit.upper ? 'upper' : 'lower'} circuit`, `${b.high >= circuit.upper ? 'high' : 'low'} ${(b.high >= circuit.upper ? b.high : b.low).toFixed(2)} vs limit ${(b.high >= circuit.upper ? circuit.upper : circuit.lower).toFixed(2)}`);
      touchOn = touch;
    }
  });
  return { frames, moments, orHigh: Number.isFinite(orH) ? orH : null, orLow: Number.isFinite(orL) ? orL : null, rBasis, circuit };
}

export interface AssembleInput {
  symbol: string;
  date: string;
  /** persisted ticks of that symbol + IST date; null = store not configured / query failed */
  ticks: TickRow[] | null;
  /** raw Yahoo v8 chart body (interval=1m, range=5d); null = fetch failed */
  yahooBody: unknown | null;
  band?: number | null;
  profile?: IntradayProfile | null;
  /** only the opt-in labelled fallback */
  allowSynthetic?: boolean;
}
export type AssembleResult = { ok: true; session: ReplaySession } | { ok: false; reason: 'no_data'; availableDates: string[]; notes: string[] };

/** Provenance rule: recorded ticks (≥ MIN_RECORDED_MINUTES distinct minutes) → else Yahoo 1-minute bars for that date → else, ONLY if allowed, the labelled synthetic session. */
export function assembleReplay(i: AssembleInput): AssembleResult {
  const notes: string[] = [];
  const sessions = i.yahooBody ? parseYahooSessions(i.yahooBody) : [];
  const availableDates = sessions.map((s) => s.date).reverse();
  const recorded = i.ticks && i.ticks.length ? filterSessionBars(ticksToMinuteBars(i.ticks, i.date), i.date) : [];
  const ySess = sessions.find((s) => s.date === i.date);
  let bars: SessionBar[] = [], prov: ReplayProvenance | null = null, prevClose: number | null = ySess?.prevClose ?? null;
  if (recorded.length >= MIN_RECORDED_MINUTES) {
    bars = recorded; prov = 'Supabase Recorded Ticks';
    if (i.ticks && i.ticks.length) notes.push(`${recorded.length} recorded minute(s); minutes with no persisted tick are absent from the replay.`);
  } else {
    if (recorded.length) notes.push(`Only ${recorded.length} recorded minute(s) for this date (< ${MIN_RECORDED_MINUTES}); used Yahoo 1-minute bars instead.`);
    if (ySess) { bars = ySess.bars; prov = 'Yahoo 1m Intraday Bars'; }
  }
  if (!prov && i.allowSynthetic) { bars = syntheticBars(i.symbol, i.date); prov = 'Synthetic Fallback'; prevClose = null; notes.push(SYNTHETIC_DISCLOSURE); }
  if (!prov) {
    if (!ySess && sessions.length) notes.push(`No Yahoo 1-minute session for ${i.date}; Yahoo carries ${sessions.map((s) => s.date).join(', ')}.`);
    return { ok: false, reason: 'no_data', availableDates, notes };
  }
  const built = buildFrames(bars, { prevClose, band: i.band ?? null, profile: i.profile ?? null });
  if (!prevClose || !i.band) notes.push('Circuit-band proximity is N/A: it needs the previous close and the stock\'s price band (Yahoo carries neither a band nor, for the first listed day, a previous close).');
  notes.push(built.rBasis === 'median-profile' ? 'R(t) uses the 20-session median intraday volume profile.' : 'R(t) uses the session-average pace of this day\'s own volume (no median profile supplied) — a coarser baseline than live R(t).');
  return { ok: true, session: { symbol: i.symbol, date: i.date, provenance: prov, synthetic: prov === 'Synthetic Fallback', frames: built.frames, moments: built.moments, orHigh: built.orHigh, orLow: built.orLow, prevClose, band: i.band ?? null, circuit: built.circuit, rBasis: built.rBasis, availableDates, notes, depth: 'N/A', depthNote: DEPTH_DISCLOSURE } };
}

/* ───────────────────────────── playback clock (pure) ───────────────────────────── */
export interface ReplaySpeed { id: '1x' | '2x' | '4x' | '8x' | '10x' | 'express'; label: string; /** session seconds per wall-clock second */ rate: number }
/** Multiples of real time. Express = the whole 375-minute day in 300 s (≈ 5 min) = 75×. */
export const REPLAY_SPEEDS: ReplaySpeed[] = [
  { id: '1x', label: '1×', rate: 1 }, { id: '2x', label: '2×', rate: 2 }, { id: '4x', label: '4×', rate: 4 }, { id: '8x', label: '8×', rate: 8 }, { id: '10x', label: '10×', rate: 10 },
  { id: 'express', label: '5-Min Express', rate: SESSION_SECONDS / 300 },
];
export const speedById = (id: string): ReplaySpeed => REPLAY_SPEEDS.find((s) => s.id === id) ?? REPLAY_SPEEDS[0];

/** Advance the market clock (seconds since 09:15 IST, 0…SESSION_SECONDS) by `dtMs` of wall time at `speed`. Returns the new clock and whether the end was reached. */
export function advanceClock(clockS: number, dtMs: number, speed: ReplaySpeed): { clock: number; done: boolean } {
  const c = Math.min(SESSION_SECONDS, Math.max(0, clockS) + (Math.max(0, dtMs) / 1000) * speed.rate);
  return { clock: c, done: c >= SESSION_SECONDS };
}
/** The last frame revealed at `clockS`: a 1-minute bar becomes visible once its minute has CLOSED; the first bar shows at 09:16. null before any bar has closed. */
export function frameIndexAt(frames: { t: number }[], clockS: number): number {
  if (!frames.length) return -1;
  const open = frames[0].t - (istMinute(frames[0].t) - SESSION_OPEN_MIN) * 60;
  let idx = -1;
  for (let k = 0; k < frames.length; k++) { if (frames[k].t + 60 - open <= clockS + 1e-9) idx = k; else break; }
  return idx;
}
/** Scrubber: a minute of the session (0…374) → the clock at which that minute's bar is just visible (its close). Clamped. */
export const clockForMinute = (minute: number): number => (Math.min(SESSION_MINUTES - 1, Math.max(0, Math.round(minute))) + 1) * 60;
export const minuteOfClock = (clockS: number): number => Math.min(SESSION_MINUTES - 1, Math.max(0, Math.ceil(clockS / 60) - 1));
export const clockLabel = (clockS: number): string => { const m = SESSION_OPEN_MIN + Math.floor(Math.min(clockS, SESSION_SECONDS) / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
/** wall-clock seconds the whole day takes at a speed */
export const fullDaySeconds = (speed: ReplaySpeed): number => SESSION_SECONDS / speed.rate;
