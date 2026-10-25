'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FeedMode, MarketEngine } from '@/lib/market';
import { DOM_BATCH_MS } from '@/lib/frameScheduler';
import { getSync, serverSync, subscribeSync, syncLabel } from '@/lib/syncStatus';

interface Props {
  open: boolean;
  onClose: () => void;
  engine: MarketEngine;
  mode: FeedMode;
  /** size of the indexed master (NSE + BSE) */
  instruments: number;
}

const Row = ({ k, v, sub, id }: { k: string; v: string; sub?: string; id: string }) => (
  <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 last:border-0">
    <div>
      <div className="text-[12px] font-semibold text-ink">{k}</div>
      {sub && <div className="text-[10.5px] leading-snug text-muted">{sub}</div>}
    </div>
    <div data-testid={id} className="num shrink-0 text-right text-[14px] font-semibold text-accent">{v}</div>
  </div>
);

/** Live diagnostics drawer opened from the status bar. Feed numbers are MEASURED from the running tick stream; where nothing is streaming they read N/A. */
export function SystemTelemetryModal({ open, onClose, engine, mode, instruments }: Props) {
  const [, tick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const sync = useSyncExternalStore(subscribeSync, getSync, serverSync);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => tick((x) => x + 1), 1000);
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => {
      clearInterval(id);
      window.removeEventListener('keydown', k);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const t = engine.telemetry();
  const live = mode === 'live';
  const fps = Math.round(1000 / DOM_BATCH_MS);
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-end bg-black/40 p-3 sm:p-5" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid="telemetry-backdrop">
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="System telemetry" data-testid="telemetry-modal" className="w-full max-w-[420px] overflow-hidden rounded-lg border border-line bg-panel shadow-2xl outline-none">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-wider text-ink">
              <span className={`h-2 w-2 rounded-full ${live && t.lastTickAgoMs !== null && t.lastTickAgoMs < 15_000 ? 'animate-pulse bg-up' : 'bg-muted'}`} aria-hidden />
              System telemetry
            </h2>
            <p className="text-[10.5px] text-muted">{live ? 'Angel One SmartAPI WebSocket' : mode === 'delayed' ? 'Yahoo Finance (delayed REST polling)' : 'Saved snapshot — no live stream'} · refreshes every second</p>
          </div>
          <button onClick={onClose} aria-label="Close telemetry" data-testid="telemetry-close" className="flex h-8 w-8 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
        </header>
        <Row id="tele-latency" k="SmartAPI latency" v={t.delayMs === null ? 'N/A' : `${t.delayMs} ms`} sub={live ? 'Measured: browser receive time − exchange timestamp of each tick (smoothed). Includes exchange-clock granularity.' : 'Only measurable while the SmartAPI stream is connected.'} />
        <Row id="tele-throughput" k="Tick throughput" v={t.ticksPerSec === null ? 'N/A' : `${t.ticksPerSec.toFixed(1)} ticks/sec`} sub={live ? `Last 5 s · ${t.ticks.toLocaleString('en-IN')} ticks this session` : 'Not streaming (Yahoo polls every 10–60 s).'} />
        <Row id="tele-frame" k="DOM frame throttle" v={`${DOM_BATCH_MS} ms / ${fps} fps`} sub="Configured: tables, cards and tickers repaint at most this often; the chart draws every tick directly." />
        <Row id="tele-indexed" k="Indexed dataset" v={`${instruments.toLocaleString('en-IN')} master instruments`} sub="NSE + BSE scrip master loaded in the search index." />
        <Row id="tele-cloud" k="Cloud storage" v={syncLabel(sync.state).replace(/^[^A-Za-z]+/, '')} sub="Supabase REST sync state (Local = no signed-in cloud account)." />
      </div>
    </div>
  );
}
