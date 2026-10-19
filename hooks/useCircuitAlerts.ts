'use client';

import { useEffect, useRef, useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import { CircuitTracker, circuitHit, type CircuitDir, type CircuitHit } from '@/lib/circuit';
import { playChime } from '@/lib/chime';

export interface CircuitEvent extends CircuitHit {
  id: number;
  at: number;
}

/**
 * Watches the user's active watchlist + focus basket for upper / lower circuits on REAL prices.
 * A confirmed hit (once per episode) → chime (if audio is on), banner event, and `onFire` (e-mail dispatch).
 * `glow` maps each symbol currently sitting at a circuit to its direction (drives the pulsing card border).
 */
export function useCircuitAlerts(engine: MarketEngine, version: number, symbols: string[], audioOn: boolean, onFire?: (hit: CircuitHit) => void) {
  const tracker = useRef(new CircuitTracker(8000));
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
    const nextGlow: Record<string, CircuitDir> = {};
    const fresh: CircuitEvent[] = [];
    for (const s of symbols) {
      const q = engine.quotes.get(s);
      if (!q) continue;
      const hit = tracker.current.observe(q, now);
      if (hit) fresh.push({ ...hit, id: seq.current++, at: now });
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
      fresh.forEach((h) => fireRef.current?.(h));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, key, engine]);

  const dismiss = (id: number) => setEvents((e) => e.filter((x) => x.id !== id));
  const clearLog = () => {
    setLog([]);
    setEvents([]);
  };
  return { events, log, glow, dismiss, clearLog };
}
