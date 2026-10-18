'use client';

import { useMemo } from 'react';
import { Card, Stat } from '../ui';
import { CARD_GRID, Gauge, WIDE } from './charts';
import { alpha } from '@/lib/theme';
import { fmt, fmtCr, fmtInt, fmtPct, tone } from '@/lib/format';
import { C } from '@/lib/theme';
import { breadth, correlationMatrix, liquidityRatio, portfolioValueSeries, sectorIndexSeries, sectorStats, sharpeParts } from '@/lib/analytics';
import { generateHistory } from '@/lib/market';
import type { DashboardProps } from './types';

/** Diverging red ↔ green tile colour, saturating at ±3 %. */
function heat(pct: number): string {
  const a = Math.min(1, Math.abs(pct) / 3);
  return alpha(pct >= 0 ? 'up' : 'down', 0.16 + a * 0.5);
}

/** Pearson r → diverging tint (green positive, red negative). */
const corrTint = (r: number) => alpha(r >= 0 ? 'up' : 'down', 0.08 + Math.abs(r) * 0.62);

const MATRIX_SIZE = 7;

export function InstitutionalDashboard({ engine, quote, closes1D, holdings, favorites, onOpenRebalance }: DashboardProps) {
  const all = Array.from(engine.quotes.values());
  const sectors = sectorStats(all);
  const b = breadth(all);
  const total = b.adv + b.dec + b.unch || 1;
  const shp = sharpeParts(closes1D);
  const sr = shp?.sharpe ?? null;

  const turnoverCr = quote.sumPV / 1e7;
  const t2m = liquidityRatio(turnoverCr, quote.mcapCr);
  const univTurnover = all.reduce((a, q) => a + q.sumPV, 0) / 1e7;
  const univT2M = liquidityRatio(univTurnover, all.reduce((a, q) => a + q.mcapCr, 0));
  const sectorLiq = sectors
    .slice(0, 6)
    .map((sec) => {
      const qs = all.filter((q) => q.sector === sec.sector);
      return { sector: sec.sector, ratio: liquidityRatio(qs.reduce((a, q) => a + q.sumPV, 0) / 1e7, sec.mcapCr) };
    })
    .sort((a, b) => b.ratio - a.ratio);
  const maxLiq = Math.max(1e-9, ...sectorLiq.map((x) => x.ratio));
  const maxMcap = Math.max(1, ...sectors.map((s) => s.mcapCr));

  // correlation basket: selected stock first, then holdings and favourites, topped up with the largest caps
  const basket = useMemo(() => {
    const set: string[] = [];
    const add = (s: string) => set.length < MATRIX_SIZE && !set.includes(s) && engine.quotes.has(s) && set.push(s);
    add(quote.symbol);
    holdings.forEach((h) => add(h.symbol));
    favorites.forEach(add);
    [...engine.quotes.values()].sort((a, c) => c.mcapCr - a.mcapCr).forEach((q) => add(q.symbol));
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote.symbol, holdings, favorites, engine]);

  const corr = useMemo(() => {
    const now = Date.now();
    const series = Object.fromEntries(basket.map((s) => [s, generateHistory(s, '1D', engine.quotes.get(s)?.ltp ?? 100, now).map((c) => c.close)]));
    return correlationMatrix(series);
  }, [basket, engine]);

  // 4×4 sector correlation: equal-weighted index of each sector's three largest names (1Y daily returns)
  const topSectors = sectors.slice(0, 4).map((x) => x.sector);
  const secKey = topSectors.join(',');
  const secCorr = useMemo(() => {
    const now = Date.now();
    const series: Record<string, number[]> = {};
    for (const sec of topSectors) {
      const members = all.filter((q) => q.sector === sec).sort((a, b) => b.mcapCr - a.mcapCr).slice(0, 3);
      series[sec] = sectorIndexSeries(members.map((q) => generateHistory(q.symbol, '1D', q.ltp, now).map((c) => c.close)));
    }
    return correlationMatrix(series);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secKey, engine]);

  // portfolio Sharpe = (Rp − Rf) ÷ σ on the holdings' back-cast daily value series
  const holdKey = holdings.map((h) => h.symbol + h.qty).join(',');
  const pSharpe = useMemo(() => {
    if (holdings.length === 0) return null;
    const now = Date.now();
    const closes = holdings.map((h) => generateHistory(h.symbol, '1D', engine.touch(h.symbol)?.ltp ?? h.avg, now).map((c) => c.close));
    return sharpeParts(portfolioValueSeries(closes, holdings.map((h) => h.qty)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdKey, engine]);

  const gaugeVal = Math.min(3, b.ratio);

  return (
    <div className={CARD_GRID}>
      <div className={`flex flex-wrap items-center gap-2 ${WIDE}`}>
        <button onClick={onOpenRebalance} data-testid="rebalance-open" className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-accent/60 bg-accent/10 px-2.5 text-[12px] font-semibold text-accent hover:bg-accent/20"><span aria-hidden>⚖️</span> Rebalance Portfolio</button>
        <span className="text-[11px] text-muted">Model sector targets against today&apos;s portfolio</span>
      </div>
      <div className={`grid grid-cols-2 gap-2 ${WIDE}`}>
        <Stat label="Advance / Decline" value={b.ratio.toFixed(2)} valueClass={b.ratio >= 1 ? 'text-up' : 'text-down'} sub={`${b.adv} adv · ${b.dec} dec · ${b.unch} unch`} hint="Advancers ÷ Decliners across the tracked universe" />
        <Stat label={`Sharpe · ${quote.symbol}`} value={sr === null ? '—' : sr.toFixed(2)} valueClass={sr === null ? '' : sr >= 1 ? 'text-up' : sr < 0 ? 'text-down' : 'text-ink'} sub={shp ? `Rp ${shp.annReturnPct.toFixed(1)}% · σ ${shp.annVolPct.toFixed(1)}%` : '1Y daily, rf 6.5%'} hint="Sharpe = (Rp − Rf) ÷ σ, annualised on daily closes, Rf = 6.5%" />
        <Stat label="Sharpe · portfolio" value={pSharpe ? pSharpe.sharpe.toFixed(2) : '—'} valueClass={!pSharpe ? '' : pSharpe.sharpe >= 1 ? 'text-up' : pSharpe.sharpe < 0 ? 'text-down' : 'text-ink'} sub={pSharpe ? `Rp ${pSharpe.annReturnPct.toFixed(1)}% · σ ${pSharpe.annVolPct.toFixed(1)}%` : 'import holdings'} hint="(Rp − Rf) ÷ σ on today's holdings back-cast over simulated history" />
        <Stat label="Liquidity ratio" value={`${t2m.toFixed(3)}%`} sub={`${quote.symbol} · ₹${fmt(turnoverCr, 1)} Cr / ${fmtCr(quote.mcapCr)}`} hint="Turnover ÷ Market cap (session traded value ÷ capitalisation)" />
      </div>

      <Card title="Advance / decline gauge" right={<span className="num text-[10px] text-muted">{b.adv} ▲ · {b.dec} ▼</span>}>
        <Gauge value={gaugeVal} min={0} max={3} zones={[{ to: 0.8, color: 'rgb(var(--c-down) / 0.7)' }, { to: 1.25, color: 'rgb(var(--c-muted) / 0.55)' }, { to: 3, color: 'rgb(var(--c-up) / 0.7)' }]} label={b.ratio.toFixed(2)} sub={b.ratio >= 1.25 ? 'Broad advance' : b.ratio <= 0.8 ? 'Broad decline' : 'Balanced'} />
        <p className="mt-1 text-center text-[10px] text-muted">A/D = Advancers ÷ Decliners (1.0 = balanced; scale capped at 3).</p>
      </Card>

      <Card title="Liquidity ratio · turnover ÷ market cap" right={<span className="num text-[10px] text-muted">universe {univT2M.toFixed(3)}%</span>}>
        <ul className="num space-y-1.5 text-[11px]">
          {sectorLiq.map((x) => (
            <li key={x.sector} className="flex items-center gap-2">
              <span className="w-20 shrink-0 truncate text-muted">{x.sector}</span>
              <div className="h-1.5 flex-1 rounded bg-line"><div className="h-full rounded" style={{ width: `${(x.ratio / maxLiq) * 100}%`, background: C.accent }} /></div>
              <span className="w-14 text-right text-ink">{x.ratio.toFixed(3)}%</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10px] text-muted">Selected stock {quote.symbol}: {t2m.toFixed(3)}% · {fmtInt(all.length)} stocks tracked. Higher = more of the cap changed hands today.</p>
      </Card>

      <Card title="Sector correlation · 4 × 4 Pearson r" right={<span className="text-[10px] text-muted">1Y daily returns</span>} className={WIDE}>
        <div className="mx-auto max-w-[520px] overflow-x-auto">
          <table className="num w-full border-separate border-spacing-1 text-center text-[11px]">
            <thead>
              <tr>
                <th />
                {secCorr.symbols.map((x) => (
                  <th key={x} className="px-1 pb-1 font-semibold text-muted">{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {secCorr.symbols.map((rs, i) => (
                <tr key={rs}>
                  <th scope="row" className="pr-2 text-right font-semibold text-muted">{rs}</th>
                  {secCorr.matrix[i].map((r, j) => (
                    <td key={j} title={`${rs} × ${secCorr.symbols[j]}: r = ${r.toFixed(3)}`} data-testid="sector-corr-cell" className="rounded py-2.5 text-[12px] font-semibold text-ink" style={{ background: i === j ? alpha('muted', 0.18) : corrTint(r) }}>
                      {i === j ? '1.00' : r.toFixed(2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-muted">Each sector = equal-weighted index of its three largest names. r = cov(x, y) ÷ (σx σy); lower cross-sector r means better diversification.</p>
      </Card>

      <Card title="Sector performance heatmap" className={WIDE} right={<span className="text-[10px] text-muted">mcap-weighted · size ∝ market cap</span>}>
        <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-1.5 sm:grid-cols-[repeat(3,minmax(0,1fr))] [.fs_&]:lg:grid-cols-[repeat(6,minmax(0,1fr))]">
          {sectors.map((s) => {
            const big = s.mcapCr / maxMcap > 0.5;
            return (
              <div key={s.sector} className={`min-w-0 rounded p-2.5 ${big ? 'sm:col-span-2' : ''}`} style={{ background: heat(s.pct), minHeight: 74 }} title={`${s.sector}: ${fmtPct(s.pct)} · ${fmtCr(s.mcapCr)}`}>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[12px] font-semibold text-ink">{s.sector}</span>
                  <span className={`num text-[12px] font-bold ${tone(s.pct)}`}>{fmtPct(s.pct)}</span>
                </div>
                <div className="num mt-1 text-[10px] text-muted">{fmtCr(s.mcapCr)} · {s.count} stocks</div>
                <div className="num mt-1 flex flex-wrap gap-x-2 text-[10px] text-ink/85">
                  {s.top.map((t) => (
                    <span key={t.symbol}>
                      {t.symbol} <span className={tone(t.pct)}>{fmtPct(t.pct, 1)}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Stock correlation · Pearson r" className={WIDE} right={<span className="text-[10px] text-muted">1Y daily returns</span>}>
        <div className="overflow-x-auto">
          <table className="num w-full border-separate border-spacing-0.5 text-center text-[11px]">
            <thead>
              <tr>
                <th />
                {corr.symbols.map((s) => (
                  <th key={s} className={`px-1 pb-1 font-semibold ${s === quote.symbol ? 'text-accent' : 'text-muted'}`}>{s.length > 7 ? s.slice(0, 7) + '…' : s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {corr.symbols.map((rs, i) => (
                <tr key={rs}>
                  <th scope="row" className={`pr-2 text-right font-semibold ${rs === quote.symbol ? 'text-accent' : 'text-muted'}`}>{rs.length > 9 ? rs.slice(0, 9) + '…' : rs}</th>
                  {corr.matrix[i].map((r, j) => (
                    <td key={j} title={`${rs} × ${corr.symbols[j]}: r = ${r.toFixed(3)}`} className="rounded py-1.5 text-ink" style={{ background: i === j ? alpha('muted', 0.18) : corrTint(r) }}>
                      {i === j ? '1' : r.toFixed(2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-muted">r = cov(x, y) ÷ (σx σy). Basket: selected stock, holdings, favourites, then largest caps. Low correlation between holdings means better diversification.</p>
      </Card>

      <Card title="Market breadth" className={WIDE}>
        <div className="flex h-3 overflow-hidden rounded-full">
          <div className="bg-up" style={{ width: `${(b.adv / total) * 100}%` }} />
          <div className="bg-muted/50" style={{ width: `${(b.unch / total) * 100}%` }} />
          <div className="bg-down" style={{ width: `${(b.dec / total) * 100}%` }} />
        </div>
        <div className="num mt-2 flex justify-between text-[12px]">
          <span className="text-up">▲ {b.adv} ({fmtPct((b.adv / total) * 100, 0).replace('+', '')})</span>
          <span className={tone(b.ratio - 1)}>A/D {b.ratio.toFixed(2)}</span>
          <span className="text-down">▼ {b.dec} ({fmtPct((b.dec / total) * 100, 0).replace('+', '')})</span>
        </div>
      </Card>
    </div>
  );
}
