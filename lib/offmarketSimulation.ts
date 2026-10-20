// Off-market replay + tick persistence helpers (pure — no I/O, no Math.random).
//
// While the market is open the browser samples REAL SmartAPI ticks and logs them to Supabase (`market_ticks`).
// When the market is closed (or the feed is down) the terminal replays, in this order of preference:
//   1. persisted(real) – the closing stretch of the last session's logged ticks, ping-ponged so the price never jumps;
//   2. bars(real)      – the last session's real 1-minute closes, same ping-pong;
//   3. envelope        – ONLY when no real path exists: a deterministic (sine, no RNG) ±0.05 % wobble around the last close.
// Every replayed price is clamped to the session [Low, High] widened by 0.05 %. Nothing here raises circuit alerts.
import { istDate } from './circuitDedupe';

export interface TickRow {
  symbol: string;
  ltp: number;
  high: number;
  low: number;
  volume: number;
  /** epoch ms (exchange time) */
  ts: number;
}

export const OPEN_MIN = 9 * 60 + 15;
export const CLOSE_MIN = 15 * 60 + 30;
export const BAND_PCT = 0.05; // replay may stray 0.05 % beyond the session High / Low
export const REPLAY_WINDOW = 60; // closing ticks that are replayed
export const SAMPLE_GAP_MS = 15_000; // ≤ 1 logged tick per symbol per 15 s

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const ist = (ms: number) => new Date(ms + 330 * 60_000);

/** 09:15–15:30 IST, Mon–Fri (inclusive of 15:30 so the closing tick is kept). */
export function inSession(ms: number): boolean {
  const d = ist(ms);
  const dow = d.getUTCDay();
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow >= 1 && dow <= 5 && min >= OPEN_MIN && min <= CLOSE_MIN;
}

export const tradingDateOf = istDate;

/** ISO-8601 with the +05:30 offset, e.g. 2026-10-20T09:15:03+05:30 */
export const istIso = (ms: number): string => `${ist(ms).toISOString().slice(0, 19)}+05:30`;

/* ───────────── logging ───────────── */

export interface SampleInput {
  symbol: string;
  lastPrice: number;
  volume?: number;
  high?: number;
  low?: number;
  timestamp?: number;
  isIndex?: boolean;
}

/** Throttles the live stream to ≤ 1 row / symbol / `gapMs`, keeps only in-session ticks, never logs indices. */
export class TickSampler {
  private last = new Map<string, number>();
  private hi = new Map<string, number>();
  private lo = new Map<string, number>();
  private day = '';
  constructor(private gapMs = SAMPLE_GAP_MS) {}

  offer(t: SampleInput, now = Date.now()): TickRow | null {
    if (t.isIndex || !t.symbol || !finite(t.lastPrice) || t.lastPrice <= 0) return null;
    const ts = finite(t.timestamp) && t.timestamp > 0 ? Math.floor(t.timestamp / 1000) * 1000 : Math.floor(now / 1000) * 1000;
    if (!inSession(ts) || ts > now + 60_000) return null;
    const day = tradingDateOf(ts);
    if (day !== this.day) {
      this.day = day;
      this.last.clear();
      this.hi.clear();
      this.lo.clear();
    }
    // running day range from what we observed, used only when the packet carries no High / Low
    this.hi.set(t.symbol, Math.max(this.hi.get(t.symbol) ?? 0, t.lastPrice));
    this.lo.set(t.symbol, Math.min(this.lo.get(t.symbol) ?? Infinity, t.lastPrice));
    if (ts - (this.last.get(t.symbol) ?? -Infinity) < this.gapMs) return null;
    this.last.set(t.symbol, ts);
    const high = finite(t.high) && t.high > 0 ? Math.max(t.high, t.lastPrice) : this.hi.get(t.symbol)!;
    const low = finite(t.low) && t.low > 0 ? Math.min(t.low, t.lastPrice) : this.lo.get(t.symbol)!;
    return { symbol: t.symbol, ltp: t.lastPrice, high, low, volume: finite(t.volume) && t.volume >= 0 ? Math.round(t.volume) : 0, ts };
  }
}

/** Header + rows: Symbol, LTP, High, Low, Volume, Timestamp (IST). */
export function rowsToCsv(rows: TickRow[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const out = ['Symbol,LTP,High,Low,Volume,Timestamp'];
  for (const r of rows) out.push([esc(r.symbol), r.ltp, r.high, r.low, r.volume, istIso(r.ts)].join(','));
  return out.join('\n') + '\n';
}

/** Server-side validation of a client batch: drops junk and anything outside the session; caps the size. */
export function validateRows(input: unknown, now = Date.now(), max = 500): TickRow[] {
  if (!Array.isArray(input)) return [];
  const out: TickRow[] = [];
  for (const r of input.slice(0, max)) {
    if (!r || typeof r !== 'object') continue;
    const { symbol, ltp, high, low, volume, ts } = r as Record<string, unknown>;
    if (typeof symbol !== 'string' || !/^[A-Z0-9&\-]{1,20}$/.test(symbol)) continue;
    if (!finite(ltp) || !finite(high) || !finite(low) || !finite(ts) || ltp <= 0 || high <= 0 || low <= 0) continue;
    if (low > high * 1.0001 || ltp > high * 1.0001 || ltp < low * 0.9999) continue;
    if (!inSession(ts) || ts > now + 60_000) continue;
    out.push({ symbol, ltp, high, low, volume: finite(volume) && volume >= 0 ? Math.round(volume) : 0, ts: Math.floor(ts / 1000) * 1000 });
  }
  return out;
}

/* ───────────── replay ───────────── */

export type ReplayKind = 'persisted' | 'bars' | 'envelope';

export interface ReplayPath {
  kind: ReplayKind;
  /** session range the replay is clamped to */
  high: number;
  low: number;
  path: number[];
}

export const clampToSession = (p: number, high: number, low: number): number => Math.min(high * (1 + BAND_PCT / 100), Math.max(low * (1 - BAND_PCT / 100), p));

/** Deterministic ±0.05 % oscillation around `ltp` (two incommensurate sines — no RNG), clamped to the session range. */
export function envelopePath(ltp: number, high: number, low: number, n = 120): number[] {
  const amp = ltp * (BAND_PCT / 100);
  return Array.from({ length: n }, (_, i) => clampToSession(ltp + amp * (0.65 * Math.sin(i * 0.37) + 0.35 * Math.sin(i * 0.91 + 1)), high, low));
}

export function buildReplay(o: { rows?: TickRow[]; bars?: { close: number; high?: number; low?: number }[]; ltp: number; high: number; low: number }): ReplayPath | null {
  const rows = (o.rows ?? []).filter((r) => r.ltp > 0).sort((a, b) => a.ts - b.ts);
  if (rows.length >= 2) {
    const tail = rows.slice(-REPLAY_WINDOW);
    return { kind: 'persisted', high: Math.max(...rows.map((r) => r.high)), low: Math.min(...rows.map((r) => r.low)), path: tail.map((r) => r.ltp) };
  }
  const bars = (o.bars ?? []).filter((b) => finite(b.close) && b.close > 0);
  if (bars.length >= 2) {
    const tail = bars.slice(-REPLAY_WINDOW);
    const hi = Math.max(...bars.map((b) => b.high ?? b.close));
    const lo = Math.min(...bars.map((b) => b.low ?? b.close));
    return { kind: 'bars', high: hi, low: lo, path: tail.map((b) => b.close) };
  }
  if (finite(o.ltp) && o.ltp > 0 && finite(o.high) && finite(o.low) && o.high >= o.low && o.low > 0) {
    return { kind: 'envelope', high: o.high, low: o.low, path: envelopePath(o.ltp, o.high, o.low) };
  }
  return null;
}

/** Walks the path forward then backward (ping-pong) so the price never teleports from the last tick back to the first. */
export class Replayer {
  private i = 0;
  private dir = 1;
  constructor(readonly replay: ReplayPath) {
    this.i = replay.path.length - 1; // start at the real close
    this.dir = -1;
  }
  next(): number {
    const { path, high, low } = this.replay;
    const v = clampToSession(path[this.i], high, low);
    if (path.length > 1) {
      if (this.i + this.dir < 0 || this.i + this.dir >= path.length) this.dir = -this.dir;
      this.i += this.dir;
    }
    return v;
  }
}
