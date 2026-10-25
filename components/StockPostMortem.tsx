'use client';

import { TickPriceFlash } from './TickPriceFlash';
import { useMemo } from 'react';
import { Badge, Card, sentimentTone } from './ui';
import { DataBadge, liveKind } from './DataBadge';
import { SurgeMeter } from './dashboards/SurgeMeter';
import { OrderFlowHeatmap } from './OrderFlowHeatmap';
import { useFundamentals } from '@/hooks/useFundamentals';
import { getScreener } from '@/lib/screener';
import { mergeLive } from '@/lib/yahooFundamentals';
import { liveFundamentals, smartApiLabel, type LiveCell } from '@/lib/liveFundamentals';
import { fmt, fmtInt, fmtPct, tone } from '@/lib/format';
import { rsi14 } from '@/lib/analytics/rsi';
import { relativeStrength } from '@/lib/analytics/relative';
import { healthLights, type Light } from '@/lib/analytics/health';
import type { MarketEngine, FeedMode } from '@/lib/market';
import type { NewsResponse, Quote } from '@/lib/types';
import { relativeTime, sentimentChipText, stockNews, summarizeSentiment } from '@/lib/newsEngine';
import type { SourceKind } from '@/lib/methodology';

const DOT: Record<Light, string> = { green: 'bg-up shadow-[0_0_10px_rgb(var(--c-up)/0.7)]', yellow: 'bg-warn shadow-[0_0_10px_rgb(var(--c-warn)/0.7)]', red: 'bg-down shadow-[0_0_10px_rgb(var(--c-down)/0.7)]', na: 'bg-muted/50' };
const WORD: Record<Light, string> = { green: 'Healthy', yellow: 'Watch', red: 'Weak', na: 'N/A' };

/** Fundamentals + provenance tag: real value → [Yahoo Fundamentals], missing → [N/A]. Never estimated. */
function Cell({ label, value, kind, label2, title }: { label: string; value: string; kind: SourceKind; label2?: string; title?: string }) {
  return (
    <div className="rounded border border-line bg-bg px-2.5 py-2" data-testid="pm-cell" data-field={label} data-kind={kind} title={title}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`num mt-0.5 text-[15px] font-semibold ${kind === 'na' ? 'text-muted' : 'text-ink'}`}>{value}</div>
      <div className="mt-1"><DataBadge kind={kind} label={label2} /></div>
    </div>
  );
}

/** "Stock Post-Mortem": screener fundamentals, relative strength vs NIFTY 50, surge / order-flow gauges and four health lights for one stock. */
export function StockPostMortem({ engine, quote, mode, news }: { engine: MarketEngine; quote: Quote; mode: FeedMode | string; news?: NewsResponse | null }) {
  const symbol = quote.symbol;
  const drivers = stockNews(news?.items ?? [], symbol, quote.name, 6);
  const dSum = summarizeSentiment(drivers);
  const { data: live, status } = useFundamentals(symbol, quote.exch === 'BSE' ? 'BSE' : 'NSE');
  const s = useMemo(() => mergeLive(getScreener(quote), live, quote.ltp), [quote.symbol, quote.ltp, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const closesRaw = engine.closes(symbol);
  const closes = closesRaw.length ? [...closesRaw.slice(0, -1), quote.ltp] : [];
  const nifty = engine.indices.find((i) => i.id === 'NIFTY') ?? engine.indices[0];
  const benchCloses = engine.closes('NIFTY');
  const dayPct = quote.prevClose > 0 ? ((quote.ltp - quote.prevClose) / quote.prevClose) * 100 : null;
  const rel = relativeStrength(closes, benchCloses, dayPct, nifty?.loaded ? nifty.pct : null);
  const rsi = closes.length ? rsi14(closes) : null;
  const ret1m = rel.find((r) => r.id === '1M')?.stock ?? null;
  const vwap = quote.sumV > 0 ? quote.sumPV / quote.sumV : null;
  const lights = healthLights({ debtToEquity: s.debtToEquity, roe: s.roe, roce: s.roce, pe: s.pe, rsi, ret1mPct: ret1m, aboveVwap: vwap === null ? null : quote.ltp >= vwap });

  const yf = (v: number | null, f: (n: number) => string): { value: string; kind: SourceKind } => (v === null || !Number.isFinite(v) ? { value: 'N/A', kind: 'na' } : { value: f(v), kind: 'yahoo' });
  const lf = liveFundamentals({ ltp: quote.ltp, mode, sharesCr: engine.sharesOf(symbol), eps: s.eps, bookValue: s.bookValue, yahooMcapCr: s.marketCapCr, yahooPe: s.pe });
  const lc = (c: LiveCell, f: (n: number) => string): { value: string; kind: SourceKind; label2?: string; title?: string } =>
    c.value === null ? { value: 'N/A', kind: 'na' } : c.source === 'smartapi' ? { value: f(c.value), kind: 'smartapi', label2: smartApiLabel(mode), title: c.formula } : c.source === 'computed' ? { value: f(c.value), kind: 'computed', title: c.formula } : { value: f(c.value), kind: 'yahoo', label2: mode === 'delayed' ? 'Session Data' : 'Yahoo Fundamentals' };
  const cells: { label: string; value: string; kind: SourceKind; label2?: string; title?: string }[] = [
    { label: 'Market cap (₹ Cr)', ...lc(lf.marketCapCr, (n) => fmtInt(Math.round(n))) },
    { label: 'P/E ratio', ...lc(lf.pe, (n) => n.toFixed(1)) },
    { label: 'P/B ratio', ...lc(lf.pb, (n) => n.toFixed(2)) },
    { label: 'ROE (%)', ...yf(s.roe, (n) => n.toFixed(1)), label2: 'Yahoo Fundamentals' },
    { label: 'ROCE (%)', ...yf(s.roce, (n) => n.toFixed(1)), label2: 'Yahoo Fundamentals' },
    { label: 'Debt to equity', ...yf(s.debtToEquity, (n) => n.toFixed(2)), label2: 'Yahoo Fundamentals' },
    { label: 'Book value (₹)', ...yf(s.bookValue, (n) => n.toFixed(2)), label2: 'Yahoo Fundamentals' },
    { label: 'EPS (₹)', ...yf(s.eps, (n) => n.toFixed(2)), label2: 'Yahoo Fundamentals' },
    { label: 'Dividend yield (%)', ...yf(s.dividendYield, (n) => n.toFixed(2)), label2: 'Yahoo Fundamentals' },
  ];
  const pct = (v: number | null) => (v === null ? <span className="text-muted">N/A</span> : <span className={tone(v)}>{fmtPct(v)}</span>);

  return (
    <div data-testid="post-mortem" data-symbol={symbol} className="space-y-3">
      <Card title={`Screener fundamentals · ${symbol}`} right={<span className="flex items-center gap-1.5 text-[10px] text-muted">Last price <b className="num text-ink"><TickPriceFlash value={quote.ltp}>₹{fmt(quote.ltp)}</TickPriceFlash></b> <DataBadge kind={liveKind(mode as FeedMode)} /></span>}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {cells.map((c) => <Cell key={c.label} {...c} />)}
        </div>
        <p className="mt-2 text-[10px] text-muted">{status === 'loading' ? 'Loading fundamentals… ' : ''}Every figure is real or N/A — nothing is estimated. P/B = last price ÷ book value (computed). Banks and lenders have no meaningful debt-to-equity.</p>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title={`Relative strength vs NIFTY 50`} right={<span className="flex items-center gap-1"><DataBadge kind={liveKind(mode as FeedMode)} label={mode === 'live' ? 'SmartAPI Live · 1D' : mode === 'snapshot' ? 'SmartAPI Last Price · 1D' : 'Yahoo Delayed · 1D'} /><DataBadge kind="yahoo" label="Yahoo · 1W / 1M" /></span>}>
          <table className="num w-full text-[12px]" data-testid="rel-strength">
            <thead><tr className="text-left text-[10px] uppercase tracking-wider text-muted"><th className="pb-1 font-medium">Period</th><th className="pb-1 text-right font-medium">{symbol}</th><th className="pb-1 text-right font-medium">NIFTY 50</th><th className="pb-1 text-right font-medium">Relative</th></tr></thead>
            <tbody>
              {rel.map((r) => (
                <tr key={r.id} data-testid={`rs-${r.id}`} data-rs={r.rs === null ? 'na' : r.rs.toFixed(2)}>
                  <td className="py-1 text-muted">{r.id}{r.id === '1D' && (mode === 'live' || mode === 'snapshot') && <span className="ml-1 text-[9px] text-up" title="Live LTP % change − NIFTY 50 live % change">●</span>}</td>
                  <td className="py-1 text-right">{pct(r.stock)}</td>
                  <td className="py-1 text-right">{pct(r.bench)}</td>
                  <td className="py-1 text-right font-semibold">{r.rs === null ? <span className="text-muted">N/A</span> : <span className={tone(r.rs)}>{r.rs >= 0 ? '+' : '−'}{Math.abs(r.rs).toFixed(2)} pp {r.rs >= 0 ? '▲' : '▼'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-muted">Relative = stock return − NIFTY 50 return, in percentage points (positive = outperforming). 1D from live day change; 1W = 5 and 1M = 21 trading days of daily closes.</p>
        </Card>

        <Card title="Financial health" badges={['yahoo', 'computed']}>
          <ul className="space-y-2" data-testid="health-lights">
            {lights.map((l) => (
              <li key={l.id} data-testid={`health-${l.id}`} data-light={l.light} className="flex items-start gap-2.5">
                <span aria-hidden className={`mt-1 h-3 w-3 shrink-0 rounded-full ${DOT[l.light]}`} />
                <div className="min-w-0 text-[12px]">
                  <div className="font-semibold text-ink">{l.label} <span className="text-[10px] font-medium uppercase tracking-wider text-muted">· {WORD[l.light]}</span></div>
                  <div className="text-muted">{l.summary}</div>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-muted">Fixed rules of thumb (see Methodology): D/E ≤ 0.5 / 1.5, ROE ≥ 15 / 8, P/E ≤ 25 / 45, momentum from RSI, 1M return and VWAP. No sector adjustment; not advice.</p>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <SurgeMeter engine={engine} mode={mode} />
        <OrderFlowHeatmap engine={engine} symbol={symbol} />
      </div>

      <Card title={`News & event drivers · ${symbol}`} right={<span data-testid="pm-news-summary" className="text-[10px] text-muted">{sentimentChipText(dSum)}</span>}>
        {drivers.length === 0 ? (
          <p className="text-[12px] text-muted" data-testid="pm-news-empty">{news ? `No headlines in the live market feeds mention ${symbol} right now.` : 'Loading headlines…'}</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="pm-news">
            {drivers.map((n) => (
              <li key={n.id} className="flex items-start gap-2.5 py-2" data-testid="pm-news-item" data-label={n.label}>
                <Badge tone={sentimentTone(n.label)} className="mt-0.5 w-[66px] shrink-0 justify-center">{n.label.toUpperCase()}</Badge>
                <div className="min-w-0 flex-1">
                  {/^https?:\/\//.test(n.link) ? <a href={n.link} target="_blank" rel="noopener noreferrer" className="text-[12.5px] leading-snug text-ink hover:text-accent">{n.title}</a> : <span className="text-[12.5px] leading-snug text-ink">{n.title}</span>}
                  <div className="mt-0.5 text-[10px] text-muted">{n.source}{n.published ? ` · ${relativeTime(n.published)}` : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[10px] text-muted">Live RSS headlines that name {symbol} or {quote.name}; polarity from the local VADER + financial-rules scorer.</p>
      </Card>
    </div>
  );
}
