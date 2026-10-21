'use client';

import { Card, Stat } from '../ui';
import { fmt } from '@/lib/format';
import { openingRange } from '@/lib/analytics/orb';
import type { MarketEngine } from '@/lib/market';

/** Opening Range Breakout tracker: 09:15–09:30 IST high/low, current state, and the first close outside the range. */
export function OrbCard({ engine, symbol, className = '' }: { engine: MarketEngine; symbol: string; className?: string }) {
  const hist = engine.historyOf(symbol, '1m');
  const live = engine.liveBars(symbol, '1m');
  const fromLive = hist.length === 0 && live.length > 0;
  const orb = openingRange(fromLive ? live : hist);
  const ltp = engine.quotes.get(symbol)?.ltp ?? null;
  const state = orb?.state;
  const stateTxt = !orb ? 'N/A' : state === 'forming' ? 'Range forming' : state === 'above' ? 'Above range ▲' : state === 'below' ? 'Below range ▼' : 'Inside range';
  const tone = state === 'above' ? 'text-up' : state === 'below' ? 'text-down' : 'text-ink';
  return (
    <Card title={`Opening range breakout · ${symbol}`} badges={[fromLive ? 'smartapi' : 'yahoo', 'computed']} className={className} right={<span className={`num text-[11px] font-semibold ${tone}`} data-testid="orb-state">{stateTxt}</span>}>
      <div data-testid="orb-card" data-orb={orb ? `${orb.high.toFixed(2)}|${orb.low.toFixed(2)}|${orb.state}` : 'na'}>
        {!orb ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="orb-na">N/A — no 09:15–09:30 IST bars for this session yet (needs 1-minute bars covering the open).</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Range high" value={fmt(orb.high)} valueClass="text-up" />
              <Stat label="Range low" value={fmt(orb.low)} valueClass="text-down" />
              <Stat label="Width" value={`${orb.widthPct.toFixed(2)}%`} sub={`₹${fmt(orb.width)} · ${orb.barsInRange} bars`} />
            </div>
            {ltp !== null && orb.high > orb.low && (
              <div className="relative mt-3 h-2 rounded-full bg-line" aria-hidden>
                {(() => { const span = orb.width * 3; const lo = orb.low - orb.width; const pos = Math.max(0, Math.min(100, ((ltp - lo) / span) * 100)); return (<><div className="absolute top-0 h-full rounded-full bg-accent/30" style={{ left: '33.3%', width: '33.3%' }} /><span className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-ink ring-2 ring-panel" style={{ left: `${pos}%` }} /></>); })()}
              </div>
            )}
            <p className="mt-2 text-[11px] text-muted" data-testid="orb-read">
              {orb.breakout
                ? <>First close {orb.breakout.dir === 'up' ? 'above the high' : 'below the low'} at <b className="text-ink">{orb.breakout.time}</b> (₹{fmt(orb.breakout.price)}, {orb.breakout.distancePct.toFixed(2)}% beyond the edge){orb.breakout.volumeRatio !== null && <> on <b className="text-ink">{orb.breakout.volumeRatio.toFixed(1)}×</b> the opening-range volume</>} · {orb.breakout.confirmed ? <b className="text-up">confirmed by the next bar</b> : <b className="text-warn">unconfirmed — next bar did not hold</b>}.</>
                : state === 'forming' ? 'The opening range is still forming; no breakout can be called before 09:30 IST.' : 'No bar has closed outside the opening range yet.'}
              {' '}Range = High/Low of 1-minute bars 09:15–09:30; a breakout needs a bar CLOSE outside it.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
