'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isMarketOpen, type MarketEngine } from '@/lib/market';
import { CircuitTracker, circuitHit, type CircuitDir, type CircuitHit } from '@/lib/circuit';
import { CircuitDedupe } from '@/lib/circuitDedupe';
import type { AlertRow } from '@/lib/cloud';
import { fromEvent, fromRows, mergeHistory, type HistoryEntry } from '@/lib/circuitTracker';

function safeStore() {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; } catch { return undefined; }
}

export interface CircuitEvent extends CircuitHit {
  id: number;
  at: number;
  /** listing venue (NSE unless the instrument is BSE-only) */
  exch: 'NSE' | 'BSE';
  /** day volume (shares) when the alert fired */
  volume: number;
  /** produced by the ⚡ Demo Circuit Simulator — not market data */
  demo?: boolean;
}

/**
 * Watches the user's active watchlist + focus basket for upper / lower circuits on REAL prices.
 * A confirmed hit (once per symbol·direction per IST day, re-armed only by a higher band — see lib/circuitDedupe) → log entry + overlay event (CircuitAlertOverlay plays the alarm if audio is on), and `onFire` (e-mail dispatch).
 * `glow` maps each symbol currently sitting at a circuit to its direction (drives the pulsing card border).
 */
export function useCircuitAlerts(engine: MarketEngine, version: number, symbols: string[], onFire?: (hit: CircuitHit) => void, demo = false, loadHistory?: () => Promise<AlertRow[]>) {
  const tracker = useRef(new CircuitTracker(8000));
  const dedupe = useRef<CircuitDedupe | null>(null);
  const demoRef = useRef(false);
  const demoDedupe = useRef(new CircuitDedupe());
  const seq = useRef(1);
  const fireRef = useRef(onFire);
  fireRef.current = onFire;
  const [events, setEvents] = useState<CircuitEvent[]>([]);
  /** every confirmed hit this session, newest first (feeds the Circuit Hit Log) */
  const [log, setLog] = useState<CircuitEvent[]>([]);
  const [glow, setGlow] = useState<Record<string, CircuitDir>>({});
  const key = symbols.join(',');
  /** Supabase `alert_history` rows for this account (every real hit is written there by the page's onFire) */
  const [cloudRows, setCloudRows] = useState<AlertRow[]>([]);
  const loadRef = useRef(loadHistory);
  loadRef.current = loadHistory;
  const hasCloud = !!loadHistory;
  const refreshHistory = useCallback(async () => {
    const f = loadRef.current;
    if (!f) { setCloudRows([]); return; }
    try { setCloudRows(await f()); } catch { /* offline / table missing: the session log still works */ }
  }, []);
  useEffect(() => { void refreshHistory(); }, [hasCloud, refreshHistory]);

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
      if (hit && (demo ? demoDedupe.current : dedupe.current).shouldFire(hit.symbol, hit.band, hit.dir, now)) fresh.push({ ...hit, id: seq.current++, at: now, exch: q.exch ?? 'NSE', volume: q.volume ?? 0, ...(demo ? { demo: true } : {}) });
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
      // the alarm itself plays from CircuitAlertOverlay, once per card, so a queue of alerts sounds one after another
      if (!demo) fresh.forEach((h) => fireRef.current?.(h)); // demo hits are never e-mailed
      if (!demo) setTimeout(() => void refreshHistory(), 1500); // pick up the row the page just wrote (and other devices' hits)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, key, engine, demo]);

  const dismiss = (id: number) => setEvents((e) => e.filter((x) => x.id !== id));
  const clearLog = () => {
    setLog([]);
    setEvents([]);
  };
  /** session hits + cloud history, de-duplicated, newest first */
  const history: HistoryEntry[] = useMemo(() => mergeHistory(log.map(fromEvent), fromRows(cloudRows)), [log, cloudRows]);
  return { events, log, glow, dismiss, clearLog, history, refreshHistory, cloudRows };
}
