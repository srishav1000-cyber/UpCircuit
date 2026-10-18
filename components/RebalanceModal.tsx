'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import type { Holding } from '@/lib/types';
import { fmt, fmtSignedRupee, tone } from '@/lib/format';
import { planRebalance, sectorWeights, setTarget, type QuoteLite } from '@/lib/rebalance';

interface Props {
  holdings: Holding[];
  engine: MarketEngine;
  /** replace the portfolio (used by Simulate and Undo) */
  onApply: (next: Holding[]) => void;
  onClose: () => void;
}

const DEFAULT_SECTORS = ['Banking', 'IT', 'FMCG', 'Energy'];
const rupee = (n: number) => `₹${fmt(Math.abs(n), 0)}`;

/** ⚖️ Smart Portfolio Rebalance Simulator — drag sector targets, see the cash and the share-level trims / adds, then simulate. */
export function RebalanceModal({ holdings, engine, onApply, onClose }: Props) {
  const quoteOf = (s: string): QuoteLite | undefined => {
    const q = engine.touch(s);
    return q ? { ltp: q.ltp, sector: q.sector, mcapCr: q.mcapCr, name: q.name } : undefined;
  };
  const cur = useMemo(() => sectorWeights(holdings, quoteOf), [holdings, engine]); // eslint-disable-line react-hooks/exhaustive-deps
  const sectors = useMemo(() => Array.from(new Set([...Object.keys(cur.weights), ...DEFAULT_SECTORS])).sort((a, b) => (cur.weights[b] ?? 0) - (cur.weights[a] ?? 0)), [cur]);
  const initial = useMemo(() => {
    const t: Record<string, number> = {};
    sectors.forEach((s) => (t[s] = Math.round((cur.weights[s] ?? 0) * 10) / 10));
    // fix rounding so the starting point sums to exactly 100
    const sum = Object.values(t).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      const big = sectors.reduce((a, s) => (t[s] > t[a] ? s : a), sectors[0]);
      t[big] = Math.round((t[big] + 100 - sum) * 10) / 10;
    }
    return t;
  }, [sectors, cur]);
  const [targets, setTargets] = useState(initial);
  const [fresh, setFresh] = useState(0);
  const [done, setDone] = useState<null | { before: Holding[]; trades: number; net: number }>(null);
  // holdings changed (simulate / undo / import) → sliders restart from the new current weights
  useEffect(() => setTargets(initial), [initial]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const candidates = (sector: string) =>
    Array.from(engine.quotes.values())
      .filter((q) => q.sector === sector && q.ltp > 0)
      .sort((a, b) => b.mcapCr - a.mcapCr)
      .map((q) => ({ symbol: q.symbol, ltp: q.ltp, sector: q.sector }));
  const plan = useMemo(() => planRebalance({ holdings, quoteOf, candidates, targets, freshCash: fresh }), [holdings, targets, fresh, engine, Math.floor(Date.now() / 1000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = Object.keys(targets).some((s) => Math.abs(targets[s] - (initial[s] ?? 0)) >= 0.1);
  const empty = holdings.length === 0 || cur.total <= 0;

  const simulate = () => {
    if (plan.trades.length === 0) return;
    setDone({ before: holdings, trades: plan.trades.length, net: plan.netCash });
    onApply(plan.after);
  };
  const undo = () => {
    if (!done) return;
    onApply(done.before);
    setDone(null);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Rebalance portfolio" data-testid="rebalance-modal" onMouseDown={(e) => e.stopPropagation()} className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-xl border border-line bg-bg shadow-2xl sm:rounded-xl">
        <header className="flex items-center gap-2 border-b border-line bg-panel px-4 py-3">
          <span className="text-lg" aria-hidden>⚖️</span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold text-ink">Rebalance Portfolio</h2>
            <p className="truncate text-[11px] text-muted">Set target sector weights · portfolio value ₹{fmt(plan.total, 0)} · {holdings.length} holdings</p>
          </div>
          <button onClick={onClose} aria-label="Close (Esc)" className="flex h-8 w-8 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
        </header>

        {empty ? (
          <p className="p-8 text-center text-[13px] text-muted">Import or add holdings first — there is nothing to rebalance yet.</p>
        ) : (
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            {/* sliders */}
            <section aria-label="Target allocation" className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Target sector allocation</h3>
                <button onClick={() => { setTargets(initial); setFresh(0); }} disabled={!changed && fresh === 0} className="text-[11px] font-semibold text-accent hover:underline disabled:opacity-40">Reset to current</button>
              </div>
              {sectors.map((s) => {
                const c = cur.weights[s] ?? 0;
                const t = targets[s] ?? 0;
                return (
                  <div key={s} data-testid="rb-sector" data-sector={s}>
                    <div className="flex items-baseline justify-between text-[12px]">
                      <label htmlFor={`rb-${s}`} className="font-semibold text-ink">{s}</label>
                      <span className="num text-muted">now {c.toFixed(1)}% → <b className={`${Math.abs(t - c) < 0.05 ? 'text-ink' : t > c ? 'text-up' : 'text-down'}`} data-testid="rb-target">{t.toFixed(1)}%</b></span>
                    </div>
                    <div className="relative">
                      <input id={`rb-${s}`} type="range" min={0} max={100} step={1} value={Math.round(t)} onChange={(e) => { setDone(null); setTargets((cur0) => setTarget(cur0, s, Number(e.target.value))); }} data-testid="rb-slider" className="h-2 w-full cursor-pointer accent-accent" aria-valuetext={`${t.toFixed(1)} percent`} />
                      <span className="pointer-events-none absolute top-[-2px] h-3 w-0.5 bg-ink/60" style={{ left: `calc(${c}% * 0.96 + 2%)` }} title={`Current ${c.toFixed(1)}%`} />
                    </div>
                  </div>
                );
              })}
              <div className="num flex items-center justify-between rounded border border-line px-2.5 py-1.5 text-[11px] text-muted">
                <span>Total target</span>
                <b className="text-ink" data-testid="rb-total">{Object.values(targets).reduce((a, b) => a + b, 0).toFixed(1)}%</b>
              </div>
              <label className="flex items-center gap-2 text-[12px] text-muted">
                Fresh cash to invest (₹)
                <input type="number" min={0} step={1000} value={fresh || ''} placeholder="0" onChange={(e) => { setDone(null); setFresh(Math.max(0, Number(e.target.value) || 0)); }} data-testid="rb-fresh" className="num w-32 rounded border border-line bg-panel px-2 py-1 text-[12px] text-ink outline-none focus:border-accent" />
              </label>
            </section>

            {/* results */}
            <section aria-label="Rebalance plan" className="min-w-0 space-y-3">
              <div className="grid grid-cols-3 gap-2" data-testid="rb-cash">
                <div className="rounded border border-line bg-panel p-2"><div className="text-[10px] uppercase tracking-wide text-muted">Cash released</div><div className="num text-[15px] font-semibold text-up" data-testid="rb-released">{rupee(plan.cashReleased)}</div></div>
                <div className="rounded border border-line bg-panel p-2"><div className="text-[10px] uppercase tracking-wide text-muted">Cash required</div><div className="num text-[15px] font-semibold text-warn" data-testid="rb-required">{rupee(plan.cashRequired)}</div></div>
                <div className="rounded border border-line bg-panel p-2"><div className="text-[10px] uppercase tracking-wide text-muted">{plan.netCash > 0 ? 'Fresh money needed' : 'Left over'}</div><div className="num text-[15px] font-semibold text-ink" data-testid="rb-net">{rupee(plan.netCash)}</div></div>
              </div>
              {plan.realisedPnl !== 0 && <p className="num text-[11px] text-muted">Realised P&amp;L on trims: <b className={tone(plan.realisedPnl)}>{fmtSignedRupee(plan.realisedPnl)}</b> (before tax &amp; charges)</p>}

              <div className="overflow-x-auto rounded border border-line">
                <table className="w-full min-w-[430px] border-collapse" data-testid="rb-trades">
                  <thead>
                    <tr className="bg-panel text-right text-[10px] font-semibold uppercase tracking-wider text-muted">
                      <th className="px-2 py-1.5 text-left">Stock</th><th className="px-2 py-1.5">Action</th><th className="px-2 py-1.5">Shares</th><th className="px-2 py-1.5">Value</th><th className="px-2 py-1.5">Qty after</th><th className="px-2 py-1.5">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.trades.map((t) => (
                      <tr key={t.symbol} data-testid="rb-trade" data-symbol={t.symbol} data-side={t.side} className="border-t border-line/60 text-right">
                        <td className="px-2 py-1.5 text-left"><span className="text-[12.5px] font-semibold text-ink">{t.symbol}</span>{t.isNew && <span className="ml-1 rounded bg-accent/15 px-1 text-[9px] font-bold text-accent">NEW</span>}<div className="text-[10px] text-muted">{t.sector}</div></td>
                        <td className="px-2 py-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${t.side === 'TRIM' ? 'bg-down/15 text-down' : 'bg-up/15 text-up'}`}>{t.side === 'TRIM' ? 'Trim' : 'Add'}</span></td>
                        <td className="num px-2 py-1.5 text-[12px] text-ink">{t.side === 'TRIM' ? '−' : '+'}{t.shares}</td>
                        <td className="num px-2 py-1.5 text-[12px] text-ink">₹{fmt(t.value, 0)}</td>
                        <td className="num px-2 py-1.5 text-[12px] text-muted">{t.qtyBefore} → {t.qtyAfter}</td>
                        <td className="num px-2 py-1.5 text-[11px] text-muted">{t.wBefore.toFixed(1)}→{t.wAfter.toFixed(1)}%</td>
                      </tr>
                    ))}
                    {plan.trades.length === 0 && <tr><td colSpan={6} className="px-2 py-6 text-center text-[12px] text-muted" data-testid="rb-empty">Move a slider to see the trims and adds needed.</td></tr>}
                  </tbody>
                </table>
              </div>

              {plan.trades.length > 0 && (
                <p className="num text-[11px] text-muted">
                  After: {Object.entries(plan.afterPct).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, w]) => `${s} ${w.toFixed(1)}%`).join(' · ')}
                </p>
              )}
              {plan.skipped.length > 0 && <p className="text-[11px] text-warn">No live price for {plan.skipped.join(', ')} — left unchanged.</p>}
            </section>
          </div>
        )}

        <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-4 py-3">
          <p className="min-w-0 flex-1 text-[10px] text-muted" data-testid="rb-note">
            {done ? <span className="text-up">✓ Portfolio updated with {done.trades} trades. Net cash difference ({rupee(done.net)}) isn&apos;t tracked.</span> : 'Illustrative what-if on today’s prices — ignores tax, brokerage and liquidity. Not investment advice; no orders are placed.'}
          </p>
          {done && <button onClick={undo} data-testid="rb-undo" className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-line">Undo</button>}
          <button onClick={onClose} className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-line">Close</button>
          <button onClick={simulate} disabled={plan.trades.length === 0 || !!done} data-testid="rb-simulate" className="cursor-pointer rounded-md bg-accent px-3.5 py-1.5 text-[12px] font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">Simulate Rebalance</button>
        </footer>
      </div>
    </div>
  );
}
