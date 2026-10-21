'use client';

import { useState } from 'react';
import { Card, Stat } from '../ui';
import { fmt, fmtInt } from '@/lib/format';
import { estimateSlippage } from '@/lib/analytics/slippage';
import type { MarketEngine } from '@/lib/market';

/** Order-book depth slippage estimator for the inspected stock (live SmartAPI depth only; N/A otherwise). */
export function SlippageCard({ engine, symbol, className = '' }: { engine: MarketEngine; symbol: string; className?: string }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState('1000');
  const depth = engine.depthReal ? engine.depth : null;
  const r = depth ? estimateSlippage(depth.bids, depth.asks, side, Number(qty)) : null;
  return (
    <Card title={`Depth slippage estimator · ${symbol}`} badges={[depth ? 'smartapi' : 'na', 'computed']} className={className}>
      <div data-testid="slip-card" data-slip={r ? r.slipBps.toFixed(2) : 'na'}>
        {!depth ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="slip-na">N/A — order-book depth is streamed by SmartAPI only while the market is live.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid grid-cols-2 gap-1 rounded-full border border-line p-0.5 text-[11px] font-semibold" role="group" aria-label="Order side">
                {(['buy', 'sell'] as const).map((s) => <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} className={`rounded-full px-3 py-1 ${side === s ? (s === 'buy' ? 'bg-up/20 text-up' : 'bg-down/20 text-down') : 'text-muted'}`}>{s === 'buy' ? 'Buy' : 'Sell'}</button>)}
              </div>
              <label className="text-[10px] uppercase tracking-wider text-muted">Shares<input aria-label="Order quantity" data-testid="slip-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className="num ml-2 w-24 rounded border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent" /></label>
            </div>
            {!r ? (
              <p className="mt-3 text-[12px] text-muted">Enter a positive quantity.</p>
            ) : (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Avg fill" value={`₹${fmt(r.avgPrice, 3)}`} sub={`best ₹${fmt(r.best)} · ${r.levelsUsed} level${r.levelsUsed === 1 ? '' : 's'}`} />
                  <Stat label="Slippage" value={`${r.slipBps.toFixed(1)} bps`} valueClass={r.slipBps > 10 ? 'text-down' : r.slipBps > 3 ? 'text-warn' : 'text-up'} sub={`₹${fmt(r.slipPerShare, 3)} / share`} />
                  <Stat label="Total cost" value={`₹${fmtInt(Math.round(r.slipTotal))}`} sub={`on ${fmtInt(r.filled)} shares`} />
                  <Stat label="Half-spread" value={r.halfSpreadBps === null ? 'N/A' : `${r.halfSpreadBps.toFixed(1)} bps`} sub="cost of a 1-share order" />
                </div>
                {r.unfilled > 0 && <p className="mt-2 text-[11px] text-warn" data-testid="slip-partial" role="status">⚠ {fmtInt(r.unfilled)} of {fmtInt(r.qty)} shares exceed the visible 5-level depth — the real cost would be higher than shown.</p>}
              </>
            )}
            <p className="mt-2 text-[10px] text-muted">Average fill = Σ price × shares taken ÷ shares, walking the top 5 levels; slippage = average fill − best price. Ignores hidden liquidity and book changes while filling.</p>
          </>
        )}
      </div>
    </Card>
  );
}
