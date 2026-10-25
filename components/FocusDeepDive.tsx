'use client';

import { MiniStockChart } from './MiniStockChart';
import { StockPostMortem } from './StockPostMortem';
import type { MarketEngine } from '@/lib/market';
import type { NewsResponse, Quote } from '@/lib/types';

/** Selected focus stock: header → mini candlestick chart with pattern badges → full Post-Mortem panel, all on the dashboard page. */
export function FocusDeepDive({ engine, quote, mode, news, onExpand }: { engine: MarketEngine; quote: Quote; mode: string; news?: NewsResponse | null; onExpand: () => void }) {
  return (
    <section data-testid="focus-deepdive" data-symbol={quote.symbol} aria-label={`${quote.symbol} deep dive`} className="mb-3 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[15px] font-bold text-ink">{quote.symbol}</h3>
        <span className="truncate text-[12px] text-muted">{quote.name} · {quote.sector}</span>
        <span className="ml-auto rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-400">Stock post-mortem</span>
      </div>
      <MiniStockChart engine={engine} quote={quote} onExpand={onExpand} />
      <StockPostMortem engine={engine} quote={quote} mode={mode} news={news} />
    </section>
  );
}
