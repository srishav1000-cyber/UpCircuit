'use client';

import { useMemo, useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import { basePrice } from '@/lib/market';
import type { Instrument } from '@/lib/types';
import { dayPct } from '@/lib/analytics';
import { BUDGET_BANDS, budgetCandidates, inBand, type BudgetBand } from '@/lib/discovery';
import { fmt, fmtPct, tone } from '@/lib/format';
import { Card } from './ui';

const SHOWN = 20; // 4 rows × 5 columns

interface Props {
  engine: MarketEngine;
  instruments: Instrument[];
  /** open the stock's chart */
  onOpenChart: (symbol: string) => void;
}

/** "Budget Stock Discovery" — instruments.json filtered by LTP band; clicking a card opens its chart. */
export function BudgetDiscovery({ engine, instruments, onOpenChart }: Props) {
  const [band, setBand] = useState<BudgetBand>('under50');
  const b = BUDGET_BANDS.find((x) => x.id === band)!;

  // pre-filter the full master without instantiating quotes, then touch only the few shown
  const candidates = useMemo(() => budgetCandidates(instruments, b, basePrice, SHOWN), [instruments, b]);
  const totals = useMemo(() => Object.fromEntries(BUDGET_BANDS.map((x) => [x.id, instruments.reduce((n, i) => n + (inBand(basePrice(i.symbol), x) ? 1 : 0), 0)])), [instruments]);
  const rows = candidates.flatMap((i) => {
    const q = engine.touch(i.symbol);
    return q ? [q] : [];
  });

  return (
    <Card
      title="Budget Stock Discovery"
      right={<span className="num text-[10px] text-muted">{totals[band]} stocks · showing {rows.length}</span>}
    >
      <div className="p-3" data-testid="budget-discovery">
        <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Price band">
          {BUDGET_BANDS.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={band === x.id}
              onClick={() => setBand(x.id)}
              className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${band === x.id ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted hover:text-ink'}`}
            >
              {x.label}
            </button>
          ))}
        </div>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-muted">No stocks in this price band.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" role="tabpanel">
            {rows.map((q) => {
              const pct = dayPct(q);
              return (
                <button
                  key={q.symbol}
                  type="button"
                  data-testid="budget-card"
                  onClick={() => onOpenChart(q.symbol)}
                  title={`Open ${q.symbol} chart`}
                  className="min-w-0 cursor-pointer rounded-lg border border-line bg-bg/50 p-3 text-left hover:bg-line/50"
                >
                  <div className="truncate text-[13px] font-bold text-ink">{q.symbol}</div>
                  <div className="truncate text-[11px] text-muted">{q.name}</div>
                  <div className="num mt-1.5 flex items-baseline justify-between gap-1">
                    <span className="text-[13px] font-semibold text-ink">₹{fmt(q.ltp)}</span>
                    <span className={`text-[11px] ${tone(pct)}`}>{fmtPct(pct)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
