'use client';

import { useMemo } from 'react';
import { Card, Stat } from '../ui';
import { fmtInt } from '@/lib/format';
import { historicalVar, portfolioReturns, VAR_CONFIDENCE, VAR_MIN_OBS, varRupees } from '@/lib/analytics/varMath';
import type { MarketEngine } from '@/lib/market';
import type { Holding } from '@/lib/types';

/** 1-day 95 % historical VaR and Expected Shortfall for the user's holdings, with the method stated beside the number. */
export function VarCard({ engine, holdings, className = '' }: { engine: MarketEngine; holdings: Holding[]; className?: string }) {
  const key = holdings.map((h) => h.symbol + h.qty).join(',');
  const res = useMemo(() => {
    if (holdings.length === 0) return null;
    const closes = holdings.map((h) => engine.closes(h.symbol));
    const v = historicalVar(portfolioReturns(closes, holdings.map((h) => h.qty)), VAR_CONFIDENCE);
    if (!v) return null;
    const value = holdings.reduce((a, h) => a + h.qty * (engine.quotes.get(h.symbol)?.ltp ?? h.avg), 0);
    return { v, value, rs: varRupees(v, value) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, engine, engine.histVer]);
  return (
    <Card title="Value-at-Risk 95% · 1-day" badges={['yahoo', 'computed']} className={className} right={res ? <span className="num text-[10px] text-muted">{res.v.n} daily returns</span> : undefined}>
      <div data-testid="var-card" data-var={res ? res.v.varPct.toFixed(4) : 'na'}>
        {!res ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="var-na">N/A — import holdings with at least {VAR_MIN_OBS} days of price history to estimate VaR.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="VaR 95%" value={`₹${fmtInt(Math.round(res.rs.var))}`} valueClass="text-warn" sub={`${(res.v.varPct * 100).toFixed(2)}% of ₹${fmtInt(Math.round(res.value))}`} hint="On 95 % of days the portfolio should lose no more than this" />
              <Stat label="Expected shortfall" value={`₹${fmtInt(Math.round(res.rs.es))}`} valueClass="text-down" sub={`${(res.v.esPct * 100).toFixed(2)}% · avg of worst ${res.v.tail} days`} hint="Average loss on the worst 5 % of days, at or beyond VaR" />
            </div>
            <p className="mt-2 text-[10px] text-muted">Historical simulation: today&apos;s holdings replayed over the past year&apos;s daily returns; VaR = the 5th-percentile loss, ES = mean of the worst {res.v.tail} days. Assumes the past resembles tomorrow; no costs or rebalancing.</p>
          </>
        )}
      </div>
    </Card>
  );
}
