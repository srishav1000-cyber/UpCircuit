'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { MarketEngine, SmartApiFeed, isMarketOpen, type FeedConn, type FeedMode, type FeedSource } from '@/lib/market';
import type { Instrument } from '@/lib/types';

/** WebSocket URL of the SmartAPI relay (scripts/angel-relay.ts), e.g. wss://relay.example.com. Unset → no live feed. */
const FEED_URL = process.env.NEXT_PUBLIC_FEED_WS_URL;

/**
 * Owns the market engine. Steps every 250 ms, re-renders every 500 ms.
 * Feed mode is re-evaluated every second:
 *   market open  + relay connected → 'live'      (ticks drive prices)
 *   market open  + no relay        → 'simulated'
 *   market closed + relay ticking  → 'snapshot'  (relay data, no simulation)
 *   market closed + no ticks       → 'replay'
 */
export function useMarket(universe: Instrument[], selected: string, watch: string[], focus: string[] = []) {
  const engine = useMemo(() => new MarketEngine(universe), [universe]);
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const [conn, setConn] = useState<FeedConn>('idle');
  const [mode, setMode] = useState<FeedMode>('replay');
  const [source, setSource] = useState<FeedSource | undefined>();
  const selRef = useRef(selected);
  selRef.current = selected;
  const feedRef = useRef<SmartApiFeed | null>(null);

  // keep favourites / holdings simulated even if they aren't in the seed
  const watchKey = watch.join(',');
  const focusKey = focus.join(',');
  useEffect(() => {
    [...focus, ...watch].forEach((s) => engine.touch(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, watchKey, focusKey]);

  // live feed connection
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

  // subscribe to what the UI shows: the selected symbol, watchlist, holdings and the whole simulated universe's top names
  useEffect(() => {
    feedRef.current?.setSymbols([selected, ...focus, ...watch, ...Array.from(engine.quotes.keys()).slice(0, 80)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, selected, watchKey, focusKey, conn]);

  useEffect(() => {
    let i = 0;
    let lastMode: FeedMode | null = null;
    let lastSource: FeedSource | undefined;
    const evalMode = () => {
      const now = Date.now();
      const open = isMarketOpen(now);
      // heartbeats alone don't make it live — real ticks (Angel One or Yahoo) must be flowing
      const streaming = feedRef.current?.status === 'open' && now - (feedRef.current?.lastTickAt ?? 0) < 45_000;
      if (feedRef.current?.source !== lastSource) setSource((lastSource = feedRef.current?.source));
      const relayTicking = feedRef.current?.status === 'open' && (feedRef.current?.ticks ?? 0) > 0;
      const m: FeedMode = open ? (streaming ? 'live' : 'simulated') : relayTicking ? 'snapshot' : 'replay';
      if (m !== lastMode) {
        lastMode = m;
        engine.setMode(m === 'snapshot' ? 'live' : m);
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

  return { engine, version, mode, conn, source };
}
