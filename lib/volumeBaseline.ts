// Volume baseline for the volume_surge rule: the TYPICAL FULL-DAY volume of a stock = median of its last ≤ 20 completed sessions.
// "Surge" is then today's cumulative volume ÷ that baseline. Deliberately NOT time-of-day adjusted: Indian cash-market volume is front-loaded, so
// a linear "expected so far" curve would fire on ordinary mornings; a full-day multiple is slower to fire but never lies about the open.
export const BASELINE_SESSIONS = 20;
export const MIN_BASELINE_SESSIONS = 10;

export type BaselineStatus = 'ok' | 'insufficient' | 'unavailable';
export interface BaselineResult { medianVolume: number | null; sessions: number; status: BaselineStatus }

/** IST calendar day number of an epoch-ms instant */
export const istDayOf = (ms: number): number => Math.floor((ms / 1000 + 19800) / 86400);

/** bars: daily candles with IST-shifted `time` (seconds) as produced by lib/yahooData.parseBars. The still-forming session (today, IST) is excluded. */
export function computeBaseline(bars: { time: number; volume: number }[] | null | undefined, nowMs: number): BaselineResult {
  if (!bars || !bars.length) return { medianVolume: null, sessions: 0, status: 'unavailable' };
  const today = istDayOf(nowMs);
  const done = bars
    .filter((b) => Number.isFinite(b.volume) && b.volume > 0 && Math.floor(b.time / 86400) < today)   // zero volume = holiday / missing row, not a quiet day
    .sort((x, y) => x.time - y.time)
    .slice(-BASELINE_SESSIONS);
  if (done.length < MIN_BASELINE_SESSIONS) return { medianVolume: null, sessions: done.length, status: 'insufficient' };
  const v = done.map((b) => b.volume).sort((x, y) => x - y);
  const mid = v.length >> 1;
  return { medianVolume: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, sessions: done.length, status: 'ok' };
}

export const volumeMultiple = (volume: number, baseline: number | null | undefined): number | null => (baseline && baseline > 0 && volume >= 0 ? volume / baseline : null);

/* ───────────────────────── Week 10: intraday (time-of-day) profile ─────────────────────────
 * The full-day baseline above is front-loaded-blind: at 09:30 a stock has traded a few percent of its day, so a "2× typical day" rule can
 * only fire late. The intraday profile fixes that by comparing today's CUMULATIVE volume with what the stock has HISTORICALLY traded by the
 * same time of day: the median, over its last ≤ 20 completed sessions, of cumulative volume at the end of each 15-minute bucket
 * (25 buckets, 09:15–15:30 IST). The median of non-decreasing curves is itself non-decreasing, so the expected curve never goes backwards.
 *
 *   expected(t) = cum[k-1] + (minutes elapsed in bucket k ÷ 15) × (cum[k] − cum[k-1])        (linear inside the current bucket)
 *   multiple    = today's cumulative volume ÷ max(expected(t), 2 % of the full-day median)    (floor stops the first seconds exploding)
 *
 * Falls back to the flat full-day baseline (basis 'full-day') when there is no usable profile, and outside 09:15–15:30 IST.
 */
export const BUCKET_MIN = 15;
export const SESSION_OPEN_MIN = 9 * 60 + 15;      // 09:15 IST
export const SESSION_CLOSE_MIN = 15 * 60 + 30;    // 15:30 IST
export const BUCKETS = (SESSION_CLOSE_MIN - SESSION_OPEN_MIN) / BUCKET_MIN;   // 25
/** a historical day needs at least this many of the 25 buckets to count (holes would understate its cumulative curve) */
export const MIN_DAY_BUCKETS = 23;
/** early-session floor on the expected volume, as a share of the full-day median */
export const EXPECTED_FLOOR_SHARE = 0.02;

export interface IntradayProfile {
  /** median cumulative volume at the END of each bucket (length 25, non-decreasing) */
  cum: number[];
  sessions: number;
  status: BaselineStatus;
}
export const NO_PROFILE: IntradayProfile = { cum: [], sessions: 0, status: 'unavailable' };

/** minute of the IST day (0–1439.99) of an epoch-ms instant */
export const istMinuteOf = (ms: number): number => (((ms / 1000 + 19800) % 86400) + 86400) % 86400 / 60;

/** bucket 0…24 for an IST minute-of-day inside [09:15, 15:30), else null */
export function bucketIndex(minuteOfDay: number): number | null {
  if (!(minuteOfDay >= SESSION_OPEN_MIN && minuteOfDay < SESSION_CLOSE_MIN)) return null;
  return Math.floor((minuteOfDay - SESSION_OPEN_MIN) / BUCKET_MIN);
}
export const bucketLabel = (k: number): string => {
  const m = SESSION_OPEN_MIN + k * BUCKET_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const median = (xs: number[]): number => { const v = [...xs].sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

/** bars: 15-minute candles with IST-shifted `time` (seconds). Completed sessions only; today (IST) is excluded. */
export function computeIntradayProfile(bars: { time: number; volume: number }[] | null | undefined, nowMs: number): IntradayProfile {
  if (!bars || !bars.length) return NO_PROFILE;
  const today = istDayOf(nowMs);
  const days = new Map<number, number[]>();
  for (const b of bars) {
    if (!Number.isFinite(b.volume) || b.volume <= 0) continue;
    const day = Math.floor(b.time / 86400);
    if (day >= today) continue;
    const k = bucketIndex((b.time % 86400) / 60);
    if (k === null) continue;                                           // pre-open / post-close prints are not part of the 25 buckets
    const arr = days.get(day) ?? (days.set(day, new Array(BUCKETS).fill(0)), days.get(day)!);
    arr[k] += b.volume;
  }
  const curves = [...days.entries()]
    .filter(([, a]) => a.filter((v) => v > 0).length >= MIN_DAY_BUCKETS)
    .sort((x, y) => x[0] - y[0]).slice(-BASELINE_SESSIONS)
    .map(([, a]) => { let c = 0; return a.map((v) => (c += v)); });
  if (!curves.length) return { cum: [], sessions: 0, status: 'unavailable' };
  if (curves.length < MIN_BASELINE_SESSIONS) return { cum: [], sessions: curves.length, status: 'insufficient' };
  return { cum: Array.from({ length: BUCKETS }, (_, k) => median(curves.map((c) => c[k]))), sessions: curves.length, status: 'ok' };
}

export interface ExpectedVolume {
  /** volume a typical session has traded by now (profile), or the typical full-day volume (flat fallback) */
  expected: number;
  basis: 'time-of-day' | 'full-day';
  /** 0…24 when basis is time-of-day */
  bucket: number | null;
}

/** What "normal" is at `nowMs`. null only when there is no baseline of either kind (N/A). */
export function expectedVolume(profile: IntradayProfile | null | undefined, fullDay: number | null | undefined, nowMs: number): ExpectedVolume | null {
  const flat = fullDay && fullDay > 0 ? fullDay : null;
  const usable = profile && profile.status === 'ok' && profile.cum.length === BUCKETS && profile.cum.every((v) => Number.isFinite(v) && v >= 0);
  const m = istMinuteOf(nowMs), k = bucketIndex(m);
  if (usable && k !== null) {
    const prev = k === 0 ? 0 : profile!.cum[k - 1], end = profile!.cum[k];
    const frac = (m - (SESSION_OPEN_MIN + k * BUCKET_MIN)) / BUCKET_MIN;
    const exp = prev + frac * (end - prev);
    const full = flat ?? profile!.cum[BUCKETS - 1];
    const floor = EXPECTED_FLOOR_SHARE * full;
    if (exp > 0 || floor > 0) return { expected: Math.max(exp, floor), basis: 'time-of-day', bucket: k };
  }
  return flat ? { expected: flat, basis: 'full-day', bucket: null } : null;
}

/** today's cumulative volume ÷ expected-by-now (null = N/A) */
export function volumeMultipleAt(volume: number, profile: IntradayProfile | null | undefined, fullDay: number | null | undefined, nowMs: number): (ExpectedVolume & { multiple: number }) | null {
  const e = expectedVolume(profile, fullDay, nowMs);
  if (!e || !(volume >= 0) || !Number.isFinite(volume)) return null;
  return { ...e, multiple: volume / e.expected };
}

/* ───────────── Week 11: R(t), the 15-minute surge ratio used by the multi-signal flag confirmation ─────────────
 *   R(t) = volume traded over the last W minutes ÷ volume a typical session trades over the same W minutes   (W = 15, shortened to the time since the open)
 * "Typical" comes from the same median cumulative profile as volumeMultipleAt, so the open's heavy volume is not mistaken for a surge. null = N/A:
 * no usable profile, outside 09:15–15:30 IST, fewer than MIN_WINDOW_MIN minutes since the open, or a window the profile says is almost silent. */
export const SURGE_WINDOW_MIN = 15;
export const MIN_WINDOW_MIN = 5;
/** the profile's expected cumulative volume at `nowMs` (interpolated, no floor); null outside the session or without a usable profile */
export function expectedCumAt(profile: IntradayProfile | null | undefined, nowMs: number): number | null {
  if (!profile || profile.status !== 'ok' || profile.cum.length !== BUCKETS || !profile.cum.every((v) => Number.isFinite(v) && v >= 0)) return null;
  const m = istMinuteOf(nowMs), k = bucketIndex(m);
  if (k === null) return null;
  const prev = k === 0 ? 0 : profile.cum[k - 1], end = profile.cum[k];
  return prev + ((m - (SESSION_OPEN_MIN + k * BUCKET_MIN)) / BUCKET_MIN) * (end - prev);
}
/** `volNow` / `volThen`: cumulative day volume at nowMs and at nowMs − windowMs (the caller supplies the sample at the window start). */
export function windowSurge(profile: IntradayProfile | null | undefined, volNow: number, volThen: number, nowMs: number, windowMs: number = SURGE_WINDOW_MIN * 60_000): number | null {
  const e1 = expectedCumAt(profile, nowMs), e0 = expectedCumAt(profile, nowMs - windowMs) ?? 0;
  if (e1 === null || !Number.isFinite(volNow) || !Number.isFinite(volThen) || volNow < volThen) return null;
  const sinceOpen = istMinuteOf(nowMs) - SESSION_OPEN_MIN;
  if (sinceOpen < MIN_WINDOW_MIN) return null;
  const expected = e1 - (sinceOpen >= windowMs / 60_000 ? e0 : 0);
  const full = profile!.cum[BUCKETS - 1];
  if (!(expected > 0.002 * full)) return null;
  return (volNow - volThen) / expected;
}

/** live helper: remembers (time, cumulative volume) samples per symbol (≥ `everyMs` apart, 20 min kept) and answers R(t) */
export class VolumeWindow {
  private readonly s = new Map<string, { t: number; v: number }[]>();
  constructor(private readonly everyMs = 5_000, private readonly keepMs = 20 * 60_000) {}
  push(symbol: string, t: number, cumVolume: number): void {
    if (!(cumVolume >= 0) || !Number.isFinite(t)) return;
    const a = this.s.get(symbol) ?? [];
    const last = a[a.length - 1];
    if (last && (t - last.t < this.everyMs && cumVolume >= last.v)) return;
    if (last && cumVolume < last.v) a.length = 0;                       // a new session (volume reset): start over
    a.push({ t, v: cumVolume });
    while (a.length && t - a[0].t > this.keepMs) a.shift();
    this.s.set(symbol, a);
  }
  /** R(t) from the samples held; the window start is the sample closest to (but not after) now − 15 min, else the oldest sample ≥ 5 min back, else the session open (volume 0) */
  ratio(symbol: string, profile: IntradayProfile | null | undefined, nowMs: number, cumVolumeNow: number): number | null {
    const a = this.s.get(symbol); if (!a || !a.length) return null;
    const target = nowMs - SURGE_WINDOW_MIN * 60_000;
    const sinceOpen = istMinuteOf(nowMs) - SESSION_OPEN_MIN;
    let then: { t: number; v: number } | null = null;
    for (const x of a) if (x.t <= target) then = x;
    if (!then) {
      const oldest = a[0];
      if (nowMs - oldest.t >= MIN_WINDOW_MIN * 60_000 && nowMs - oldest.t < SURGE_WINDOW_MIN * 60_000) then = oldest;
      else return null;
    }
    return windowSurge(profile, cumVolumeNow, then.v, nowMs, nowMs - then.t);
  }
  clear(): void { this.s.clear(); }
}
