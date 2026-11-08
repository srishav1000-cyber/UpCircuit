// Per-user Quiet Hours: a daily wall-clock window in the user's own IANA time zone during which routine alerts are held.
//   • window is [start, end) in minutes since local midnight; end < start wraps past midnight (22:00 → 07:00)
//   • start === end is treated as "no window" (never a 24-hour mute) — the UI refuses it too
//   • time zones are resolved with Intl, so daylight-saving shifts follow the zone's rules (the window stays at the same wall-clock times)
//   • critical rule kinds bypass quiet hours entirely (CRITICAL_KINDS)
import type { RuleKind } from './alertTypes';

export interface QuietHours { enabled: boolean; /** minutes since local midnight, 0–1439 */ start: number; end: number; /** IANA zone, e.g. Asia/Kolkata */ tz: string }

export const DEFAULT_TZ = 'Asia/Kolkata';
export const DEFAULT_QUIET: QuietHours = { enabled: false, start: 22 * 60, end: 7 * 60, tz: DEFAULT_TZ };

/** rules that are never held: a stock about to hit its circuit limit is time-critical */
export const CRITICAL_KINDS: ReadonlySet<RuleKind> = new Set<RuleKind>(['circuit_proximity']);
export const bypassesQuiet = (kind: string): boolean => CRITICAL_KINDS.has(kind as RuleKind);

const fmtCache = new Map<string, Intl.DateTimeFormat | null>();
function formatter(tz: string): Intl.DateTimeFormat | null {
  if (fmtCache.has(tz)) return fmtCache.get(tz)!;
  let f: Intl.DateTimeFormat | null = null;
  try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { f = null; }
  if (fmtCache.size > 200) fmtCache.clear();
  fmtCache.set(tz, f);
  return f;
}
export const isValidTz = (tz: unknown): tz is string => typeof tz === 'string' && tz.length > 0 && tz.length <= 64 && formatter(tz) !== null;

/** "22:30" → 1350 (null when malformed) */
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}
export const fmtHHMM = (min: number): string => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** minutes since midnight at `ms` in `tz` (null for an unknown zone) */
export function minutesInZone(ms: number, tz: string): number | null {
  const f = formatter(tz);
  if (!f || !Number.isFinite(ms)) return null;
  const parts = f.formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === 'hour')?.value), m = Number(parts.find((p) => p.type === 'minute')?.value);
  return Number.isFinite(h) && Number.isFinite(m) ? (h % 24) * 60 + m : null;
}

/** Coerces a DB row ({enabled,start_min,end_min,tz}) or a UI object ({start:'22:00',end:'07:00'}) into QuietHours; null when unusable. */
export function sanitizeQuiet(raw: unknown): QuietHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const start = typeof r.start_min === 'number' ? r.start_min : typeof r.start === 'number' ? r.start : parseHHMM(r.start);
  const end = typeof r.end_min === 'number' ? r.end_min : typeof r.end === 'number' ? r.end : parseHHMM(r.end);
  const tz = r.tz ?? DEFAULT_TZ;
  if (start === null || end === null || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 1439 || end < 0 || end > 1439 || !isValidTz(tz)) return null;
  return { enabled: r.enabled === true, start, end, tz };
}

/** why a quiet-hours config cannot be saved (empty = fine) */
export function validateQuiet(q: QuietHours): string[] {
  const errs: string[] = [];
  if (!isValidTz(q.tz)) errs.push('Unknown time zone.');
  if (q.enabled && q.start === q.end) errs.push('Start and end must differ (a 24-hour mute is not allowed).');
  return errs;
}

/** is `ms` inside the user's quiet window? */
export function isQuietAt(q: QuietHours | null | undefined, ms: number): boolean {
  if (!q || !q.enabled || q.start === q.end) return false;
  const m = minutesInZone(ms, q.tz);
  if (m === null) return false;                                      // unknown zone: fail open (deliver)
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}

/** minutes until the window ends (null when not quiet) */
export function minutesUntilEnd(q: QuietHours, ms: number): number | null {
  if (!isQuietAt(q, ms)) return null;
  const m = minutesInZone(ms, q.tz)!;
  return (q.end - m + 1440) % 1440 || 1440;
}

export interface QuietDecision { hold: boolean; /** true when the window is open but the rule is critical */ overridden: boolean; reason?: string }
/** The dispatch decision: hold a routine alert in the window, deliver a critical one (and say it overrode). */
export function quietDecision(q: QuietHours | null | undefined, kind: string, ms: number): QuietDecision {
  if (!isQuietAt(q, ms)) return { hold: false, overridden: false };
  const win = `${fmtHHMM(q!.start)}–${fmtHHMM(q!.end)} ${q!.tz}`;
  if (bypassesQuiet(kind)) return { hold: false, overridden: true, reason: `quiet-hours override (${win})` };
  return { hold: true, overridden: false, reason: `held: quiet hours ${win}` };
}
