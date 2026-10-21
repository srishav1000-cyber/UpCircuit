'use client';

import { useMemo } from 'react';
import { Card, Stat } from '../ui';
import { C } from '@/lib/theme';
import { portfolioValueSeries } from '@/lib/analytics';
import { drawdownSeries, summariseDrawdown } from '@/lib/analytics/drawdown';
import type { MarketEngine } from '@/lib/market';
import type { Holding } from '@/lib/types';

/** Drawdown & recovery tracker: today's holdings replayed over the past year — peak-to-trough decline and how long recoveries took. */
export function DrawdownCard({ engine, holdings, className = '' }: { engine: MarketEngine; holdings: Holding[]; className?: string }) {
  const key = holdings.map((h) => h.symbol + h.qty).join(',');
  const res = useMemo(() => {
    if (holdings.length === 0) return null;
    const value = portfolioValueSeries(holdings.map((h) => engine.closes(h.symbol)), holdings.map((h) => h.qty));
    const sum = summariseDrawdown(value);
    return sum ? { dd: drawdownSeries(value), sum } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, engine, engine.histVer]);
  const W = 320;
  const H = 90;
  const lo = res ? Math.min(-1, res.sum.maxPct * 1.05) : -1;
  const x = (i: number, n: number) => (i / Math.max(1, n - 1)) * W;
  const y = (v: number) => (v / lo) * (H - 6) + 2;
  const eps = res ? [...res.sum.episodes].sort((a, b) => a.depthPct - b.depthPct).slice(0, 3) : [];
  return (
    <Card title="Drawdown & recovery · 1Y" badges={['yahoo', 'computed']} className={className} right={res ? <span className="num text-[10px] text-muted">{res.dd.length} trading days</span> : undefined}>
      <div data-testid="drawdown-card" data-maxdd={res ? res.sum.maxPct.toFixed(2) : 'na'}>
        {!res ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="drawdown-na">N/A — import holdings with at least 30 days of price history.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Max drawdown" value={`${res.sum.maxPct.toFixed(1)}%`} valueClass="text-down" hint="Largest peak-to-trough fall of the back-cast portfolio value" />
              <Stat label="Current drawdown" value={`${res.sum.currentPct.toFixed(1)}%`} valueClass={res.sum.currentPct < -5 ? 'text-down' : res.sum.currentPct < 0 ? 'text-warn' : 'text-up'} sub={res.sum.underwaterDays > 0 ? `${res.sum.underwaterDays} days below peak` : 'at a new peak'} />
              <Stat label="Longest recovery" value={res.sum.longestRecoveryDays === null ? 'N/A' : `${res.sum.longestRecoveryDays} days`} sub="trough → prior peak" />
              <Stat label="Episodes ≥ 2%" value={String(res.sum.episodes.length)} sub={`${res.sum.episodes.filter((e) => e.recoveryIdx === null).length} ongoing`} />
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label="Portfolio drawdown from peak" style={{ aspectRatio: `${W} / ${H}`, height: 'auto' }}>
              <line x1="0" x2={W} y1={y(0)} y2={y(0)} strokeWidth="1" style={{ stroke: C.muted, opacity: 0.5 }} />
              <polygon points={`0,${y(0)} ${res.dd.map((v, i) => `${x(i, res.dd.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} ${W},${y(0)}`} style={{ fill: C.down, opacity: 0.25 }} />
              <polyline fill="none" strokeWidth="1.5" points={res.dd.map((v, i) => `${x(i, res.dd.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} style={{ stroke: C.down }} />
            </svg>
            {eps.length > 0 && (
              <ul className="num mt-2 space-y-0.5 text-[11px] text-muted" data-testid="drawdown-episodes">
                {eps.map((e) => (
                  <li key={e.peakIdx}><b className="text-down">{e.depthPct.toFixed(1)}%</b> · {e.daysToTrough} days to the low · {e.daysToRecover === null ? <b className="text-warn">not yet recovered</b> : <>recovered in <b className="text-ink">{e.daysToRecover}</b> days</>}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] text-muted">Drawdown = value ÷ running peak − 1, on today&apos;s holdings replayed over the past year (no trades or rebalancing). Past recoveries do not promise future ones.</p>
          </>
        )}
      </div>
    </Card>
  );
}
