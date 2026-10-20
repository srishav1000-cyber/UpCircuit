'use client';

import { useMemo } from 'react';
import { WIDE } from './charts';
import { Card } from '../ui';
import { fmt } from '@/lib/format';
import { hhiBand, hhiPct, runAllScenarios, sectorWeights, type HhiZone, type Position } from '@/lib/analytics/hhi';
import type { MarketEngine } from '@/lib/market';
import type { Holding } from '@/lib/types';

const ZONE_CLS: Record<HhiZone, string> = { green: 'text-up bg-up/15', yellow: 'text-warn bg-warn/15', red: 'text-down bg-down/15' };
const BAR_CLS: Record<HhiZone, string> = { green: 'bg-up', yellow: 'bg-warn', red: 'bg-down' };
const inr = (n: number) => `${n < 0 ? '−' : '+'}₹${fmt(Math.abs(n), 0)}`;

/** Sector HHI + ₹ macro-shock stress table on the user's holdings (Institutional + Executive lenses). */
export function RiskPanel({ engine, holdings }: { engine: MarketEngine; holdings: Holding[] }) {
  // cheap (≤ a few dozen holdings) — recomputed every render so it tracks live ticks
  const positions: Position[] = holdings.map((h) => {
    const q = engine.quotes.get(h.symbol);
    return { symbol: h.symbol, sector: q?.sector ?? 'Others', value: h.qty * (q?.ltp ?? h.avg) };
  });
  const weights = useMemo(() => sectorWeights(positions), [positions]);
  const h = hhiPct(weights.map((w) => w.weightPct));
  const band = hhiBand(h);
  const results = useMemo(() => runAllScenarios(positions), [positions]);
  const total = positions.reduce((a, p) => a + (p.value > 0 ? p.value : 0), 0);

  if (!weights.length) {
    return (
      <Card title="Portfolio risk · HHI & macro shocks" className={WIDE}>
        <p className="text-[11px] text-muted">Import or add holdings to see sector concentration and ₹ stress scenarios.</p>
      </Card>
    );
  }
  return (
    <Card
      title="Portfolio risk · HHI & macro shocks"
      className={WIDE}
      right={<span className={`num rounded px-1.5 py-0.5 text-[10px] font-semibold ${ZONE_CLS[band.zone]}`}>{band.label}</span>}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div data-testid="hhi-block">
          <div className="flex items-baseline gap-2">
            <span className={`num text-2xl font-semibold ${ZONE_CLS[band.zone].split(' ')[0]}`} data-testid="hhi-value">{Math.round(h).toLocaleString('en-IN')}</span>
            <span className="text-[11px] text-muted">sector HHI = Σ sᵢ² (weights in %)</span>
          </div>
          <ul className="mt-2 space-y-1">
            {weights.slice(0, 6).map((w) => (
              <li key={w.sector} className="flex items-center gap-2 text-[11px]">
                <span className="w-20 truncate text-muted">{w.sector}</span>
                <span className="h-1.5 flex-1 rounded-full bg-line"><span className={`block h-full rounded-full ${BAR_CLS[band.zone]}`} style={{ width: `${Math.min(100, w.weightPct)}%` }} /></span>
                <span className="num w-12 text-right text-ink">{w.weightPct.toFixed(1)}%</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-muted">&lt; 1,500 diversified · 1,500–2,500 moderate · &gt; 2,500 high</p>
        </div>
        <div data-testid="shock-block">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted"><th className="pb-1 font-medium">Scenario</th><th className="pb-1 text-right font-medium">ΔValue</th><th className="pb-1 text-right font-medium">Δ%</th></tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1 text-ink" title={r.worst ? `largest hit: ${r.worst.sector}` : undefined}>{r.label}</td>
                  <td className={`num py-1 text-right ${r.delta < 0 ? 'text-down' : 'text-up'}`}>{inr(r.delta)}</td>
                  <td className={`num py-1 text-right ${r.delta < 0 ? 'text-down' : 'text-up'}`}>{r.deltaPct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-muted">Portfolio ₹{fmt(total, 0)}. ΔValue = Σ Valueⱼ × Shockⱼ. Illustrative sector sensitivities and betas, not forecasts.</p>
        </div>
      </div>
    </Card>
  );
}
