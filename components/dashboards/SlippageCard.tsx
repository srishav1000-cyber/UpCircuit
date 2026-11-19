'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, Stat } from '../ui';
import { fmt, fmtInt } from '@/lib/format';
import { slippageReport, defaultQty, SessionDepthMedian, NEAR_CIRCUIT_PCT, THIN_DEPTH_RATIO, MIN_MEDIAN_SAMPLES } from '@/lib/analytics/slippage';
import { isMarketOpen, type MarketEngine } from '@/lib/market';

/** one per browser session: remembers the depth the book showed, so "thin" can be judged against this symbol's own session median */
const sessionDepth = new SessionDepthMedian();

/** Live order-book slippage + circuit-lock exit-risk calculator for the inspected stock (live SmartAPI 5-level depth only; N/A otherwise). */
export function SlippageCard({ engine, symbol, className = '' }: { engine: MarketEngine; symbol: string; className?: string }) {
  const [side, setSide] = useState<'buy' | 'sell'>('sell');
  const [typed, setTyped] = useState<string | null>(null);
  const [, tick] = useState(0);
  const q = engine.quotes.get(symbol);
  const live = engine.depthReal;
  const depth = live ? engine.depth : null;

  // sample the book twice a second into the session-median tracker (it throttles itself to one sample per 5 s)
  useEffect(() => {
    const t = setInterval(() => {
      const d = engine.depthReal ? engine.depth : null;
      if (d && isMarketOpen(Date.now())) {
        sessionDepth.push(symbol, 'bid', d.bids.reduce((a, l) => a + l.qty, 0));
        sessionDepth.push(symbol, 'ask', d.asks.reduce((a, l) => a + l.qty, 0));
      }
      tick((n) => (n + 1) % 1_000_000);
    }, 500);
    return () => clearInterval(t);
  }, [engine, symbol]);

  const qty = typed ?? String(defaultQty(q?.ltp));
  const consumed = side === 'buy' ? 'ask' : 'bid';
  const report = useMemo(
    () => slippageReport({
      bids: depth?.bids, asks: depth?.asks, side, qty: Number(qty), ltp: q?.ltp ?? 0, upperCircuit: q?.upperCircuit, lowerCircuit: q?.lowerCircuit, bandKnown: q?.bandKnown,
      marketOpen: isMarketOpen(Date.now()), sessionMedian: sessionDepth.median(symbol, consumed),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [depth?.bids, depth?.asks, side, qty, q?.ltp, q?.upperCircuit, q?.lowerCircuit, q?.bandKnown, symbol, consumed],
  );
  const r = report.status === 'ok' ? report.fill : null;
  const ex = report.status === 'ok' ? report.exit : null;

  return (
    <Card title={`Order-book slippage & exit risk · ${symbol}`} badges={[report.status === 'ok' ? 'smartapi' : 'na', 'computed']} className={className}>
      <div data-testid="slip-card" data-slip={r ? r.slipBps.toFixed(2) : 'na'} data-exit-warn={ex ? String(ex.warn) : 'na'}>
        {report.status === 'na' && report.reason !== 'bad_quantity' ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="slip-na">{report.message}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid grid-cols-2 gap-1 rounded-full border border-line p-0.5 text-[11px] font-semibold" role="group" aria-label="Order side">
                {(['buy', 'sell'] as const).map((s) => <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} className={`rounded-full px-3 py-1 ${side === s ? (s === 'buy' ? 'bg-up/20 text-up' : 'bg-down/20 text-down') : 'text-muted'}`}>{s === 'buy' ? 'Buy' : 'Sell'}</button>)}
              </div>
              <label className="text-[10px] uppercase tracking-wider text-muted">Shares<input aria-label="Order quantity" data-testid="slip-qty" inputMode="numeric" value={qty} onChange={(e) => setTyped(e.target.value.replace(/[^\d]/g, ''))} className="num ml-2 w-24 rounded border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent" /></label>
              <span className="text-[10px] text-muted">default ≈ ₹1 lakh{q ? ` ÷ ₹${fmt(q.ltp)}` : ''}</span>
            </div>
            {!r ? (
              <p className="mt-3 text-[12px] text-muted">Enter a positive quantity.</p>
            ) : (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <Stat label="VWAP fill" value={`₹${fmt(r.avgPrice, 3)}`} sub={`best ₹${fmt(r.best)} · ${r.levelsUsed} level${r.levelsUsed === 1 ? '' : 's'}`} />
                  <Stat label="Slippage" value={`${r.slipBps.toFixed(1)} bps`} valueClass={r.slipBps > 10 ? 'text-down' : r.slipBps > 3 ? 'text-warn' : 'text-up'} sub={`₹${fmt(r.slipPerShare, 3)} / share`} />
                  <Stat label="Total slippage" value={`₹${fmtInt(Math.round(r.slipTotal))}`} sub={`on ${fmtInt(r.filled)} shares`} />
                  <Stat label="Depth consumed" value={<span data-testid="slip-depth-pct">{r.depthConsumedPct.toFixed(1)}%</span>} valueClass={r.depthConsumedPct >= 100 ? 'text-down' : r.depthConsumedPct > 50 ? 'text-warn' : 'text-ink'} sub={`of ${fmtInt(r.visibleQty)} visible (${consumed}s)`} />
                  <Stat label="Half-spread" value={r.halfSpreadBps === null ? 'N/A' : `${r.halfSpreadBps.toFixed(1)} bps`} sub="cost of a 1-share order" />
                </div>
                {r.unfilled > 0 && <p className="mt-2 text-[11px] text-warn" data-testid="slip-partial" role="status">⚠ {fmtInt(r.unfilled)} of {fmtInt(r.qty)} shares exceed the visible 5-level depth — the real cost would be higher than shown.</p>}
                {ex && (
                  <div className="mt-2" data-testid="slip-exit-risk">
                    {ex.warn
                      ? <p className="rounded border border-down/40 bg-down/10 px-2 py-1.5 text-[11px] text-down" role="alert" data-testid="slip-exit-warn">⚠ {ex.message}</p>
                      : <p className="text-[11px] text-muted">Exit risk: LTP is more than {NEAR_CIRCUIT_PCT}% from both circuit prices{ex.depthRatio !== null ? ` and ${consumed} depth is ${Math.round(ex.depthRatio * 100)}% of its session median` : ''}.</p>}
                    <p className="mt-1 text-[10px] text-muted" data-testid="slip-exit-detail">
                      To upper circuit {ex.toUpperPct === null ? 'N/A' : `${ex.toUpperPct.toFixed(2)}%`} · to lower {ex.toLowerPct === null ? 'N/A' : `${ex.toLowerPct.toFixed(2)}%`}{report.status === 'ok' && report.bandInferred ? ' (band inferred, not exchange-confirmed)' : ''} ·
                      {' '}{ex.sessionMedianQty === null ? `session-median depth N/A (building: ${ex.medianSamples}/${MIN_MEDIAN_SAMPLES} samples)` : `${consumed} depth ${fmtInt(ex.consumedSideQty)} vs session median ${fmtInt(Math.round(ex.sessionMedianQty))}`}
                    </p>
                  </div>
                )}
              </>
            )}
            <p className="mt-2 text-[10px] text-muted">VWAP fill = Σ price × shares taken ÷ shares, walking the top 5 levels; slippage = VWAP − best price. Exit-risk warning when LTP is within {NEAR_CIRCUIT_PCT}% of a circuit price or the book side you would hit holds under {THIN_DEPTH_RATIO * 100}% of its session median. Ignores hidden liquidity and book changes while filling; a screening aid, not a prediction.</p>
          </>
        )}
      </div>
    </Card>
  );
}
