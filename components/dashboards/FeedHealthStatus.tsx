'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CircleCheck, Radio, RefreshCw, WifiOff, X } from 'lucide-react';
import type { CloudClient } from '@/lib/cloud';
import { isMarketOpen, smartApiStatus, type FeedConn, type FeedMode, type LiveReason } from '@/lib/market';
import { daemonState, feedState, fmtLag, LIVE_MAX_MS, STALE_DOWN_MS, type DaemonBeat, type FeedState } from '@/lib/feedHealth';

type Variant = 'banner' | 'pill' | 'panel';
export interface FeedHealthStatusProps {
  /** browser SmartAPI socket state (from useMarket) */
  conn: FeedConn;
  mode: FeedMode;
  reason?: LiveReason;
  /** epoch ms of the newest tick on the browser socket (0 = none). A getter, so this component can tick every second without re-rendering the page. */
  getLastTickAt: () => number;
  /** with a signed-in cloud client the closed-app alert daemon's heartbeat is shown too */
  cloud?: CloudClient | null;
  variant?: Variant;
  className?: string;
  /** time source (tests / demos); defaults to Date.now */
  clock?: () => number;
}

const TONE: Record<FeedState, { dot: string; text: string; ring: string; label: string }> = {
  live: { dot: 'bg-up', text: 'text-up', ring: 'border-up/40 bg-up/10', label: 'Live' },
  delayed: { dot: 'bg-warn', text: 'text-warn', ring: 'border-warn/50 bg-warn/10', label: 'Delayed' },
  reconnecting: { dot: 'bg-warn animate-pulse', text: 'text-warn', ring: 'border-warn/50 bg-warn/10', label: 'Reconnecting' },
  down: { dot: 'bg-down', text: 'text-down', ring: 'border-down/50 bg-down/10', label: 'Down' },
  closed: { dot: 'bg-muted', text: 'text-muted', ring: 'border-line bg-panel', label: 'Market closed' },
};
const SEVERITY: Record<FeedState, number> = { live: 0, closed: 0, delayed: 1, reconnecting: 1, down: 2 };
const DAEMON_TONE = { running: 'text-up', degraded: 'text-warn', stale: 'text-warn', offline: 'text-down', not_seen: 'text-muted' } as const;

/**
 * Feed health + lag. Three renderings of one state machine (lib/feedHealth.ts):
 *   pill   — "● Live · 0.8 s"            (compact, for toolbars)
 *   banner — floating warning, only while the feed is delayed / reconnecting / down during market hours (dismissible until it gets worse)
 *   panel  — full detail: browser feed, tick age, thresholds, and the closed-app alert daemon's heartbeat
 * Lag = now − timestamp of the newest tick received (local receive clock, so exchange-vs-device clock skew cannot distort it).
 */
export function FeedHealthStatus({ conn, mode, reason, getLastTickAt, cloud = null, variant = 'panel', className = '', clock = Date.now }: FeedHealthStatusProps) {
  const [now, setNow] = useState(() => clock());
  const [beat, setBeat] = useState<{ row: DaemonBeat | null; at: number; loaded: boolean }>({ row: null, at: 0, loaded: false });
  const [dismissed, setDismissed] = useState<FeedState | null>(null);

  useEffect(() => { const t = setInterval(() => setNow(clock()), 1000); return () => clearInterval(t); }, [clock]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!cloud) { setBeat({ row: null, at: 0, loaded: false }); return () => { alive.current = false; }; }
    const load = async () => { const row = await cloud.daemonHealth().catch(() => null); if (alive.current) setBeat({ row, at: clock(), loaded: true }); };
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [cloud, clock]);

  const open = isMarketOpen(now);
  const feed = feedState({ conn, marketOpen: open, lastTickAt: getLastTickAt(), now, reason });
  const tone = TONE[feed.state];
  const daemon = daemonState(beat.row, beat.at ? now - beat.at : 0, open);
  const link = smartApiStatus({ mode, conn, reason });
  // a daemon that WAS running but has gone quiet matters (closed-app alerts are paused); one that was never deployed is only mentioned in the panel
  const daemonAlarm = open && beat.loaded && (daemon.state === 'stale' || daemon.state === 'offline' || daemon.state === 'degraded');

  const headline = useMemo(() => {
    if (feed.state === 'delayed' && feed.lagMs !== null) return `Market ticks are ${fmtLag(feed.lagMs)} old`;
    if (feed.state === 'delayed') return 'Connected, but no ticks yet';
    if (feed.state === 'reconnecting') return 'Reconnecting to the live market feed';
    if (feed.state === 'down') return feed.lagMs !== null && conn === 'open' ? `Market feed stalled — last tick ${fmtLag(feed.lagMs)} ago` : 'Live market feed is down';
    return feed.headline;
  }, [feed, conn]);

  const lagText = feed.lagMs === null ? '—' : fmtLag(feed.lagMs);

  /* ───────── pill ───────── */
  if (variant === 'pill') {
    return (
      <span data-testid="feed-pill" data-state={feed.state} title={`${link.detail}\nLag = time since the newest tick arrived.`} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone.ring} ${className}`}>
        <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden />
        <span className={tone.text}>{tone.label}</span>
        {open && feed.lagMs !== null && <span className="num text-muted" data-testid="feed-lag">{lagText}</span>}
      </span>
    );
  }

  /* ───────── floating warning banner ───────── */
  if (variant === 'banner') {
    const bad = open && SEVERITY[feed.state] > 0;
    if (!bad && !daemonAlarm) return null;
    if (bad && dismissed !== null && SEVERITY[feed.state] <= SEVERITY[dismissed] && !daemonAlarm) return null;
    const Icon = feed.state === 'down' ? WifiOff : feed.state === 'reconnecting' ? RefreshCw : AlertTriangle;
    return (
      <div role="status" aria-live="polite" data-testid="feed-banner" data-state={bad ? feed.state : 'daemon'} className={`pointer-events-auto fixed inset-x-3 bottom-14 z-40 mx-auto flex max-w-xl items-start gap-3 rounded-lg border px-3.5 py-2.5 text-[12px] shadow-xl backdrop-blur-md ${bad ? tone.ring : 'border-warn/50 bg-warn/10'} ${className}`}>
        <Icon size={16} className={`mt-0.5 shrink-0 ${bad ? tone.text : 'text-warn'} ${feed.state === 'reconnecting' ? 'animate-spin' : ''}`} aria-hidden />
        <div className="min-w-0 flex-1 text-ink">
          {bad && (
            <>
              <p className="font-semibold">{headline}</p>
              <p className="mt-0.5 text-muted">{feed.state === 'down' && reason ? link.detail : 'Prices and alerts shown here may be behind the exchange until ticks flow again — do not trade off a stale screen.'}</p>
            </>
          )}
          {daemonAlarm && (
            <p className={bad ? 'mt-1.5 text-muted' : 'font-semibold'} data-testid="feed-banner-daemon">
              {daemon.state === 'degraded' ? 'Closed-app alerts: the daemon is running but its market feed is unhealthy.' : 'Closed-app alerts are paused: the alert daemon has stopped reporting.'}
            </p>
          )}
        </div>
        {bad && <button type="button" onClick={() => setDismissed(feed.state)} className="rounded p-1 text-muted hover:bg-line hover:text-ink" aria-label="Hide this warning until the feed gets worse"><X size={14} aria-hidden /></button>}
      </div>
    );
  }

  /* ───────── panel ───────── */
  const FeedIcon = feed.state === 'live' ? CircleCheck : feed.state === 'down' ? WifiOff : feed.state === 'closed' ? Radio : AlertTriangle;
  return (
    <section data-testid="feed-panel" data-state={feed.state} aria-label="Feed health" className={`rounded-xl border border-line bg-panel/80 p-4 backdrop-blur-md ${className}`}>
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted">Feed health</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div className={`rounded-lg border p-3 ${tone.ring}`} data-testid="feed-browser">
          <div className="flex items-center gap-2"><FeedIcon size={15} className={tone.text} aria-hidden /><span className={`text-[13px] font-bold ${tone.text}`} data-testid="feed-state">{tone.label}</span></div>
          <p className="mt-1 text-[12px] text-ink">{open ? headline : 'Market closed — no live ticks expected (09:15–15:30 IST, Mon–Fri).'}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-muted">Tick age (feed lag)</dt><dd className="num text-right font-semibold text-ink" data-testid="feed-lag">{lagText}</dd>
            <dt className="text-muted">Socket</dt><dd className="text-right text-ink">{conn}</dd>
            <dt className="text-muted">Thresholds</dt><dd className="num text-right text-muted">live ≤ {LIVE_MAX_MS / 1000} s · down &gt; {STALE_DOWN_MS / 1000} s</dd>
          </dl>
          <p className="mt-2 text-[11px] text-muted">This browser&apos;s own SmartAPI connection. Lag counts from the newest tick received on any subscribed symbol.</p>
        </div>

        <div className="rounded-lg border border-line bg-bg/60 p-3" data-testid="feed-daemon" data-state={cloud ? daemon.state : 'n/a'}>
          <div className="flex items-center gap-2"><Radio size={15} className={cloud ? DAEMON_TONE[daemon.state] : 'text-muted'} aria-hidden />
            <span className={`text-[13px] font-bold ${cloud ? DAEMON_TONE[daemon.state] : 'text-muted'}`}>{cloud ? daemon.headline : 'Alert daemon'}</span></div>
          {!cloud && <p className="mt-1 text-[12px] text-muted">Sign in with an account to see the closed-app alert daemon&apos;s heartbeat.</p>}
          {cloud && !beat.loaded && <p className="mt-1 text-[12px] text-muted">Checking…</p>}
          {cloud && beat.loaded && daemon.state === 'not_seen' && <p className="mt-1 text-[12px] text-muted">No heartbeat yet. Closed-app alerts need the daemon deployed (docs/WEEK9_DAEMON.md) and docs/WEEK9_TURN43_SCHEMA.sql applied; until then rules run on the 5-minute cron backstop and volume / depth rules cannot fire.</p>}
          {cloud && beat.row && (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-muted">Last heartbeat</dt><dd className="num text-right font-semibold text-ink" data-testid="daemon-beat-age">{fmtLag(daemon.beatAgeMs)} ago</dd>
              <dt className="text-muted">Daemon feed</dt><dd className="text-right text-ink">{beat.row.feed_status}</dd>
              <dt className="text-muted">Daemon tick age</dt><dd className="num text-right text-ink" data-testid="daemon-tick-age">{fmtLag(daemon.tickAgeMs)}</dd>
              <dt className="text-muted">Reconnects</dt><dd className="num text-right text-ink">{beat.row.reconnects}</dd>
            </dl>
          )}
          <p className="mt-2 text-[11px] text-muted">The server process that watches your rules while the app is closed. Ages come from the database clock.</p>
        </div>
      </div>
    </section>
  );
}
