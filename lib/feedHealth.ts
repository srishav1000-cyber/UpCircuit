// Feed-health state machine for the UI (pure). Two independent signals:
//   • the browser's own SmartAPI socket  (conn + age of the last tick)  → feedState()
//   • the closed-app alert daemon        (heartbeat row, skew-free ages computed by the database) → daemonState()
export type FeedState = 'live' | 'delayed' | 'reconnecting' | 'down' | 'closed';
export type ConnState = 'idle' | 'connecting' | 'open' | 'closed';

/** ticks older than this ⇒ not "live" any more (the feed spans every subscribed symbol, so a healthy market produces several ticks a second) */
export const LIVE_MAX_MS = 5_000;
/** ticks older than this on an open socket ⇒ treat the feed as down (stalled) */
export const STALE_DOWN_MS = 60_000;
/** reasons (from LiveReason) that mean "will not recover by retrying" */
const HARD_DOWN = new Set(['no_key', 'unauthorized', 'not_configured', 'login_failed', 'stream_failed']);

export interface FeedInput { conn: ConnState; marketOpen: boolean; lastTickAt: number; now: number; reason?: string }
export interface FeedHealth { state: FeedState; /** age of the newest tick, ms; null when none has arrived on this connection */ lagMs: number | null; headline: string }

export function feedState(i: FeedInput): FeedHealth {
  const lagMs = i.lastTickAt > 0 ? Math.max(0, i.now - i.lastTickAt) : null;
  if (!i.marketOpen) return { state: 'closed', lagMs, headline: 'Market closed' };
  if (i.conn === 'open') {
    if (lagMs === null) return { state: 'delayed', lagMs, headline: 'Connected — waiting for the first tick' };
    if (lagMs <= LIVE_MAX_MS) return { state: 'live', lagMs, headline: 'Live' };
    if (lagMs <= STALE_DOWN_MS) return { state: 'delayed', lagMs, headline: 'Delayed' };
    return { state: 'down', lagMs, headline: 'Feed stalled' };
  }
  if (i.conn === 'connecting') return { state: 'reconnecting', lagMs, headline: 'Reconnecting' };
  if (i.reason && HARD_DOWN.has(i.reason)) return { state: 'down', lagMs, headline: 'Live feed unavailable' };
  return { state: 'reconnecting', lagMs, headline: 'Reconnecting' };
}

export const fmtLag = (ms: number | null): string => (ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/** one row of public.daemon_health() */
export interface DaemonBeat { id: string; age_ms: number; last_tick_age_ms: number | null; feed_status: string; reconnects: number; started_at: string; version: string | null }
export type DaemonState = 'running' | 'degraded' | 'stale' | 'offline' | 'not_seen';
export const DAEMON_STALE_MS = 20_000;
export const DAEMON_OFFLINE_MS = 120_000;

/** `fetchedAgo` = ms since the heartbeat query returned (the database's age_ms was measured at query time) */
export function daemonState(beat: DaemonBeat | null | undefined, fetchedAgo = 0, marketOpen = true): { state: DaemonState; beatAgeMs: number | null; tickAgeMs: number | null; headline: string } {
  if (!beat) return { state: 'not_seen', beatAgeMs: null, tickAgeMs: null, headline: 'Alert daemon not detected' };
  const beatAgeMs = beat.age_ms + fetchedAgo;
  const tickAgeMs = beat.last_tick_age_ms === null ? null : beat.last_tick_age_ms + beatAgeMs;
  if (beatAgeMs >= DAEMON_OFFLINE_MS) return { state: 'offline', beatAgeMs, tickAgeMs, headline: 'Alert daemon offline' };
  if (beatAgeMs >= DAEMON_STALE_MS) return { state: 'stale', beatAgeMs, tickAgeMs, headline: 'Alert daemon not responding' };
  if (marketOpen && (beat.feed_status !== 'open' || tickAgeMs === null || tickAgeMs > STALE_DOWN_MS)) return { state: 'degraded', beatAgeMs, tickAgeMs, headline: 'Daemon running, market feed unhealthy' };
  return { state: 'running', beatAgeMs, tickAgeMs, headline: 'Alert daemon running' };
}
