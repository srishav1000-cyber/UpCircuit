'use client';

import { useMemo, useState } from 'react';
import { Badge, Card, Stat } from '../ui';
import { RSIGauge } from '../RSIGauge';
import { BarChart, CARD_GRID, Donut, LineChart, WIDE } from './charts';
import { C, alpha } from '@/lib/theme';
import { fmt, fmtInt, fmtPct, fmtSigned, fmtSignedRupee, tone } from '@/lib/format';
import { cumulativeReturnPct, dividendForecast, portfolioDiagnostics, portfolioSummary, portfolioValueSeries, rsi14 } from '@/lib/analytics';
import { IST_OFFSET } from '@/lib/market';
import { ExportReport } from '../ExportReport';
import type { DashboardProps } from './types';

const WINDOWS = [
  { k: '3M', n: 63 },
  { k: '6M', n: 126 },
  { k: '1Y', n: 252 },
] as const;

/** RSI → tile tint: oversold (≤30) green, overbought (≥70) red, neutral grey with a gentle ramp. */
function rsiTint(r: number | null): string {
  if (r === null) return alpha('muted', 0.12);
  if (r >= 70) return alpha('down', 0.25 + Math.min(1, (r - 70) / 20) * 0.45);
  if (r <= 30) return alpha('up', 0.25 + Math.min(1, (30 - r) / 20) * 0.45);
  return alpha('muted', 0.1 + (Math.abs(r - 50) / 20) * 0.1);
}

export function RetailDashboard({ engine, quote, closes1D, holdings, favorites, mode, onSelect, onToggleFavorite, onOpenImport, onOpenRebalance, onAskAI }: DashboardProps) {
  const [win, setWin] = useState<(typeof WINDOWS)[number]>(WINDOWS[2]);
  const [alloc, setAlloc] = useState<'stock' | 'sector'>('stock');

  // per-holding REAL daily closes (Yahoo, ≈1 year); the last bar follows the live price
  const symKey = holdings.map((h) => h.symbol).join(',');
  const bases = useMemo(
    () => Object.fromEntries(holdings.map((h) => [h.symbol, engine.closes(h.symbol)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symKey, engine, engine.histVer],
  );
  const nifty = engine.indices[0];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const niftyBase = useMemo(() => engine.closes('NIFTY'), [engine, engine.histVer]);

  const rows = holdings
    .map((h) => {
      const q = engine.touch(h.symbol);
      if (!q) return null;
      const invested = h.qty * h.avg;
      const value = h.qty * q.ltp;
      const base = bases[h.symbol];
      const rsi = base && base.length > 15 ? rsi14([...base.slice(0, -1), q.ltp]) : null;
      const income = (value * q.dividendYield) / 100;
      return { h, q, invested, value, pnl: value - invested, day: h.qty * (q.ltp - q.prevClose), rsi, income, yoc: invested > 0 ? (income / invested) * 100 : 0 };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const s = portfolioSummary(holdings, (sym) => engine.quotes.get(sym));
  const income = rows.reduce((a, r) => a + r.income, 0);
  const portfolioYield = s.current > 0 ? (income / s.current) * 100 : 0;
  const yieldOnCost = s.invested > 0 ? (income / s.invested) * 100 : 0;

  const rsi = rsi14(closes1D);

  // cumulative return vs NIFTY 50 (holdings back-cast at today's quantities)
  const cmp = useMemo(() => {
    const live = rows.filter((r) => bases[r.h.symbol]?.length > 1);
    if (niftyBase.length < 2) return null;
    if (live.length === 0) return null;
    const closes = live.map((r) => [...bases[r.h.symbol].slice(0, -1), r.q.ltp]);
    const val = portfolioValueSeries(closes, live.map((r) => r.h.qty));
    const n = Math.min(win.n, val.length, niftyBase.length);
    const p = cumulativeReturnPct(val.slice(-n));
    const b = cumulativeReturnPct([...niftyBase.slice(0, -1), nifty.value].slice(-n));
    return { p, b, pEnd: p[p.length - 1], bEnd: b[b.length - 1] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.q.ltp).join(','), bases, niftyBase, nifty.value, win]);

  const diag = portfolioDiagnostics(rows.map((r) => ({ symbol: r.h.symbol, sector: r.q.sector, value: r.value, invested: r.invested })), Array.from(new Set(Array.from(engine.quotes.values()).map((q) => q.sector))));

  const monthIdx = new Date(Date.now() + IST_OFFSET * 1000).getUTCMonth();
  const divs = dividendForecast(rows.map((r) => ({ symbol: r.h.symbol, value: r.value, yieldPct: r.q.dividendYield })), monthIdx);
  const divMax = Math.max(...divs.map((d) => d.amount));

  const slices =
    alloc === 'stock'
      ? rows.map((r) => ({ label: r.h.symbol, value: r.value }))
      : (diag?.sectors ?? []).map((x) => ({ label: x.sector, value: x.pct }));

  return (
    <div className={CARD_GRID}>
      <div className={`flex flex-wrap items-center gap-2 ${WIDE}`} data-testid="retail-actions">
        <button onClick={onOpenRebalance} data-testid="rebalance-open" className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-accent/60 bg-accent/10 px-2.5 text-[12px] font-semibold text-accent hover:bg-accent/20"><span aria-hidden>⚖️</span> Rebalance Portfolio</button>
        <ExportReport symbol={quote.symbol} engine={engine} holdings={holdings} mode={mode} />
        <span className="text-[11px] text-muted">Report covers {quote.symbol}</span>
      </div>
      <div className={`grid grid-cols-2 gap-2 xl:grid-cols-3 ${WIDE}`}>
        <Stat label="Current value" value={`₹${fmt(s.current)}`} sub={`Invested ₹${fmt(s.invested)}`} />
        <Stat label="Total P&L" value={fmtSignedRupee(s.pnl)} valueClass={tone(s.pnl)} sub={fmtPct(s.pnlPct)} hint="Σ(LTP × Qty) − Invested" />
        <Stat label="Today's gain / loss" value={fmtSignedRupee(s.dayPnl)} valueClass={tone(s.dayPnl)} sub={fmtPct(s.dayPct)} />
        <Stat label="Dividend yield" value={portfolioYield.toFixed(2) + '%'} sub={`≈ ₹${fmt(income, 0)} / yr`} hint="Portfolio-weighted trailing yield (N/A where unavailable)" />
        <Stat label="vs NIFTY 50" value={cmp ? <span className={tone(cmp.pEnd - cmp.bEnd)}>{fmtPct(cmp.pEnd - cmp.bEnd, 1)}</span> : '—'} sub={cmp ? `${win.k}: you ${fmtPct(cmp.pEnd, 1)} · index ${fmtPct(cmp.bEnd, 1)}` : undefined} hint="Back-cast of today's holdings vs the index over the selected window" />
        <Stat label="Diversification" value={diag ? `${diag.diversification}/100` : '—'} valueClass={diag ? (diag.diversification >= 55 ? 'text-up' : diag.diversification >= 35 ? 'text-warn' : 'text-down') : ''} sub={diag ? `${diag.diversificationLabel} · concentration ${diag.concentration}` : undefined} />
      </div>

      <Card
        className={WIDE}
        title={`Holdings · ${rows.length}`}
        right={
          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] text-muted sm:inline">CSV · image · PDF</span>
            <button onClick={onOpenImport} className="rounded border border-line px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/10">Import</button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-muted">No holdings yet. Import a CSV, screenshot or PDF statement, or place a Delivery buy.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="num w-full text-[12px]">
              <thead className="text-[10px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="pb-1 text-left font-medium">Symbol</th>
                  <th className="text-right font-medium">Qty</th>
                  <th className="text-right font-medium">Avg</th>
                  <th className="text-right font-medium">LTP</th>
                  <th className="text-right font-medium">Day</th>
                  <th className="text-right font-medium">P&L</th>
                  <th className="text-right font-medium">RSI</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ h, q, pnl: p, day: d, rsi: r }) => (
                  <tr key={h.symbol} onClick={() => onSelect(h.symbol)} className="cursor-pointer border-t border-line hover:bg-line/60">
                    <td className="py-1.5 font-semibold text-ink">{h.symbol}</td>
                    <td className="text-right">{fmtInt(h.qty)}</td>
                    <td className="text-right text-muted">{fmt(h.avg)}</td>
                    <td className="text-right">{fmt(q.ltp)}</td>
                    <td className={`text-right ${tone(d)}`}>{fmtSigned(d, 0)}</td>
                    <td className={`text-right ${tone(p)}`}>{fmtSigned(p, 0)}</td>
                    <td className={`text-right ${r === null ? 'text-muted' : r >= 70 ? 'text-down' : r <= 30 ? 'text-up' : 'text-ink'}`}>{r === null ? '—' : r.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Portfolio allocation"
        right={
          <div className="flex overflow-hidden rounded border border-line text-[10px] font-semibold" role="group" aria-label="Allocation grouping">
            {(['stock', 'sector'] as const).map((k) => (
              <button key={k} onClick={() => setAlloc(k)} aria-pressed={alloc === k} className={`px-2 py-0.5 capitalize ${alloc === k ? 'bg-accent text-white' : 'text-muted hover:text-ink'}`}>{k}</button>
            ))}
          </div>
        }
      >
        {slices.length === 0 ? <p className="text-[12px] text-muted">Add holdings to see your allocation.</p> : <Donut slices={slices} centre={`${rows.length}`} sub={alloc === 'stock' ? 'holdings' : `${slices.length} sectors`} />}
      </Card>

      <Card
        title="Cumulative return vs NIFTY 50"
        right={
          <div className="flex overflow-hidden rounded border border-line text-[10px] font-semibold" role="group" aria-label="Return window">
            {WINDOWS.map((w) => (
              <button key={w.k} onClick={() => setWin(w)} aria-pressed={win.k === w.k} className={`px-2 py-0.5 ${win.k === w.k ? 'bg-accent text-white' : 'text-muted hover:text-ink'}`}>{w.k}</button>
            ))}
          </div>
        }
      >
        {cmp ? (
          <>
            <LineChart
              series={[
                { name: 'Portfolio', color: C.accent, data: cmp.p },
                { name: 'NIFTY 50', color: C.warn, data: cmp.b },
              ]}
              xLabels={[`${win.k} ago`, 'now']}
            />
            <div className="num mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: C.accent }} />Portfolio <b className={tone(cmp.pEnd)}>{fmtPct(cmp.pEnd, 1)}</b></span>
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: C.warn }} />NIFTY 50 <b className={tone(cmp.bEnd)}>{fmtPct(cmp.bEnd, 1)}</b></span>
              <span className="text-muted">Alpha <b className={tone(cmp.pEnd - cmp.bEnd)}>{fmtPct(cmp.pEnd - cmp.bEnd, 1)}</b></span>
            </div>
            <p className="mt-1 text-[10px] text-muted">Today’s holdings back-cast over real price history — not your actual trade-by-trade record.</p>
          </>
        ) : (
          <p className="text-[12px] text-muted">Add holdings to compare with the benchmark.</p>
        )}
      </Card>

      <Card title="Dividend forecast · next 12 months" right={<span className="num text-[11px] text-muted">yield on cost {yieldOnCost.toFixed(2)}%</span>}>
        {rows.length === 0 || income <= 0 ? (
          <p className="text-[12px] text-muted">Add dividend-paying holdings to see expected income.</p>
        ) : (
          <>
            <div className="mb-2 grid grid-cols-3 gap-2 text-center">
              <div><div className="text-[10px] uppercase tracking-wider text-muted">Per year</div><div className="num text-[14px] font-semibold text-ink">₹{fmt(income, 0)}</div></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted">Per quarter</div><div className="num text-[14px] font-semibold text-ink">₹{fmt(income / 4, 0)}</div></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted">Best month</div><div className="num text-[14px] font-semibold text-ink">₹{fmt(divMax, 0)}</div></div>
            </div>
            <BarChart
              bars={divs.map((d) => ({
                label: d.label,
                value: d.amount,
                color: d.amount === divMax ? C.up : alpha('up', 0.55),
                title: `${d.label}: ₹${fmt(d.amount, 0)}${d.parts.length ? ' — ' + d.parts.map((p) => `${p.symbol} ₹${fmt(p.amount, 0)}`).join(', ') : ''}`,
              }))}
              fmtValue={(n) => '₹' + fmt(n, 0)}
            />
            <ul className="num mt-2 divide-y divide-line text-[12px]">
              {[...rows].sort((a, b) => b.income - a.income).slice(0, 4).map((r) => (
                <li key={r.h.symbol} className="flex justify-between py-1"><span>{r.h.symbol}</span><span className="text-muted">{r.q.dividendYield.toFixed(2)}%</span><span className="text-ink">₹{fmt(r.income, 0)}</span></li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] text-muted">Estimated schedule: trailing yield split into payouts on deterministic months; real ex-dates differ.</p>
          </>
        )}
      </Card>

      <Card title="RSI heat · holdings" right={<span className="text-[10px] text-muted">≤30 oversold · ≥70 overbought</span>}>
        {rows.length === 0 ? (
          <p className="text-[12px] text-muted">No holdings.</p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {rows.map((r) => (
              <button key={r.h.symbol} onClick={() => onSelect(r.h.symbol)} className="rounded px-2 py-1.5 text-left" style={{ background: rsiTint(r.rsi) }} title={`${r.h.symbol} RSI(14) ${r.rsi?.toFixed(1) ?? '—'}`}>
                <div className="truncate text-[10px] font-semibold text-ink">{r.h.symbol}</div>
                <div className={`num text-[14px] font-bold ${r.rsi === null ? 'text-muted' : r.rsi >= 70 ? 'text-down' : r.rsi <= 30 ? 'text-up' : 'text-ink'}`}>{r.rsi === null ? '—' : r.rsi.toFixed(0)}</div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title={`RSI (14) · ${quote.symbol}`} badges={['yahoo', 'computed']}>
        <RSIGauge value={rsi} />
        <p className="mt-2 text-center text-[11px] text-muted">Wilder smoothing on daily closes · ≤ 30 oversold · ≥ 70 overbought.</p>
      </Card>

      <Card title="Portfolio diagnostics" right={<button onClick={() => onAskAI('Diagnose my portfolio: concentration, diversification, sector exposure and rebalancing.')} className="rounded border border-line px-2 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/10">✨ Ask AI</button>}>
        {!diag ? (
          <p className="text-[12px] text-muted">Import holdings to see concentration and diversification diagnostics.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div><div className="text-[10px] uppercase tracking-wider text-muted">Diversification</div><div className="num text-[16px] font-semibold text-ink">{diag.diversification}</div></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted">Concentration</div><Badge tone={diag.concentration === 'Low' ? 'up' : diag.concentration === 'Moderate' ? 'warn' : 'down'}>{diag.concentration}</Badge></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted">HHI</div><div className="num text-[16px] font-semibold text-ink">{Math.round(diag.hhi).toLocaleString('en-IN')}</div></div>
            </div>
            <div className="space-y-1">
              {diag.sectors.slice(0, 5).map((x) => (
                <div key={x.sector} className="num flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 truncate text-muted">{x.sector}</span>
                  <div className="h-1.5 flex-1 rounded bg-line"><div className="h-full rounded" style={{ width: `${Math.min(100, x.pct)}%`, background: x.pct > 35 ? C.down : C.accent }} /></div>
                  <span className="w-10 text-right text-ink">{x.pct.toFixed(0)}%</span>
                </div>
              ))}
            </div>
            <ul className="space-y-1.5 text-[12px]">
              {diag.advice.map((a, i) => (
                <li key={i} className="rounded border border-line bg-bg px-2.5 py-1.5"><b className="text-ink">{a.title}.</b> <span className="text-muted">{a.detail}</span></li>
              ))}
            </ul>
            <p className="text-[10px] text-muted">General guidelines (single stock ≲ 20%, sector ≲ 35%, HHI &lt; 1 500) — educational, not personalised advice.</p>
          </div>
        )}
      </Card>

      <Card title="Favourites">
        <ul className="divide-y divide-line">
          {favorites.length === 0 && <li className="py-2 text-[13px] text-muted">Star a stock from the chart header.</li>}
          {favorites.map((sym) => {
            const q = engine.quotes.get(sym) ?? engine.touch(sym);
            if (!q) return null;
            const pct = (q.ltp / q.prevClose - 1) * 100;
            return (
              <li key={sym} className="flex items-center gap-2 py-1.5">
                <button onClick={() => onToggleFavorite(sym)} className="text-warn" aria-label={`Remove ${sym}`}>★</button>
                <button onClick={() => onSelect(sym)} className="min-w-0 flex-1 text-left">
                  <div className="text-[13px] font-semibold text-ink">{sym}</div>
                  <div className="truncate text-[10px] text-muted">{q.name}</div>
                </button>
                <div className="num text-right">
                  <div className="text-[13px] text-ink">{fmt(q.ltp)}</div>
                  <div className={`text-[11px] ${tone(pct)}`}>{fmtPct(pct)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
