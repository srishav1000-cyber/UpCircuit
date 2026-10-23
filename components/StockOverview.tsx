'use client';

import { useMemo, useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import type { Fundamentals, Instrument, Quote } from '@/lib/types';
import { fundamentalsOf, orNA, ratioTone, type Tone } from '@/lib/fundamentals';
import { getScreener, peerCandidates, rangePct } from '@/lib/screener';
import { mergeLive } from '@/lib/yahooFundamentals';
import { liveFundamentals, smartApiLabel } from '@/lib/liveFundamentals';
import { useFundamentals } from '@/hooks/useFundamentals';
import { dayPct } from '@/lib/analytics';
import { fmt, fmtCr, fmtPct, tone as signTone } from '@/lib/format';
import { Badge, Card } from './ui';

const DOT: Record<Tone, string> = { good: 'bg-up', ok: 'bg-warn', bad: 'bg-down', na: 'bg-muted/50' };

function Ratio({ label, value, sub, t = 'na', live }: { label: string; value: React.ReactNode; sub?: React.ReactNode; t?: Tone; live?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-bg/50 p-2.5" data-testid="ratio-cell">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[t]}`} aria-hidden />
        <span className="truncate">{label}</span>
        {live && <span data-testid="ratio-live" className="ml-auto shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1 text-[8.5px] font-semibold normal-case tracking-normal text-emerald-400">[{live}]</span>}
      </div>
      <div className="num mt-1 truncate text-[15px] font-semibold text-ink">{value}</div>
      {sub && <div className="num truncate text-[10.5px] text-muted">{sub}</div>}
    </div>
  );
}

/** Horizontal range bar: track, filled portion to the marker, low / high labels, optional centre label. */
function RangeBar({ label, lo, hi, value, loText, hiText, mid, gradient, testId }: { label: string; lo: number; hi: number; value: number; loText: string; hiText: string; mid?: string; gradient?: boolean; testId: string }) {
  const pct = rangePct(value, lo, hi);
  return (
    <div data-testid={testId} data-pct={pct.toFixed(1)}>
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="font-semibold text-ink">{label}</span>
        {mid && <span className="num text-muted">{mid}</span>}
      </div>
      <div className="relative h-2 rounded-full bg-line">
        <div className={`absolute inset-y-0 left-0 rounded-full ${gradient ? 'bg-gradient-to-r from-down/50 via-warn/40 to-up/50' : 'bg-accent/35'}`} style={{ width: gradient ? '100%' : `${pct}%` }} />
        <div className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-ink shadow ring-2 ring-panel" style={{ left: `${pct}%` }} title={`₹${fmt(value)}`} />
      </div>
      <div className="num mt-1 flex justify-between text-[10.5px] text-muted">
        <span>{loText}</span>
        <span className="text-ink">₹{fmt(value)}</span>
        <span>{hiText}</span>
      </div>
    </div>
  );
}

const HOLD: { key: 'promoters' | 'institutions' | 'public'; label: string; bar: string }[] = [
  { key: 'promoters', label: 'Promoters', bar: 'bg-accent' },
  { key: 'institutions', label: 'Institutions (FII + DII)', bar: 'bg-up' },
  { key: 'public', label: 'Public', bar: 'bg-muted' },
];

interface Props {
  quote: Quote;
  engine: MarketEngine;
  instruments: Instrument[];
  /** open a peer's chart */
  onOpenPeer: (symbol: string) => void;
  onResearch: () => void;
}

/** Context-aware Screener.in + Angel One style fundamentals for the stock being inspected. Real figures or N/A (see lib/screener.ts). */
export function StockOverview({ quote: rawQuote, engine, instruments, onOpenPeer, onResearch }: Props) {
  // null-safe quote: any missing / non-finite field falls back to a sane default so the widgets never crash or render blank
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const ltp0 = num(rawQuote?.ltp, 100);
  const band = num(rawQuote?.circuitBand, 20);
  const quote = {
    ...rawQuote,
    symbol: rawQuote?.symbol || '—',
    name: rawQuote?.name || rawQuote?.symbol || '—',
    sector: rawQuote?.sector || 'Others',
    ltp: ltp0,
    prevClose: num(rawQuote?.prevClose, ltp0),
    high: num(rawQuote?.high, ltp0),
    low: num(rawQuote?.low, ltp0),
    mcapCr: num(rawQuote?.mcapCr, 1000),
    circuitBand: band,
    upperCircuit: num(rawQuote?.upperCircuit, ltp0 * (1 + band / 100)),
    lowerCircuit: num(rawQuote?.lowerCircuit, ltp0 * (1 - band / 100)),
  } as typeof rawQuote;
  const live = useFundamentals(quote.symbol, quote.exch ?? 'NSE');
  const s = useMemo(() => mergeLive(getScreener(quote), live.data, quote.ltp), [quote.symbol, quote.sector, quote.mcapCr, Math.round(quote.ltp * 20), Math.round(quote.high * 20), Math.round(quote.low * 20), live.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const lf = liveFundamentals({ ltp: quote.ltp, mode: engine.mode, sharesCr: engine.sharesOf(quote.symbol), eps: s.eps, bookValue: s.bookValue, yahooMcapCr: s.marketCapCr, yahooPe: s.pe });
  const sa = (c: { source: string }) => (c.source === 'smartapi' ? smartApiLabel(engine.mode) : undefined);
  const f: Fundamentals = fundamentalsOf(s);
  const [qMode, setQMode] = useState<'values' | 'qoq'>('values');

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const peers = useMemo(() => peerCandidates(instruments, quote.symbol, quote.sector, 5, (s) => engine.quotes.get(s)?.mcapCr ?? 0), [instruments, quote.symbol, quote.sector, engine, engine.lastQuotesAt]);
  const peerRows = peers.flatMap((i) => {
    try {
      const pq = engine.touch(i.symbol);
      return pq ? [{ i, q: pq }] : [];
    } catch {
      return [];
    }
  });

  const peLabel = '';
  const lowCirc = quote.lowerCircuit;
  const upCirc = quote.upperCircuit;
  const th = 'px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-muted';
  const td = 'num px-2 py-1.5 text-right text-[12px] text-ink';

  const qoq = (i: number, k: 'sales' | 'expenses' | 'operatingProfit' | 'netProfit' | 'eps') => {
    const a = s.quarters[i - 1]?.[k];
    const b = s.quarters[i]?.[k] ?? 0;
    return a ? ((b - a) / Math.abs(a)) * 100 : null;
  };
  const rows: { label: string; key: 'sales' | 'expenses' | 'operatingProfit' | 'netProfit' | 'eps'; bold?: boolean }[] = [
    { label: 'Sales / Revenue', key: 'sales', bold: true },
    { label: 'Expenses', key: 'expenses' },
    { label: 'Operating Profit (EBITDA)', key: 'operatingProfit', bold: true },
    { label: 'Net Profit', key: 'netProfit', bold: true },
    { label: 'EPS (₹)', key: 'eps' },
  ];

  return (
    <div className="space-y-3" data-testid="stock-overview" data-symbol={quote.symbol}>
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg" aria-hidden>📋</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-bold leading-tight text-ink">{quote.symbol} · Fundamentals</h2>
          <p className="truncate text-[11px] text-muted">{quote.name} · {quote.sector} · <Badge>{quote.exch ?? 'NSE'}</Badge></p>
        </div>
        <span
          data-testid="fund-source"
          data-state={s.source.live ? 'live' : live.status}
          title={s.source.live ? `Real figures from our fundamentals provider. Not available: ${s.source.na.join(', ') || 'none'}.` : live.status === 'loading' ? 'Fetching verified fundamentals…' : 'The data provider has no fundamentals for this scrip — figures show N/A.'}
          className={`shrink-0 rounded px-2 py-1 text-[10px] font-bold tracking-wide ${s.source.live ? 'bg-up/15 text-up' : live.status === 'loading' ? 'animate-pulse bg-line text-muted' : 'bg-warn/15 text-warn'}`}
        >
          {s.source.live ? '● VERIFIED FUNDAMENTALS' : live.status === 'loading' ? 'LOADING…' : 'N/A · NO PROVIDER DATA'}
        </span>
        <button onClick={onResearch} className="h-8 shrink-0 rounded-md border border-line px-2.5 text-[12px] font-semibold text-accent hover:bg-accent/10">Full research ↗</button>
      </div>

      {/* 1 · key ratios */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Key ratios">
        <Ratio label="Market Cap" live={sa(lf.marketCapCr)} value={orNA(lf.marketCapCr.value, (n) => `₹${fmtCr(n).replace(/^₹/, '')}`)} sub={lf.marketCapCr.value === null ? undefined : `₹${fmt(lf.marketCapCr.value, 0)} Cr`} />
        <Ratio label="Current Price" value={`₹${fmt(quote.ltp)}`} sub={s.high52 === null || s.low52 === null ? '52W N/A' : `52W ${fmt(s.high52)} / ${fmt(s.low52)}`} />
        <Ratio label="Stock P/E" live={sa(lf.pe)} value={orNA(lf.pe.value, (n) => n.toFixed(1))} sub="Industry P/E N/A" t={ratioTone('pe', f)} />
        <Ratio label="Book Value" live={sa(lf.pb)} value={orNA(s.bookValue, (n) => `₹${fmt(n)}`)} sub={lf.pb.value === null ? undefined : `P/B ${lf.pb.value.toFixed(1)}`} />
        <Ratio label="Dividend Yield" value={orNA(s.dividendYield, (n) => `${n.toFixed(2)}%`)} t={ratioTone('dividendYield', f)} />
        <Ratio label="ROCE / ROE" value={`${orNA(s.roce, (n) => `${n.toFixed(1)}%`)} / ${orNA(s.roe, (n) => `${n.toFixed(1)}%`)}`} t={ratioTone('roce', f)} />
        <Ratio label="Face Value / D:E" value={`${orNA(s.faceValue, (n) => `₹${n}`)} / ${orNA(s.debtToEquity, (n) => n.toFixed(2))}`} t={ratioTone('debtToEquity', f)} />
        <Ratio label="EPS (TTM)" value={orNA(s.eps, (n) => `₹${fmt(n)}`)} />
      </div>

      {/* 2 · circuit + range bars */}
      <Card title="Price bands & ranges" right={<span className={`num text-[11px] ${signTone(dayPct(quote))}`}>{fmtPct(dayPct(quote))} today</span>}>
        <div className="space-y-4 p-3">
          <RangeBar testId="bar-circuit" label={`Circuit limits · ±${quote.circuitBand}%`} lo={lowCirc} hi={upCirc} value={quote.ltp} loText={`Lower ₹${fmt(lowCirc)}`} hiText={`Upper ₹${fmt(upCirc)}`} gradient />
          {s.low52 !== null && s.high52 !== null ? (
            <RangeBar testId="bar-52w" label="52-week range" lo={s.low52} hi={s.high52} value={quote.ltp} loText={`Low ₹${fmt(s.low52)}`} hiText={`High ₹${fmt(s.high52)}`} mid={`${(((quote.ltp - s.low52) / s.low52) * 100).toFixed(1)}% above low · ${(((s.high52 - quote.ltp) / s.high52) * 100).toFixed(1)}% below high`} />
          ) : (
            <div data-testid="bar-52w-na" className="text-[11px] text-muted"><span className="font-semibold text-ink">52-week range</span> · N/A (not provided by the data source)</div>
          )}
          <RangeBar testId="bar-day" label="Day's range" lo={quote.low} hi={quote.high} value={quote.ltp} loText={`Low ₹${fmt(quote.low)}`} hiText={`High ₹${fmt(quote.high)}`} />
        </div>
      </Card>

      {/* 3 · quarterly results */}
      <Card
        title="Quarterly results"
        right={
          <div className="flex gap-1" role="group" aria-label="Quarterly view">
            {([['values', '₹ Cr'], ['qoq', 'QoQ %']] as const).map(([id, l]) => (
              <button key={id} onClick={() => setQMode(id)} aria-pressed={qMode === id} data-testid={`q-${id}`} className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${qMode === id ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted hover:text-ink'}`}>{l}</button>
            ))}
          </div>
        }
      >
        {s.quarters.length === 0 ? (
          <p className="px-2 py-4 text-center text-[12px] text-muted" data-testid="quarterly-na">N/A — quarterly results are not available for this scrip.</p>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[460px] border-collapse" data-testid="quarterly-table">
            <thead>
              <tr className="border-b border-line">
                <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-muted">₹ Cr</th>
                {s.quarters.map((q) => <th key={q.label} className={th}>{q.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-line/60 hover:bg-line/40">
                  <td className={`px-2 py-1.5 text-left text-[12px] ${r.bold ? 'font-semibold text-ink' : 'text-muted'}`}>{r.label}</td>
                  {s.quarters.map((q, i) => {
                    if (qMode === 'qoq') {
                      const g = i === 0 ? null : qoq(i, r.key);
                      return <td key={q.label} className={`${td} ${g === null ? 'text-muted' : signTone(r.key === 'expenses' ? -g : g)}`}>{g === null ? '—' : fmtPct(g, 1)}</td>;
                    }
                    return <td key={q.label} className={`${td} ${r.bold ? 'font-semibold' : ''}`}>{r.key === 'eps' ? fmt(q[r.key]) : fmt(q[r.key], 1)}</td>;
                  })}
                </tr>
              ))}
              <tr className="hover:bg-line/40">
                <td className="px-2 py-1.5 text-left text-[12px] text-muted">OPM %</td>
                {s.quarters.map((q) => <td key={q.label} className={td}>{q.opmPct.toFixed(1)}%</td>)}
              </tr>
            </tbody>
          </table>
        </div>
        )}
      </Card>

      {/* 4 · peers */}
      <Card title={`Peer comparison · ${quote.sector}`} right={<span className="text-[10px] text-muted">live quotes</span>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[460px] border-collapse" data-testid="peer-table">
            <thead>
              <tr className="border-b border-line">
                <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-muted">Company</th>
                <th className={th}>CMP ₹</th>
                <th className={th}>Day %</th>
                <th className={th}>Mkt Cap ₹ Cr</th>
                <th className={th}>Volume</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/60 bg-accent/10" data-testid="peer-self">
                <td className="max-w-[160px] truncate px-2 py-1.5 text-left text-[12px] font-semibold text-accent">{quote.name} <span className="text-muted">(this)</span></td>
                <td className={td}>{fmt(quote.ltp)}</td><td className={td}>{fmtPct(dayPct(quote))}</td><td className={td}>{orNA(s.marketCapCr, (n) => fmt(n, 0))}</td><td className={td}>{quote.volume > 0 ? fmt(quote.volume, 0) : 'N/A'}</td>
              </tr>
              {peerRows.map(({ i, q }) => (
                <tr key={i.symbol} onClick={() => onOpenPeer(i.symbol)} className="cursor-pointer border-b border-line/60 hover:bg-line/40" data-testid="peer-row" data-symbol={i.symbol}>
                  <td className="max-w-[160px] truncate px-2 py-1.5 text-left text-[12px] text-ink" title={i.name}>{i.name}</td>
                  <td className={td}>{fmt(q.ltp)}</td><td className={td}>{fmtPct(dayPct(q))}</td><td className={td}>{q.mcapCr > 0 ? fmt(q.mcapCr, 0) : 'N/A'}</td><td className={td}>{q.volume > 0 ? fmt(q.volume, 0) : 'N/A'}</td>
                </tr>
              ))}
              {peerRows.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-4 text-center text-[12px] text-muted">No other {quote.sector} stocks in the instrument master.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 5 · shareholding */}
      <Card title="Shareholding pattern">
        {s.holding === null ? (
          <p className="p-3 text-center text-[12px] text-muted" data-testid="shareholding-na">N/A — shareholding is not available for this scrip.</p>
        ) : (
          <div className="space-y-2.5 p-3" data-testid="shareholding">
            <div className="flex h-3 overflow-hidden rounded-full" role="img" aria-label={HOLD.map((h) => `${h.label} ${s.holding![h.key]}%`).join(', ')}>
              {HOLD.map((h) => <div key={h.key} className={h.bar} style={{ width: `${s.holding![h.key]}%` }} title={`${h.label} ${s.holding![h.key]}%`} />)}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {HOLD.map((h) => (
                <div key={h.key} className="flex items-center gap-2 text-[12px]">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${h.bar}`} aria-hidden />
                  <span className="text-muted">{h.label}</span>
                  <span className="num ml-auto font-semibold text-ink">{s.holding![h.key].toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
      <p className="text-[10px] text-muted">Fundamentals come from a verified data provider where available; otherwise they show N/A. Not investment advice.</p>
    </div>
  );
}
