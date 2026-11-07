// Multi-stage latency of one alert delivery, from the timestamps the pipeline stamps (see docs/WEEK9_SCHEMA.sql). Pure — unit-tested.
//
//   exchange tick ──► daemon match ──► push accepted ──► device shows banner
//        tickToMatch      matchToPush       pushToDisplay (DEVICE clock — may be skewed)
//                                  └──────► pushToAck     (SERVER clock — includes the ACK HTTP round-trip)
import type { AlertDelivery } from './cloud';

export interface Stages {
  tickToMatchMs: number | null;
  matchToPushMs: number | null;
  /** push accepted → banner shown, using the device clock; null when negative (clock skew) */
  pushToDisplayMs: number | null;
  pushToAckMs: number | null;
  /** tick → push accepted (the "cross-to-push" figure the < 2 s target refers to); null without a tick time */
  crossToPushMs: number | null;
  skew: boolean;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const gap = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : b - a);

export function stagesOf(d: Pick<AlertDelivery, 'tick_time' | 'daemon_matched_at' | 'push_sent_at' | 'sw_ack_at' | 'displayed_at'>): Stages {
  const tick = ms(d.tick_time), match = ms(d.daemon_matched_at), sent = ms(d.push_sent_at), ack = ms(d.sw_ack_at), shown = ms(d.displayed_at);
  const t2m = gap(tick, match), m2p = gap(match, sent), p2d = gap(sent, shown), p2a = gap(sent, ack);
  // the exchange timestamp has one-second resolution and its own clock: a negative gap there is skew, not a faster-than-light tick
  const skew = (p2d !== null && p2d < 0) || (t2m !== null && t2m < -1000);
  return {
    tickToMatchMs: t2m !== null && t2m >= -1000 ? Math.max(0, t2m) : null,
    matchToPushMs: m2p !== null && m2p >= 0 ? m2p : null,
    pushToDisplayMs: p2d !== null && p2d >= 0 ? p2d : null,
    pushToAckMs: p2a !== null && p2a >= 0 ? p2a : null,
    crossToPushMs: tick !== null && sent !== null && t2m !== null && t2m >= -1000 ? Math.max(0, sent - tick) : null,
    skew,
  };
}

/** nearest-rank percentile (p in 0..100) of the finite numbers; null when there are none */
export function percentile(xs: (number | null | undefined)[], p: number): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

export interface LatencySummary { rows: number; acked: number; p50: Record<'tickToMatch' | 'matchToPush' | 'pushToDisplay' | 'crossToPush', number | null>; p95: Record<'tickToMatch' | 'matchToPush' | 'pushToDisplay' | 'crossToPush', number | null>; max: number | null }
export function summarize(rows: AlertDelivery[]): LatencySummary {
  const push = rows.filter((r) => r.channel === 'push' && r.status === 'sent');
  const s = push.map((r) => stagesOf(r));
  const col = (k: keyof Stages) => s.map((x) => x[k] as number | null);
  const pick = (p: number) => ({ tickToMatch: percentile(col('tickToMatchMs'), p), matchToPush: percentile(col('matchToPushMs'), p), pushToDisplay: percentile(col('pushToDisplayMs'), p), crossToPush: percentile(col('crossToPushMs'), p) });
  return { rows: push.length, acked: push.filter((r) => r.sw_ack_at).length, p50: pick(50), p95: pick(95), max: percentile(col('crossToPushMs'), 100) };
}

export const fmtMs = (n: number | null): string => (n === null ? '—' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`);
/** colour class by the roadmap targets: cross-to-push < 1 s good, < 2 s acceptable */
export const latencyTone = (n: number | null): 'up' | 'warn' | 'down' | 'muted' => (n === null ? 'muted' : n < 1000 ? 'up' : n < 2000 ? 'warn' : 'down');
