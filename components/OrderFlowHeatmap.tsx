'use client';

import { Card } from './ui';
import { ofi, ofiLabel } from '@/lib/analytics/orderflow';
import type { MarketEngine } from '@/lib/market';

const cell = (v: number) => (v >= 0 ? `rgba(16,185,129,${0.12 + 0.7 * Math.min(1, v)})` : `rgba(239,68,68,${0.12 + 0.7 * Math.min(1, -v)})`);

/** Order Flow Imbalance for the inspected stock: one −1…+1 pressure meter plus a per-level heat strip, from real exchange depth (N/A without it). */
export function OrderFlowHeatmap({ engine, symbol, className = '' }: { engine: MarketEngine; symbol: string; className?: string }) {
  const o = engine.depthReal ? ofi(engine.depth.bids, engine.depth.asks) : null;
  const lab = o ? ofiLabel(o.value) : null;
  const pos = o ? ((o.value + 1) / 2) * 100 : 50;
  return (
    <Card title={`Order flow imbalance · ${symbol}`} badges={[o ? 'smartapi' : 'na']} className={className} right={lab ? <span className={`num text-[11px] font-semibold ${lab.tone === 'up' ? 'text-up' : lab.tone === 'down' ? 'text-down' : 'text-muted'}`} data-testid="ofi-label">{lab.label}</span> : <span className="text-[10px] text-muted">N/A</span>}>
      <div data-testid="ofi-heatmap" data-ofi={o ? o.value.toFixed(3) : 'na'}>
        {!o ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="ofi-na">N/A — order-book depth is streamed by SmartAPI only while the market is live.</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="num text-2xl font-semibold text-ink" data-testid="ofi-value">{o.value >= 0 ? '+' : '−'}{Math.abs(o.value).toFixed(2)}</span>
              <span className="text-[10px] text-muted">OFI = (ΣBid − ΣAsk) ÷ (ΣBid + ΣAsk)</span>
            </div>
            <div className="relative mt-2 h-2.5 rounded-full bg-gradient-to-r from-down/70 via-line to-up/70" role="meter" aria-valuemin={-1} aria-valuemax={1} aria-valuenow={Number(o.value.toFixed(2))}>
              <span className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-ink ring-2 ring-panel" style={{ left: `${pos}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wider text-muted"><span>−1 extreme sell</span><span>0</span><span>+1 extreme buy</span></div>
            <div className="mt-3 grid grid-cols-5 gap-1" aria-label="Per-level imbalance">
              {o.levels.map((v, i) => (
                <div key={i} className="rounded px-1 py-1.5 text-center" style={{ background: cell(v) }} title={`Level ${i + 1}: ${v.toFixed(2)}`}>
                  <div className="text-[9px] text-slate-300">L{i + 1}</div>
                  <div className="num text-[11px] font-semibold text-white">{v >= 0 ? '+' : '−'}{Math.abs(v).toFixed(2)}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-muted">Bid qty {o.bidQty.toLocaleString('en-IN')} · Ask qty {o.askQty.toLocaleString('en-IN')} (5 levels)</p>
          </>
        )}
      </div>
    </Card>
  );
}
