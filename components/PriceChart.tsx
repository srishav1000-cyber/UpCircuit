'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { ColorType, CrosshairMode, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle, Timeframe } from '@/lib/types';
import { TF_CONFIG, bucketTime, isMarketOpen } from '@/lib/market';
import { resolveIndex } from '@/lib/instruments';
import { parseDrawings, type Drawing, type Tool } from '@/lib/drawings';
import { DrawingToolbar } from './DrawingToolbar';
import { DrawingLayer } from './DrawingLayer';
import { CHART_THEME, type ThemeName } from '@/lib/theme';
import { fmt, fmtInt, tone } from '@/lib/format';
import { scoped } from '@/lib/scope';

const toBar = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
const toVol = (c: Candle, th: (typeof CHART_THEME)[ThemeName]) => ({ time: c.time as UTCTimestamp, value: c.volume, color: (c.close >= c.open ? th.up : th.down) + '73' });

const DRAW_KEY = 'upcircuit:drawings:';

const GROUPS: { label: string; items: Timeframe[] }[] = [
  { label: 'Intraday', items: ['1m', '5m', '15m', '1h'] },
  { label: 'Bars', items: ['1D', '1W', '1M'] },
  { label: 'Range', items: ['1Y', '5Y', '10Y'] },
];

interface Props {
  symbol: string;
  ltp: number;
  /** cumulative session volume — deltas feed the live candle's volume bar */
  volume: number;
  tf: Timeframe;
  onTf: (tf: Timeframe) => void;
  className?: string;
  /** true while SmartAPI ticks stream: the last candle then follows the LTP. On Yahoo data the candles are the real bars, refreshed every minute. */
  live?: boolean;
  /** zero-delay tick feed (engine.onTick): when given, every exchange tick updates the candle series immediately, outside React's render cycle */
  subscribeTicks?: (fn: (e: { symbol: string; ltp: number; volume: number; ts: number }) => void) => () => void;
}

export function PriceChart({ symbol, ltp, volume, tf, onTf, className = '', live = false, subscribeTicks }: Props) {
  const [dataState, setDataState] = useState<'loading' | 'ok' | 'empty'>('loading');
  const [reload, setReload] = useState(0);
  const loadedKey = useRef('');
  const liveRef = useRef(live);
  liveRef.current = live;
  const { resolvedTheme } = useTheme();
  // index tickers (NIFTY 50 / SENSEX / BANK NIFTY / INDIA VIX) have no volume or depth — synthesised candles, no volume pane
  const index = resolveIndex(symbol);
  const isIndex = !!index;
  const isIndexRef = useRef(isIndex);
  isIndexRef.current = isIndex;
  const themeName: ThemeName = resolvedTheme === 'light' ? 'light' : 'dark';
  const th = CHART_THEME[themeName];

  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const last = useRef<Candle | null>(null);
  const prevVolume = useRef(volume);
  const ltpRef = useRef(ltp);
  ltpRef.current = ltp;
  const thRef = useRef(th);
  thRef.current = th;
  const byTime = useRef(new Map<number, Candle>());
  const [hover, setHover] = useState<Candle | null>(null);
  const [liveBar, setLiveBar] = useState<Candle | null>(null);
  const barsRef = useRef<Candle[]>([]);
  const getBars = useCallback(() => barsRef.current, []);
  const [api, setApi] = useState<{ chart: IChartApi; series: ISeriesApi<'Candlestick'> } | null>(null);

  // maximize overlay + drawing state
  const [max, setMax] = useState(false);
  const [tool, setTool] = useState<Tool>('cursor');
  const [magnet, setMagnet] = useState(false);
  const [locked, setLocked] = useState(false);
  const [showDrawings, setShowDrawings] = useState(true);
  const [drawings, setDr] = useState<Drawing[]>([]);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  useEffect(() => {
    try {
      setDr(parseDrawings(localStorage.getItem(scoped(DRAW_KEY + symbol))));
    } catch {
      setDr([]);
    }
    setTool('cursor');
  }, [symbol]);
  const setDrawings = useCallback((fn: (cur: Drawing[]) => Drawing[]) => {
    setDr((cur) => {
      const next = fn(cur);
      try {
        localStorage.setItem(scoped(DRAW_KEY + symbolRef.current), JSON.stringify(next));
      } catch {
        /* storage unavailable — drawings live for this session only */
      }
      return next;
    });
  }, []);

  // Esc: disarm a drawing tool first, then leave the maximized view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (tool !== 'cursor') setTool('cursor');
      else if (max) setMax(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, max]);

  // create once
  useEffect(() => {
    if (!host.current) return;
    const t = thRef.current;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontSize: 12 },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: t.crosshair }, horzLine: { color: t.crosshair } },
      rightPriceScale: { borderColor: t.grid },
      timeScale: { borderColor: t.grid, timeVisible: true, secondsVisible: false, rightOffset: 6 },
    });
    const candles = chart.addCandlestickSeries({
      upColor: t.up,
      downColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
      borderVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.26 } });
    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.subscribeCrosshairMove((p) => setHover(p.time ? byTime.current.get(p.time as number) ?? null : null));
    chartRef.current = chart;
    candleRef.current = candles;
    volRef.current = vol;
    setApi({ chart, series: candles });
    return () => {
      setApi(null);
      chart.remove();
      chartRef.current = candleRef.current = volRef.current = null;
    };
  }, []);

  // re-theme in place (keeps zoom / scroll position)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: th.bg }, textColor: th.text },
      grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
      crosshair: { vertLine: { color: th.crosshair }, horzLine: { color: th.crosshair } },
      rightPriceScale: { borderColor: th.grid },
      timeScale: { borderColor: th.grid },
    });
    candleRef.current?.applyOptions({ upColor: th.up, downColor: th.down, wickUpColor: th.up, wickDownColor: th.down });
    // volume bars carry per-point colours
    if (last.current && volRef.current) {
      const hist = Array.from(byTime.current.values()).sort((a, b) => a.time - b.time);
      volRef.current.setData(hist.map((c) => toVol(c, th)));
    }
  }, [th]);

  // reload history when symbol / timeframe changes
  useEffect(() => {
    const candles = candleRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!candles || !vol || !chart) return;
    let cancelled = false;
    const key = `${symbol}|${tf}`;
    const first = loadedKey.current !== key;
    if (first) {
      setDataState('loading');
      candles.setData([]);
      vol.setData([]);
      last.current = null;
    }
    (async () => {
      let hist: Candle[] = [];
      try {
        // REAL Yahoo Finance bars — nothing is generated locally
        const r = await fetch(`/api/bars/${encodeURIComponent(index ? index.id : symbol)}?tf=${tf}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (r.ok) hist = ((await r.json()) as { bars?: Candle[] }).bars ?? [];
      } catch {
        /* leave empty */
      }
      if (cancelled || !candleRef.current) return;
      const keepRange = !first;
      const range = keepRange ? chart.timeScale().getVisibleLogicalRange() : null;
      candles.setData(hist.map(toBar));
      vol.setData(index ? [] : hist.map((c) => toVol(c, thRef.current)));
      candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: index ? 0.06 : 0.26 } });
      candles.applyOptions({ priceFormat: { type: 'price', precision: 2, minMove: index ? 0.01 : 0.05 } });
      byTime.current = new Map(hist.map((c) => [c.time, c]));
      barsRef.current = hist;
      last.current = hist[hist.length - 1] ?? null;
      setLiveBar(last.current);
      prevVolume.current = volume;
      setDataState(hist.length ? 'ok' : 'empty');
      loadedKey.current = key;
      if (first) {
        chart.applyOptions({ timeScale: { timeVisible: TF_CONFIG[tf].kind === 'intraday' } });
        if (tf === '1D') chart.timeScale().setVisibleLogicalRange({ from: hist.length - 130, to: hist.length + 6 });
        else chart.timeScale().fitContent();
        setHover(null);
      } else if (range) chart.timeScale().setVisibleLogicalRange(range);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tf, reload]);

  // while the market is open, refetch the real bars every minute (Yahoo's latest candle keeps forming)
  useEffect(() => {
    const id = setInterval(() => {
      if (!liveRef.current && isMarketOpen(Date.now()) && !document.hidden) setReload((n) => n + 1);
    }, 60_000);
    return () => clearInterval(id);
  }, []);


  // live tick → update / roll the last candle. `applyLive` is the single code path: it runs synchronously from the engine's tick listener
  // (every exchange tick, no batching) and, when no listener is wired, from the throttled React props as before.
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const readout = useRef<{ timer: ReturnType<typeof setTimeout> | null; bar: Candle | null }>({ timer: null, bar: null });
  const applyLive = useCallback((px: number, vol: number, now: number) => {
    const candles = candleRef.current;
    const v = volRef.current;
    const cur = last.current;
    if (!candles || !v || !cur || !liveRef.current || !(px > 0)) return; // Yahoo data: candles are the real bars, never extended locally
    const dv = Math.max(0, vol - prevVolume.current);
    prevVolume.current = vol;
    const bucket = bucketTime(tfRef.current, now);
    const next: Candle =
      bucket > cur.time
        ? { time: bucket, open: cur.close, high: Math.max(cur.close, px), low: Math.min(cur.close, px), close: px, volume: dv }
        : { ...cur, high: Math.max(cur.high, px), low: Math.min(cur.low, px), close: px, volume: cur.volume + dv };
    last.current = next;
    if (bucket > cur.time) barsRef.current = [...barsRef.current, next];
    else barsRef.current[barsRef.current.length - 1] = next;
    byTime.current.set(next.time, next);
    candles.update(toBar(next));
    if (!isIndexRef.current) v.update(toVol(next, thRef.current));
    if (host.current) { // diagnostics: how many candle updates the canvas received (verifies the zero-batching path)
      host.current.dataset.liveUpdates = String(Number(host.current.dataset.liveUpdates ?? 0) + 1);
      host.current.dataset.lastPx = String(px);
    }
    // the O/H/L/C text readout is DOM: refresh it at most every 250 ms (the canvas above is NOT throttled)
    readout.current.bar = next;
    if (!readout.current.timer) {
      readout.current.timer = setTimeout(() => {
        readout.current.timer = null;
        if (readout.current.bar) setLiveBar(readout.current.bar);
      }, 250);
    }
  }, []);
  useEffect(() => () => { if (readout.current.timer) clearTimeout(readout.current.timer); }, []);
  const direct = !!subscribeTicks && live;
  useEffect(() => {
    if (!direct || !subscribeTicks) return;
    const id = resolveIndex(symbol)?.id ?? symbol;
    return subscribeTicks((e) => {
      if (e.symbol === id) applyLive(e.ltp, e.volume, Date.now());
    });
  }, [direct, subscribeTicks, symbol, applyLive]);
  useEffect(() => {
    if (direct) return; // the listener above already applied this tick
    applyLive(ltp, volume, Date.now());
  }, [ltp, volume, tf, direct, applyLive]);

  const shown = hover ?? liveBar;

  return (
    <div className={max ? 'fixed inset-0 z-[66] flex flex-col bg-bg p-4' : `flex min-h-0 flex-col ${className}`} data-testid="price-chart" data-max={max}>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-line bg-panel px-3 py-1.5">
        {GROUPS.map((g, gi) => (
          <div key={g.label} className="flex items-center gap-0.5" role="group" aria-label={g.label}>
            {gi > 0 && <span className="mx-1.5 h-4 w-px bg-line" />}
            {g.items.map((t) => (
              <button
                key={t}
                onClick={() => onTf(t)}
                aria-pressed={tf === t}
                title={TF_CONFIG[t].kind === 'intraday' ? `${t} candles` : g.label === 'Range' ? `${t} range` : `${t === '1D' ? 'Daily' : t === '1W' ? 'Weekly' : 'Monthly'} candles`}
                className={`rounded px-2 py-1 text-[12px] font-semibold ${tf === t ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-line hover:text-ink'}`}
              >
                {t}
              </button>
            ))}
          </div>
        ))}
        {max && (
          <span className="num ml-3 flex items-baseline gap-2 text-[13px]">
            <b className="text-ink">{symbol}</b>
            <span className={tone(ltp - (liveBar?.open ?? ltp))}>{fmt(ltp)}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
        {shown && (
          <div className="num hidden gap-3 text-[11px] text-muted md:flex">
            <span>O <b className={tone(shown.close - shown.open)}>{fmt(shown.open)}</b></span>
            <span>H <b className={tone(shown.close - shown.open)}>{fmt(shown.high)}</b></span>
            <span>L <b className={tone(shown.close - shown.open)}>{fmt(shown.low)}</b></span>
            <span>C <b className={tone(shown.close - shown.open)}>{fmt(shown.close)}</b></span>
            {!isIndex && <span>V <b className="text-ink">{fmtInt(shown.volume)}</b></span>}
          </div>
        )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <DrawingToolbar
          tool={tool}
          onTool={(t) => {
            if (t !== 'cursor') setShowDrawings(true);
            setTool(t);
          }}
          magnet={magnet}
          onMagnet={() => setMagnet((m) => !m)}
          locked={locked}
          onLock={() => {
            setLocked((l) => !l);
            setTool('cursor');
          }}
          visible={showDrawings}
          onVisible={() => setShowDrawings((v) => !v)}
          count={drawings.length}
          onClear={() => setDrawings(() => [])}
        />
        <div className="relative min-h-[240px] min-w-0 flex-1">
          <div ref={host} className="absolute inset-0" />
          {dataState !== 'ok' && (
            <div data-testid="chart-status" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-[12px] text-muted">
              {dataState === 'loading' ? <span className="animate-pulse">Loading session bars…</span> : <span>No bars available for this symbol / timeframe.</span>}
            </div>
          )}
          <button
            onClick={() => setMax((m) => !m)}
            aria-pressed={max}
            aria-label={max ? 'Exit full screen terminal (Esc)' : 'Open full screen terminal'}
            title={max ? 'Exit full screen terminal (Esc)' : 'Expand the chart into a full-screen terminal with drawing tools'}
            data-testid="chart-max"
            className="absolute bottom-4 right-14 z-20 flex cursor-pointer items-center gap-1 rounded-md border border-line bg-panel/90 px-2.5 py-1 text-xs font-medium text-ink shadow-md hover:bg-line"
          >
            <span>{max ? 'Exit' : 'Terminal'}</span>
            <span aria-hidden className="text-[13px] leading-none">⧉</span>
          </button>
          {api && <DrawingLayer chart={api.chart} series={api.series} getBars={getBars} tool={tool} onTool={setTool} magnet={magnet} locked={locked} visible={showDrawings} drawings={drawings} setDrawings={setDrawings} />}
        </div>
      </div>
    </div>
  );
}


