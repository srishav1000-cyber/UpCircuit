'use client';

import { useEffect, useRef, useState } from 'react';
import { isMarketOpen, type MarketEngine } from '@/lib/market';
import { CircuitTracker, circuitHit, type CircuitDir, type CircuitHit } from '@/lib/circuit';
import { playChime } from '@/lib/chime';
import { CircuitDedupe } from '@/lib/circuitDedupe';

function safeStore() {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; } catch { return undefined; }
}

export interface CircuitEvent extends CircuitHit {
  id: number;
  at: number;
  /** produced by the ⚡ Demo Circuit Simulator — not market data */
  demo?: boolean;
}

/**
 * Watches the user's active watchlist + focus basket for upper / lower circuits on REAL prices.
 * A confirmed hit (once per symbol·direction per IST day, re-armed only by a higher band — see lib/circuitDedupe) → chime (if audio is on), banner event, and `onFire` (e-mail dispatch).
 * `glow` maps each symbol currently sitting at a circuit to its direction (drives the pulsing card border).
 */
export function useCircuitAlerts(engine: MarketEngine, version: number, symbols: string[], audioOn: boolean, onFire?: (hit: CircuitHit) => void, demo = false) {
  const tracker = useRef(new CircuitTracker(8000));
  const dedupe = useRef<CircuitDedupe | null>(null);
  const demoRef = useRef(false);
  const demoDedupe = useRef(new CircuitDedupe());
  const seq = useRef(1);
  const audioRef = useRef(audioOn);
  audioRef.current = audioOn;
  const fireRef = useRef(onFire);
  fireRef.current = onFire;
  const [events, setEvents] = useState<CircuitEvent[]>([]);
  /** every confirmed hit this session, newest first (feeds the Circuit Hit Log) */
  const [log, setLog] = useState<CircuitEvent[]>([]);
  const [glow, setGlow] = useState<Record<string, CircuitDir>>({});
  const key = symbols.join(',');

  useEffect(() => {
    const now = Date.now();
    // circuit alerts only exist while the session is open: off-market prices are last-close / replayed values, never a fresh circuit hit
    // the demo gets its own tracker + in-memory dedupe so it never consumes (or is blocked by) the real daily lock
    if (demo !== demoRef.current) {
      demoRef.current = demo;
      tracker.current = new CircuitTracker(8000);
      demoDedupe.current = new CircuitDedupe();
      setGlow({});
    }
    if (!demo && !isMarketOpen(now)) {
      setGlow((g) => (Object.keys(g).length ? {} : g));
      return;
    }
    const nextGlow: Record<string, CircuitDir> = {};
    const fresh: CircuitEvent[] = [];
    for (const s of symbols) {
      const q = engine.quotes.get(s);
      if (!q) continue;
      const hit = tracker.current.observe(q, now);
      if (!dedupe.current) dedupe.current = new CircuitDedupe(safeStore());
      // daily lock: one alert per symbol+direction per IST day; re-fires only on escalation to a higher band
      if (hit && (demo ? demoDedupe.current : dedupe.current).shouldFire(hit.symbol, hit.band, hit.dir, now)) fresh.push({ ...hit, id: seq.current++, at: now, ...(demo ? { demo: true } : {}) });
      const cur = circuitHit(q);
      if (cur && tracker.current.active().includes(s)) nextGlow[s] = cur.dir;
    }
    setGlow((prev) => {
      const a = Object.keys(prev).sort().join() + Object.values(prev).join();
      const b = Object.keys(nextGlow).sort().join() + Object.keys(nextGlow).sort().map((k) => nextGlow[k]).join();
      return a === b ? prev : nextGlow;
    });
    if (fresh.length) {
      setEvents((e) => [...fresh, ...e].slice(0, 6));
      setLog((l) => [...fresh, ...l].slice(0, 500));
      if (audioRef.current) playChime(fresh[0].dir);
      if (!demo) fresh.forEach((h) => fireRef.current?.(h)); // demo hits are never e-mailed
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, key, engine, demo]);

  const dismiss = (id: number) => setEvents((e) => e.filter((x) => x.id !== id));
  const clearLog = () => {
    setLog([]);
    setEvents([]);
  };
  return { events, log, glow, dismiss, clearLog };
}
