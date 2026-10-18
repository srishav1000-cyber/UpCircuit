'use client';

import { useMemo, useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import { generateHistory } from '@/lib/market';
import type { NewsResponse, Quote } from '@/lib/types';
import { breadth, capClass, dayPct, topMovers, type CapClass } from '@/lib/analytics';
import { fmt, fmtCompact, fmtCr, fmtPct, fmtSigned, tone } from '@/lib/format';
import { Badge, Card, Sparkline } from './ui';
import { NewsFeed } from './NewsFeed';
import { BudgetDiscovery } from './BudgetDiscovery';
import type { Instrument } from '@/lib/types';

type CapFilter = 'All' | CapClass;

interface Props {
  engine: MarketEngine;
  news: NewsResponse | null;
  newsError: string | null;
  onOpenStock: (symbol: string) => void;
  instruments: Instrument[];
  /** budget cards open the stock's chart */
  onOpenChart: (symbol: string) => void;
}

function SummaryCard({ title, value, sub, subClass, children }: { title: string; value: string; sub?: string; subClass?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      <div className="num mt-1 text-xl font-semibold text-ink">{value}</div>
      {sub && <div className={`num text-[12px] ${subClass ?? 'text-muted'}`}>{sub}</div>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function MoverTable({ title, rows, kind, onOpen }: { title: string; rows: Quote[]; kind: 'gainers' | 'losers' | 'volume'; onOpen: (s: string) => void }) {
  return (
    <Card title={title}>
      <table className="num w-full text-[12px]">
        <thead className="text-[10px] uppercase tracking-wider text-muted">
          <tr>
            <th className="pb-1 text-left font-medium">Stock</th>
            <th className="text-right font-medium">LTP</th>
            <th className="text-right font-medium">{kind === 'volume' ? 'Volume' : 'Chg %'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={3} className="py-4 text-center text-muted">No stocks in this bucket</td></tr>
          )}
          {rows.map((q) => {
            const p = dayPct(q);
            return (
              <tr key={q.symbol} onClick={() => onOpen(q.symbol)} className="cursor-pointer border-t border-line hover:bg-line/60">
                <td className="py-1.5">
                  <button onClick={(e) => { e.stopPropagation(); onOpen(q.symbol); }} className="text-left">
                    <div className="font-semibold text-ink">{q.symbol}</div>
                    <div className="max-w-[130px] truncate text-[10px] text-muted">{q.name}</div>
                  </button>
                </td>
                <td className="text-right text-ink">{fmt(q.ltp)}</td>
                <td className={`text-right ${kind === 'volume' ? 'text-ink' : tone(p)}`}>
                  {kind === 'volume' ? (
                    <>
                      {fmtCompact(q.volume)}
                      <div className={`text-[10px] ${tone(p)}`}>{fmtPct(p)}</div>
                    </>
                  ) : (
                    fmtPct(p)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/** Angel One–style discovery home: market summary, movers by market-cap bucket, news with sentiment. */
export function HomePage({ engine, news, newsError, onOpenStock, instruments, onOpenChart }: Props) {
  const [cap, setCap] = useState<CapFilter>('All');
  const all = Array.from(engine.quotes.values());
  const counts = useMemo(() => {
    const c: Record<CapFilter, number> = { All: all.length, Large: 0, Mid: 0, Small: 0 };
    all.forEach((q) => c[capClass(q.mcapCr)]++);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.length, Math.round(engine.totalMcapCr() / 1e5)]);

  const pool = cap === 'All' ? all : all.filter((q) => capClass(q.mcapCr) === cap);
  const gainers = topMovers(pool, 'gainers');
  const losers = topMovers(pool, 'losers');
  const volume = topMovers(pool, 'volume');

  const b = breadth(all);
  const total = b.adv + b.dec + b.unch || 1;
  const trend = engine.mcapTrend;
  const trendPct = trend.length > 1 ? (trend[trend.length - 1] / trend[0] - 1) * 100 : 0;

  // index sparklines: fixed intraday shape per index, last point pinned to the live value
  const shapes = useMemo(() => {
    const now = Date.now();
    return Object.fromEntries(engine.indices.map((ix) => [ix.id, generateHistory(ix.label, '5m', ix.prev, now, 'INDEX').slice(-78).map((c) => c.close)]));
  }, [engine]);

  return (
    <div className="mx-auto grid max-w-[1500px] gap-4 p-3 lg:p-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <section aria-label="Market summary" className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
          {engine.indices.map((ix) => {
            const series = [...shapes[ix.id].slice(0, -1), ix.value];
            return (
              <SummaryCard key={ix.id} title={ix.label} value={fmt(ix.value)} sub={`${fmtSigned(ix.change)} (${fmtPct(ix.pct)})`} subClass={tone(ix.pct)}>
                <Sparkline data={series} up={ix.pct >= 0} height={34} />
              </SummaryCard>
            );
          })}
          <SummaryCard title="Market breadth" value={b.ratio.toFixed(2)} sub={`${b.adv} adv · ${b.dec} dec`} subClass={tone(b.ratio - 1)}>
            <div className="flex h-2 overflow-hidden rounded-full">
              <div className="bg-up" style={{ width: `${(b.adv / total) * 100}%` }} />
              <div className="bg-muted/40" style={{ width: `${(b.unch / total) * 100}%` }} />
              <div className="bg-down" style={{ width: `${(b.dec / total) * 100}%` }} />
            </div>
          </SummaryCard>
          <SummaryCard title="Tracked market cap" value={fmtCr(engine.totalMcapCr())} sub={fmtPct(trendPct)} subClass={tone(trendPct)}>
            <Sparkline data={trend} height={34} />
          </SummaryCard>
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">Stocks by market cap</h2>
          <div className="flex gap-1" role="group" aria-label="Market-cap filter">
            {(['All', 'Large', 'Mid', 'Small'] as CapFilter[]).map((c) => (
              <button
                key={c}
                onClick={() => setCap(c)}
                aria-pressed={cap === c}
                className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${cap === c ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted hover:text-ink'}`}
              >
                {c === 'All' ? 'All' : `${c} cap`} <span className="num ml-0.5 text-[10px] opacity-70">{counts[c]}</span>
              </button>
            ))}
          </div>
          <Badge className="ml-auto" tone="muted">Simulated prices</Badge>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <MoverTable title="Top gainers" rows={gainers} kind="gainers" onOpen={onOpenStock} />
          <MoverTable title="Top losers" rows={losers} kind="losers" onOpen={onOpenStock} />
          <MoverTable title="Volume leaders" rows={volume} kind="volume" onOpen={onOpenStock} />
        </div>

        <BudgetDiscovery engine={engine} instruments={instruments} onOpenChart={onOpenChart} />
      </div>

      <NewsFeed news={news} error={newsError} className="max-h-[calc(100vh-190px)] min-h-[420px] xl:sticky xl:top-[150px]" />
    </div>
  );
}
