'use client';

import { useMemo } from 'react';
import { C } from '@/lib/theme';
import { fmt, fmtPct, tone } from '@/lib/format';
import { aggregateBars, detectPatterns, vwapSeries, PATTERN_WINDOW } from '@/lib/analytics/patterns';
import { rsiSeries } from '@/lib/analytics/rsi';
import { DataBadges } from './DataBadge';
import type { MarketEngine } from '@/lib/market';
import type { Candle, Quote } from '@/lib/types';

const SHOW = 60;
const W = 600;
const PH = 150;
const VH = 34;
const RH = 52;
const GAP = 6;
const PAD_R = 44;

const TONE: Record<'up' | 'down' | 'warn', string> = {
  up: 'border-up/50 bg-up/10 text-up',
  down: 'border-down/50 bg-down/10 text-down',
  warn: 'border-warn/50 bg-warn/10 text-warn',
};

/**
 * Mini candlestick chart for the selected focus stock: 5-minute candles (from real 1-minute bars), volume bars, session VWAP, RSI(14) sub-panel,
 * and automated pattern badges over the last 20 candles. "Expand" hands over to the full interactive chart (PriceChart).
 */
export function MiniStockChart({ engine, quote, onExpand }: { engine: MarketEngine; quote: Quote; onExpand: () => void }) {
  const symbol = quote.symbol;
  const hist = engine.historyOf(symbol, '1m');
  const live = engine.liveBars(symbol, '1m');
  const fromLive = live.length > 0 && (hist.length === 0 || live[live.length - 1].time > hist[hist.length - 1].time);
  const lastHist = hist.length ? hist[hist.length - 1].time : -Infinity;
  const src: Candle[] = fromLive ? [...hist, ...live.filter((b) => b.time > lastHist)] : hist;
  const data = useMemo(() => {
    const c5 = aggregateBars(src, 5);
    const bars = c5.slice(-SHOW);
    const vw = vwapSeries(c5).slice(-SHOW);
    const rs = rsiSeries(c5.map((b) => b.close), 14).slice(-SHOW);
    return { bars, vw, rs, patterns: detectPatterns(bars) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src.length, src[src.length - 1]?.close, src[src.length - 1]?.time, symbol]);
  const { bars, vw, rs, patterns } = data;
  const n = bars.length;
  const chg = quote.ltp - quote.prevClose;
  const kinds = fromLive ? (['smartapi', 'computed'] as const) : (['yahoo', 'computed'] as const);

  const body = (() => {
    if (n < 5) return <p className="py-10 text-center text-[12px] text-muted" data-testid="mini-chart-na">Collecting 1-minute bars for {symbol}… (N/A until at least 25 minutes of data)</p>;
    const lo = Math.min(...bars.map((b) => b.low));
    const hi = Math.max(...bars.map((b) => b.high));
    const span = hi - lo || 1;
    const maxV = Math.max(1, ...bars.map((b) => b.volume));
    const cw = (W - PAD_R) / n;
    const x = (i: number) => i * cw + cw / 2;
    const y = (v: number) => 4 + (1 - (v - lo) / span) * (PH - 8);
    const vy = (v: number) => PH + GAP + VH - (v / maxV) * VH;
    const ry = (v: number) => PH + GAP + VH + GAP + (1 - v / 100) * RH;
    const vwPts = vw.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
    const rsPts = rs.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${ry(v).toFixed(1)}`)).filter(Boolean).join(' ');
    const lastRsi = [...rs].reverse().find((v) => v !== null) ?? null;
    const H = PH + GAP + VH + GAP + RH;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${symbol} 5-minute candlestick chart with volume, VWAP and RSI`} style={{ aspectRatio: `${W} / ${H}`, height: 'auto' }} data-testid="mini-chart-svg" data-candles={n}>
        {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2={W - PAD_R} y1={4 + f * (PH - 8)} y2={4 + f * (PH - 8)} strokeWidth="0.5" style={{ stroke: C.muted, opacity: 0.25 }} />)}
        <text x={W - PAD_R + 4} y={y(hi) + 8} className="num" style={{ fill: C.muted, fontSize: 9 }}>{hi.toFixed(2)}</text>
        <text x={W - PAD_R + 4} y={y(lo)} className="num" style={{ fill: C.muted, fontSize: 9 }}>{lo.toFixed(2)}</text>
        {bars.map((b, i) => {
          const up = b.close >= b.open;
          const col = up ? C.up : C.down;
          const top = y(Math.max(b.open, b.close));
          const bot = y(Math.min(b.open, b.close));
          return (
            <g key={b.time}>
              <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} strokeWidth="1" style={{ stroke: col }} />
              <rect x={x(i) - cw * 0.35} y={top} width={cw * 0.7} height={Math.max(1, bot - top)} style={{ fill: col }} />
              <rect x={x(i) - cw * 0.35} y={vy(b.volume)} width={cw * 0.7} height={PH + GAP + VH - vy(b.volume)} style={{ fill: col, opacity: 0.55 }} />
            </g>
          );
        })}
        <rect x={(n - Math.min(PATTERN_WINDOW, n)) * cw} y="0" width={Math.min(PATTERN_WINDOW, n) * cw} height={PH} style={{ fill: C.accent, opacity: 0.04 }} />
        {vwPts && <polyline fill="none" strokeWidth="1.4" strokeDasharray="4 2" points={vwPts} style={{ stroke: C.warn }} />}
        <text x="2" y={PH + GAP + 8} className="num" style={{ fill: C.muted, fontSize: 8 }}>VOL</text>
        <line x1="0" x2={W - PAD_R} y1={ry(70)} y2={ry(70)} strokeWidth="0.5" strokeDasharray="3 3" style={{ stroke: C.down, opacity: 0.6 }} />
        <line x1="0" x2={W - PAD_R} y1={ry(30)} y2={ry(30)} strokeWidth="0.5" strokeDasharray="3 3" style={{ stroke: C.up, opacity: 0.6 }} />
        {rsPts && <polyline fill="none" strokeWidth="1.3" points={rsPts} style={{ stroke: C.accent }} />}
        <text x="2" y={PH + GAP + VH + GAP + 9} className="num" style={{ fill: C.muted, fontSize: 8 }}>RSI 14</text>
        <text x={W - PAD_R + 4} y={ry(lastRsi ?? 50) + 3} className="num" data-testid="mini-rsi" style={{ fill: C.accent, fontSize: 9 }}>{lastRsi === null ? 'N/A' : lastRsi.toFixed(0)}</text>
      </svg>
    );
  })();

  return (
    <div data-testid="mini-chart" data-symbol={symbol} data-patterns={patterns.map((p) => p.id).join(',')} className="rounded-md border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{symbol} · 5m candles</h3>
        <DataBadges kinds={[...kinds]} />
        <span className={`num text-[12px] font-semibold ${tone(chg)}`}>₹{fmt(quote.ltp)} {fmtPct((chg / quote.prevClose) * 100)}</span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted">
          <span><i className="mr-1 inline-block h-0.5 w-3 align-middle" style={{ background: C.warn }} />VWAP</span>
          <span><i className="mr-1 inline-block h-0.5 w-3 align-middle" style={{ background: C.accent }} />RSI</span>
          <button type="button" onClick={onExpand} data-testid="expand-chart" className="rounded border border-accent/60 bg-accent/10 px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent/20">🔍 Expand Full Chart</button>
        </span>
      </div>
      <div className="flex min-h-[28px] flex-wrap items-center gap-1.5 px-3 pt-2" data-testid="pattern-badges">
        {n >= 5 && patterns.length === 0 && <span className="text-[10px] text-muted">No pattern in the last {Math.min(PATTERN_WINDOW, n)} candles</span>}
        {patterns.map((p) => <span key={p.id} data-testid="pattern-badge" data-pattern={p.id} title={p.detail} className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE[p.tone]}`}>[{p.label}]</span>)}
      </div>
      <div className="p-3 pt-1">{body}</div>
      <p className="px-3 pb-2 text-[10px] text-muted">Patterns are rule-based descriptions of the last {PATTERN_WINDOW} candles (shaded), not forecasts. VWAP restarts each session; RSI uses Wilder smoothing on the displayed candles.</p>
    </div>
  );
}
