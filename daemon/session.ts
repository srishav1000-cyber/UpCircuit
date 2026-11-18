// Session-lifecycle helpers for the unattended daemon (pure, testable).
//   • The SmartAPI feed token is re-issued every SESSION_TTL_MS (6 h) AND once a day at 08:45 IST (03:15 UTC) — 30 minutes before the 09:15 IST open —
//     so the market always opens on a session that is at most ~40 minutes old, with no human involved.
//   • "Silent feed" is only judged during the cash session, measured from the 09:15 open, so pre-open / post-close silence never causes login churn.
const IST_MS = 330 * 60_000, DAY_MS = 86_400_000;
export const REFRESH_IST_MIN = 8 * 60 + 45;       // 08:45 IST = 03:15 UTC
export const MIN_REFRESH_LEAD_MS = 10 * 60_000;   // a login made within 10 min of the refresh time already counts as fresh
export const OPEN_IST_MIN = 9 * 60 + 15;          // 09:15 IST = 03:45 UTC

const atIstMinute = (nowMs: number, minute: number, after: boolean): number => {
  const ist = nowMs + IST_MS, dayStart = Math.floor(ist / DAY_MS) * DAY_MS;
  let t = dayStart + minute * 60_000;
  if (after) { if (t <= ist) t += DAY_MS; } else if (t > ist) t -= DAY_MS;
  return t - IST_MS;
};

/** the next 08:45 IST strictly after `nowMs` (epoch ms) */
export const nextRefreshAt = (nowMs: number): number => atIstMinute(nowMs, REFRESH_IST_MIN, true);
/** the most recent 09:15 IST at or before `nowMs` */
export const lastOpenAt = (nowMs: number): number => atIstMinute(nowMs, OPEN_IST_MIN, false);

/** when this login must be recycled: its own expiry, or the next morning refresh (skipped when that is < 10 min away — this login is already fresh enough) */
export function sessionDeadline(loginExpiresAt: number, nowMs: number): number {
  let r = nextRefreshAt(nowMs);
  if (r - nowMs < MIN_REFRESH_LEAD_MS) r += DAY_MS;
  return Math.min(loginExpiresAt, r);
}
