'use client';

import { Card } from './ui';
import { DataBadge } from './DataBadge';
import { fmt } from '@/lib/format';
import { portfolioRisk, type RiskZone } from '@/lib/analytics/portfolioRisk';
import { hhiBand } from '@/lib/analytics/hhi';
import type { MarketEngine } from '@/lib/market';
import type { Holding } from '@/lib/types';

const BADGE: Record<RiskZone, string> = { green: 'border-up/40 bg-up/15 text-up', yellow: 'border-warn/40 bg-warn/15 text-warn', red: 'border-down/40 bg-down/15 text-down' };
const BAR: Record<RiskZone, string> = { green: 'bg-up', yellow: 'bg-warn', red: 'bg-down' };

function Bars({ rows, zone, testid }: { rows: { key: string; pct: number }[]; zone: RiskZone; testid: string }) {
  return (
    <ul className="mt-2 space-y-1" data-testid={testid}>
      {rows.slice(0, 5).map((r) => (
        <li key={r.key} className="flex items-center gap-2 text-[11px]">
          <span className="w-20 truncate text-muted">{r.key}</span>
          <span className="h-1.5 flex-1 rounded-full bg-line"><span className={`block h-full rounded-full ${BAR[zone]}`} style={{ width: `${Math.min(100, r.pct)}%` }} /></span>
          <span className="num w-12 text-right text-ink">{r.pct.toFixed(1)}%</span>
        </li>
      ))}
    </ul>
  );
}

/** Institutional risk diagnostics on the user's holdings: stock + sector HHI, β vs NIFTY 50, Sharpe, and a colour-coded concentration badge. Recomputed on every render, so it follows holdings and live prices. */
export function PortfolioRiskEngine({ engine, holdings, className = '' }: { engine: MarketEngine; holdings: Holding[]; className?: string }) {
  const positions = holdings.map((h) => {
    const q = engine.quotes.get(h.symbol);
    return { symbol: h.symbol, sector: q?.sector ?? 'Others', value: h.qty * (q?.ltp ?? h.avg) };
  });
  const closes = holdings.map((h) => engine.closes(h.symbol)); // 1Y daily Yahoo closes (fetched on demand by the engine)
  const r = portfolioRisk(positions, holdings.map((h) => h.qty), closes, engine.closes('NIFTY'));

  if (!r.stocks.length) {
    return (
      <Card title="Portfolio risk engine · HHI, β & Sharpe" className={className}>
        <p className="text-[11px] text-muted" data-testid="risk-engine-empty">Import or add holdings to measure stock and sector concentration, beta vs NIFTY 50 and Sharpe.</p>
      </Card>
    );
  }
  const sb = hhiBand(r.stockHhi);
  const cb = hhiBand(r.sectorHhi);
  const tile = 'rounded border border-line bg-bg px-2.5 py-2';
  return (
    <Card
      title="Portfolio risk engine · HHI, β & Sharpe"
      className={className}
      right={<span data-testid="risk-badge" data-zone={r.badge.zone} className={`num rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${BADGE[r.badge.zone]}`}>{r.badge.label}</span>}
    >
      <div data-testid="risk-engine" className="space-y-3">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="num text-2xl font-semibold text-ink" data-testid="hhi-stock">{Math.round(r.stockHhi).toLocaleString('en-IN')}</span>
              <span className="text-[11px] text-muted">stock HHI · {sb.label.toLowerCase()}</span>
            </div>
            <Bars rows={r.stocks.map((s) => ({ key: s.symbol, pct: s.weightPct }))} zone={sb.zone} testid="hhi-stock-bars" />
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="num text-2xl font-semibold text-ink" data-testid="hhi-sector">{Math.round(r.sectorHhi).toLocaleString('en-IN')}</span>
              <span className="text-[11px] text-muted">sector HHI · {cb.label.toLowerCase()}</span>
            </div>
            <Bars rows={r.sectors.map((s) => ({ key: s.sector, pct: s.weightPct }))} zone={cb.zone} testid="hhi-sector-bars" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className={tile}><div className="text-[9px] uppercase tracking-wider text-muted">Beta vs NIFTY 50</div><div className="num text-lg font-semibold text-ink" data-testid="risk-beta">{r.beta === null ? 'N/A' : r.beta.toFixed(2)}</div><div className="text-[10px] text-muted">{r.beta === null ? 'needs ≥ 30 daily returns' : r.beta > 1.1 ? 'more volatile than the market' : r.beta < 0.9 ? 'defensive vs the market' : 'moves with the market'}</div></div>
          <div className={tile}><div className="text-[9px] uppercase tracking-wider text-muted">Sharpe (est.)</div><div className="num text-lg font-semibold text-ink" data-testid="risk-sharpe">{r.sharpe ? r.sharpe.sharpe.toFixed(2) : 'N/A'}</div><div className="text-[10px] text-muted">{r.sharpe ? `Rp ${r.sharpe.annReturnPct.toFixed(1)}% · σ ${r.sharpe.annVolPct.toFixed(1)}%` : 'needs ≥ 30 days of history'}</div></div>
          <div className={tile}><div className="text-[9px] uppercase tracking-wider text-muted">Portfolio value</div><div className="num text-lg font-semibold text-ink">₹{fmt(r.total, 0)}</div><div className="text-[10px] text-muted">{r.stocks.length} holdings · {r.sectors.length} sectors</div></div>
          <div className={tile}><div className="text-[9px] uppercase tracking-wider text-muted">Largest position</div><div className="num text-lg font-semibold text-ink">{r.stocks[0].weightPct.toFixed(1)}%</div><div className="text-[10px] text-muted">{r.stocks[0].symbol}</div></div>
        </div>
        <p className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          <DataBadge kind="computed" /> <DataBadge kind="yahoo" label="Yahoo 1Y closes" />
          <span>HHI = Σ sᵢ² (weights in %; &lt; 1,500 low · 1,500–2,500 moderate · &gt; 2,500 high). β = Cov(Rp, Rm) ÷ Var(Rm) on {r.obs} paired daily returns; Sharpe uses Rf 6.5%. Estimates from history, not forecasts.</span>
        </p>
      </div>
    </Card>
  );
}
