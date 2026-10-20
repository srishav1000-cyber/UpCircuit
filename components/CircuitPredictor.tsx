'use client';

import { Card } from './ui';
import { circuitWatchlist, NEAR_PCT } from '@/lib/analytics/proximity';
import { fmt } from '@/lib/format';
import type { MarketEngine } from '@/lib/market';

/** Circuit Watchlist: every stock within 1.5 % of a circuit band that has not halted yet (exchange limits when known, else inferred 5/10/20 %). */
export function CircuitPredictor({ engine, onSelect, className = '' }: { engine: MarketEngine; onSelect?: (symbol: string) => void; className?: string }) {
  const rows = circuitWatchlist(engine.quotes.values(), NEAR_PCT);
  return (
    <Card title="Circuit proximity · watchlist" className={className} right={<span className="text-[10px] text-muted">within {NEAR_PCT}% of a limit · {rows.length}</span>}>
      <div data-testid="circuit-predictor">
        {rows.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="circuit-predictor-empty">No stock is within {NEAR_PCT}% of a circuit limit right now.</p>
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted"><th className="pb-1 font-medium">Stock</th><th className="pb-1 font-medium">Side</th><th className="pb-1 text-right font-medium">LTP</th><th className="pb-1 text-right font-medium">Limit</th><th className="pb-1 text-right font-medium">Proximity</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} onClick={() => onSelect?.(r.symbol)} className="cursor-pointer border-t border-line hover:bg-line/40" data-testid="circuit-predictor-row" data-symbol={r.symbol} data-dir={r.dir}>
                  <td className="py-1 font-semibold text-ink">{r.symbol}</td>
                  <td className={`py-1 ${r.dir === 'upper' ? 'text-up' : 'text-down'}`}>{r.dir === 'upper' ? '▲ Upper' : '▼ Lower'} {r.band}%{r.inferred ? ' ·est.' : ''}</td>
                  <td className="num py-1 text-right text-ink">{fmt(r.ltp)}</td>
                  <td className="num py-1 text-right text-muted">{fmt(r.limit)}</td>
                  <td className={`num py-1 text-right font-semibold ${r.proximityPct <= 0.5 ? 'text-warn' : 'text-ink'}`}>{r.proximityPct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[10px] text-muted">Proximity = (Upper − LTP) ÷ Upper × 100 (lower: (LTP − Lower) ÷ Lower × 100). “est.” = exchange band not received, so the next 5/10/20 % band is assumed.</p>
      </div>
    </Card>
  );
}
