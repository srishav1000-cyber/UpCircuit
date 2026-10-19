'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { MarketEngine, isMarketOpen, isStreamWindow, type FeedConn, type FeedMode, type LiveReason } from '@/lib/market';
import { DirectSmartApiStream, toEngineTick, type Listing, type MarketTick } from '@/lib/smartapiDirect';
import { useAuth } from '@/hooks/useAuth';
import type { Candle, Instrument, Timeframe } from '@/lib/types';
import type { YahooRow } from '@/lib/yahooData';

/** Public SmartAPI API key (build-time). Unset → the browser never opens the socket and the app runs on delayed Yahoo data. */
const API_KEY = process.env.NEXT_PUBLIC_SMARTAPI_API_KEY;
const RETRY_COOLDOWN_MS = 5 * 60_000;

export type DataState = 'loading' | 'ok' | 'error';

const INDEX_IDS = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'INDIAVIX'];
const CHUNK = 40;
const uniq = <T,>(a: T[]) => Array.from(new Set(a));

/**
 * Owns the market engine. REAL data only:
 *   • Yahoo Finance (delayed) through /api/quotes + /api/bars — the default, polled every 10 s while the market is open (60 s when closed)
 *   • Angel One SmartAPI ticks streamed DIRECTLY to this browser (lib/smartapiDirect.ts, tokens from /api/smartapi/session) —
 *     they take over price / volume / depth for the symbols they carry; any session, token or socket failure falls back to Yahoo
 * Feed mode is re-evaluated every second: live (open + ticks) · snapshot (closed + ticks) · delayed (Yahoo).
 * Nothing is generated locally: until the first Yahoo batch arrives `state` is 'loading', and if Yahoo cannot be reached it is 'error'.
 */
export function useMarket(universe: Instrument[], selected: string, watch: string[], focus: string[] = []) {
  const engine = useMemo(() => new MarketEngine(universe), [universe]);
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const [conn, setConn] = useState<FeedConn>('idle');
  const [mode, setMode] = useState<FeedMode>('delayed');
  const [liveReason, setLiveReason] = useState<LiveReason | undefined>(API_KEY ? undefined : 'no_key');
  const { getToken } = useAuth();
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const [state, setState] = useState<DataState>('loading');
  const feedRef = useRef<DirectSmartApiStream | null>(null);
  const listingsRef = useRef(new Map<string, Listing>());
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

  /* ── SmartAPI, direct browser → exchange socket (optional; Yahoo keeps running underneath as the fallback) ── */
  const applyTick = useCallback(
    (m: MarketTick) => {
      if (m.isIndex) engine.applyIndexTick(m.symbol, m.lastPrice, m.prevClose);
      else engine.applyTick(toEngineTick(m));
    },
    [engine],
  );

  useEffect(() => {
    if (!API_KEY) return;
    let alive = true;
    let stream: DirectSmartApiStream | null = null;
    let starting = false;
    let refreshed = false;
    let cooldownUntil = 0;
    const down = (why: LiveReason, cool = true) => {
      stream?.close();
      stream = feedRef.current = null;
      setConn('closed');
      setLiveReason(why);
      if (cool) cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
    };
    const start = async (refresh = false) => {
      if (starting || stream) return;
      starting = true;
      setConn('connecting');
      try {
        const token = await tokenRef.current();
        const r = await fetch(`/api/smartapi/session${refresh ? '?refresh=1' : ''}`, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; clientCode?: string; feedToken?: string; reason?: LiveReason };
        if (!alive) return;
        if (!r.ok || !j.ok || !j.clientCode || !j.feedToken) return down(j.reason ?? (r.status === 401 ? 'unauthorized' : 'unreachable'), j.reason !== 'rate_limited');
        const s = new DirectSmartApiStream({
          apiKey: API_KEY,
          clientCode: j.clientCode,
          feedToken: j.feedToken,
          onTick: applyTick,
          onStatus: (c) => alive && stream === s && setConn(c),
          onOpen: () => {
            setLiveReason(undefined);
            syncSubs();
          },
          onError: () => {
            // retries exhausted (or the server rejected the token): try ONE fresh session, then fall back to Yahoo
            const wasRefreshed = refreshed;
            s.close();
            if (stream === s) stream = feedRef.current = null;
            if (!alive) return;
            if (!wasRefreshed) {
              refreshed = true;
              void start(true);
            } else down('stream_failed');
          },
        });
        stream = feedRef.current = s;
        s.connect();
      } catch {
        if (alive) down('unreachable');
      } finally {
        starting = false;
      }
    };
    const gate = () => {
      const inWindow = isStreamWindow(Date.now());
      if (!inWindow) {
        if (stream) down('outside_hours', false);
        else setLiveReason((r) => r ?? 'outside_hours');
        setConn((c) => (c === 'connecting' ? 'idle' : c));
        return;
      }
      if (!stream && !starting && Date.now() >= cooldownUntil) {
        refreshed = false;
        void start();
      }
    };
    gate();
    const id = setInterval(gate, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
      stream?.close();
      stream = feedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, applyTick]);

  /** subscribe the symbols the UI needs (selected → focus basket → watchlist → top of the universe); tokens come from /api/smartapi/tokens */
  const subbing = useRef(false);
  const syncSubs = useCallback(async () => {
    const stream = feedRef.current;
    if (!stream || subbing.current) return;
    subbing.current = true;
    try {
      const want = uniq([selRef.current, ...focusRef.current, ...watchRef.current, ...seedRef.current.slice(0, 80)]).filter(Boolean);
      const missing = want.filter((s) => !listingsRef.current.has(s));
      for (let i = 0; i < missing.length; i += 100) {
        const part = missing.slice(i, i + 100);
        try {
          const r = await fetch(`/api/smartapi/tokens?s=${encodeURIComponent(part.join(','))}`, { signal: AbortSignal.timeout(30000) });
          const j = (await r.json()) as { ok?: boolean; listings?: Record<string, { token: string; exchangeType: number }> };
          for (const s of part) {
            const l = j.listings?.[s];
            // unknown symbols are remembered as "no token" so they are not re-requested every pass
            listingsRef.current.set(s, l ? { symbol: s, token: l.token, exchangeType: l.exchangeType } : { symbol: s, token: '', exchangeType: 0 });
          }
        } catch {
          break; // try again on the next change
        }
      }
      stream.subscribe(want.map((s) => listingsRef.current.get(s)).filter((l): l is Listing => !!l && !!l.token));
    } finally {
      subbing.current = false;
    }
  }, []);

  useEffect(() => {
    if (conn === 'open') void syncSubs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, selected, watchKey, focusKey, conn]);

  useEffect(() => {
    let i = 0;
    let lastMode: FeedMode | null = null;
    const evalMode = () => {
      const now = Date.now();
      const open = isMarketOpen(now);
      // an open socket alone doesn't make it live — real Angel One ticks must be flowing
      const streaming = feedRef.current?.status === 'open' && now - (feedRef.current?.lastTickAt ?? 0) < 45_000;
      const streamTicking = feedRef.current?.status === 'open' && (feedRef.current?.ticks ?? 0) > 0;
      const m: FeedMode = open && streaming ? 'live' : !open && streamTicking ? 'snapshot' : 'delayed';
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

  return { engine, version, mode, conn, liveReason, state, retry };
}
