'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { MarketEngine, SmartApiFeed, isMarketOpen, type FeedConn, type FeedMode, type FeedSource } from '@/lib/market';
import type { Candle, Instrument, Timeframe } from '@/lib/types';
import type { YahooRow } from '@/lib/yahooData';

/** WebSocket URL of the SmartAPI relay (scripts/angel-relay.ts), e.g. wss://relay.example.com. Unset → Yahoo only. */
const FEED_URL = process.env.NEXT_PUBLIC_FEED_WS_URL;

export type DataState = 'loading' | 'ok' | 'error';

const INDEX_IDS = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'INDIAVIX'];
const CHUNK = 40;
const uniq = <T,>(a: T[]) => Array.from(new Set(a));

/**
 * Owns the market engine. REAL data only:
 *   • Yahoo Finance (delayed) through /api/quotes + /api/bars — the default, polled every 10 s while the market is open (60 s when closed)
 *   • SmartAPI relay ticks (wss) when connected — they take over price / volume / depth for the symbols they carry
 * Feed mode is re-evaluated every second: live (open + ticks) · snapshot (closed + relay ticks) · delayed (Yahoo).
 * Nothing is generated locally: until the first Yahoo batch arrives `state` is 'loading', and if Yahoo cannot be reached it is 'error'.
 */
export function useMarket(universe: Instrument[], selected: string, watch: string[], focus: string[] = []) {
  const engine = useMemo(() => new MarketEngine(universe), [universe]);
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const [conn, setConn] = useState<FeedConn>('idle');
  const [mode, setMode] = useState<FeedMode>('delayed');
  const [source, setSource] = useState<FeedSource | undefined>();
  const [state, setState] = useState<DataState>('loading');
  const feedRef = useRef<SmartApiFeed | null>(null);
  const selRef = useRef(selected);
  selRef.current = selected;
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const seedRef = useRef<string[]>([]);
  seedRef.current = useMemo(() => universe.filter((i) => i.sector && i.sector !== 'Others').map((i) => i.symbol).slice(0, 300), [universe]);

  const watchKey = watch.join(',');
  const focusKey = focus.join(',');
  useEffect(() => {
    engine.want([...focus, ...watch]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, watchKey, focusKey]);

  /* ── Yahoo quotes ── */
  const fetchQuotes = useCallback(
    async (syms: string[]): Promise<boolean> => {
      const list = uniq(syms).filter(Boolean);
      let ok = false;
      for (let i = 0; i < list.length; i += CHUNK) {
        const part = list.slice(i, i + CHUNK).map((s) => (INDEX_IDS.includes(s) ? s : `${s}:${engine.master.get(s)?.exch ?? 'NSE'}`));
        try {
          const res = await fetch(`/api/quotes?s=${encodeURIComponent(part.join(','))}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
          if (!res.ok) continue;
          const j = (await res.json()) as { ok: boolean; rows?: YahooRow[] };
          if (j.ok && j.rows?.length) {
            engine.ingestRows(j.rows);
            ok = true;
          }
        } catch {
          /* network / timeout — the next cycle retries */
        }
      }
      return ok;
    },
    [engine],
  );

  useEffect(() => {
    let alive = true;
    let failures = 0;
    let lastSeed = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const priority = () => uniq([selRef.current, ...focusRef.current, ...watchRef.current, ...engine.wantedQuotes(), ...INDEX_IDS]);

    const cycle = async () => {
      if (!alive) return;
      if (typeof document !== 'undefined' && document.hidden && engine.ready) return void timers.push(setTimeout(cycle, 5000));
      const ok = await fetchQuotes(priority());
      if (!alive) return;
      if (ok) {
        failures = 0;
        setState('ok');
        if (Date.now() - lastSeed > 60_000) {
          lastSeed = Date.now();
          void fetchQuotes(seedRef.current).then(() => alive && bump());
        }
      } else if (++failures >= 2 && !engine.ready) setState('error');
      bump();
      const open = isMarketOpen(Date.now());
      const wait = !ok ? Math.min(30_000, 3000 * 2 ** Math.min(failures, 3)) : open ? 10_000 : 60_000;
      timers.push(setTimeout(cycle, wait));
    };
    void cycle();
    const onVis = () => !document.hidden && void cycle();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [engine, fetchQuotes]);

  /* ── Yahoo bars (history the UI asked for: 1-minute tape of the selected / focus symbols, daily closes for analytics, index sparklines) ── */
  useEffect(() => {
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy || !alive || !engine.ready) return;
      busy = true;
      try {
        engine.historyOf(selRef.current, '1m');
        focusRef.current.forEach((s) => engine.historyOf(s, '1m'));
        INDEX_IDS.forEach((id) => engine.historyOf(id, '5m'));
        const now = Date.now();
        const open = isMarketOpen(now);
        // intraday bars refresh every minute while the market is open; everything else is stable for 10 minutes
        const age = (tf: Timeframe) => ((tf === '1m' || tf === '5m') && open ? 60_000 : 10 * 60_000);
        const due = engine.pendingHistory(now, 0).filter((x) => engine.pendingHistory(now, age(x.tf)).some((y) => y.symbol === x.symbol && y.tf === x.tf)).slice(0, 4);
        await Promise.all(
          due.map(async ({ symbol, tf }) => {
            let bars: Candle[] = [];
            try {
              const r = await fetch(`/api/bars/${encodeURIComponent(symbol)}?tf=${tf}&exch=${engine.master.get(symbol)?.exch ?? 'NSE'}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
              if (r.ok) bars = ((await r.json()) as { bars?: Candle[] }).bars ?? [];
            } catch {
              /* leave empty — retried after the max age */
            }
            if (alive) engine.ingestBars(symbol, tf, bars);
          }),
        );
      } finally {
        busy = false;
      }
    };
    const id = setInterval(load, 2500);
    void load();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [engine]);

  /* ── SmartAPI relay (optional) ── */
  useEffect(() => {
    if (!FEED_URL) return;
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && FEED_URL.startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1)/.test(FEED_URL))
      console.warn('[UpCircuit] NEXT_PUBLIC_FEED_WS_URL is ws:// on an https page — browsers block this; use wss://');
    const feed = new SmartApiFeed(FEED_URL, engine, setConn);
    feedRef.current = feed;
    feed.connect();
    return () => {
      feed.close();
      feedRef.current = null;
    };
  }, [engine]);

  useEffect(() => {
    feedRef.current?.setSymbols([selected, ...focus, ...watch, ...seedRef.current.slice(0, 80)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, selected, watchKey, focusKey, conn]);

  useEffect(() => {
    let i = 0;
    let lastMode: FeedMode | null = null;
    let lastSource: FeedSource | undefined;
    const evalMode = () => {
      const now = Date.now();
      const open = isMarketOpen(now);
      // heartbeats alone don't make it live — real ticks (Angel One or the relay's Yahoo fallback) must be flowing
      const streaming = feedRef.current?.status === 'open' && now - (feedRef.current?.lastTickAt ?? 0) < 45_000;
      if (feedRef.current?.source !== lastSource) setSource((lastSource = feedRef.current?.source));
      const relayTicking = feedRef.current?.status === 'open' && (feedRef.current?.ticks ?? 0) > 0;
      const m: FeedMode = open && streaming ? 'live' : !open && relayTicking ? 'snapshot' : 'delayed';
      if (m !== lastMode) {
        lastMode = m;
        engine.setMode(m);
        setMode(m);
      }
    };
    evalMode();
    const id = setInterval(() => {
      if (i % 4 === 0) evalMode();
      engine.step(selRef.current, Date.now());
      if (++i % 2 === 0) bump();
    }, 250);
    bump();
    return () => clearInterval(id);
  }, [engine]);

  const retry = useCallback(() => {
    setState('loading');
    void fetchQuotes([selRef.current, ...INDEX_IDS]).then((ok) => setState(ok || engine.ready ? 'ok' : 'error'));
  }, [engine, fetchQuotes]);

  return { engine, version, mode, conn, source, state, retry };
}
