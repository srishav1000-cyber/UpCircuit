'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AlertKind, MarketAlert } from '@/lib/types';

const META: Record<AlertKind, { label: string; cls: string; icon: string }> = {
  UPPER_CIRCUIT: { label: 'Upper circuit', cls: 'bg-up text-white', icon: '▲' },
  LOWER_CIRCUIT: { label: 'Lower circuit', cls: 'bg-down text-white', icon: '▼' },
  PRICE_SURGE: { label: 'Price surge', cls: 'bg-warn text-black', icon: '⚡' },
  VOLUME_SURGE: { label: 'Volume surge', cls: 'bg-accent text-white', icon: '◆' },
};

const FRESH_MS = 3 * 60_000; // alerts older than this drop out of the rotation
const ROTATE_MS = 4000;

interface Props {
  alerts: MarketAlert[];
  onSelect: (symbol: string) => void;
}

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

/** Sticky alert bar: price/volume surges (≥3× normal) and circuit-limit hits. Hidden when nothing is live. */
export function CircuitBanner({ alerts, onSelect }: Props) {
  const [dismissedUpTo, setDismissedUpTo] = useState(0);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  const live = useMemo(() => alerts.filter((a) => a.id > dismissedUpTo && Date.now() - a.time < FRESH_MS).slice(0, 6), [alerts, dismissedUpTo]);

  useEffect(() => {
    if (paused || live.length < 2) return;
    const id = setInterval(() => setIdx((i) => i + 1), ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, live.length]);

  // a brand-new alert jumps to the front
  const newest = alerts[0]?.id ?? 0;
  useEffect(() => setIdx(0), [newest]);

  if (live.length === 0) return null;
  const a = live[idx % live.length];
  const m = META[a.kind];

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-3 px-3 py-1.5 text-[12px] ${m.cls}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="flex shrink-0 items-center gap-1.5 rounded bg-black/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
        <span aria-hidden>{m.icon}</span>
        {m.label}
      </span>
      <button onClick={() => onSelect(a.symbol)} className="min-w-0 flex-1 truncate text-left font-medium hover:underline" title="Open stock research">
        {a.message}
      </button>
      <span className="num hidden shrink-0 text-white/80 sm:inline">{ago(a.time)}</span>
      {live.length > 1 && (
        <span className="num shrink-0 rounded bg-black/20 px-1.5 py-0.5 text-[10px] font-semibold">
          {(idx % live.length) + 1}/{live.length}
        </span>
      )}
      <button onClick={() => setDismissedUpTo(alerts[0]?.id ?? 0)} aria-label="Dismiss alerts" className="shrink-0 rounded px-1.5 text-[16px] leading-none text-white/85 hover:bg-black/20">
        ×
      </button>
    </div>
  );
}
