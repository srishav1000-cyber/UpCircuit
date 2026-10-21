'use client';

import { useEffect, useState } from 'react';
import { Card, Stat } from '../ui';
import { fmt, fmtInt } from '@/lib/format';
import { planPosition } from '@/lib/analytics/positionSize';
import type { Quote } from '@/lib/types';

const KEY = 'upcircuit:poscalc:v1';
const inp = 'num w-full rounded border border-line bg-bg px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent';

/** Position size & stop-loss calculator. Analysis only — no order is ever placed. Capital and risk % are remembered in this browser. */
export function PositionCalc({ quote, className = '' }: { quote: Quote; className?: string }) {
  const [capital, setCapital] = useState('500000');
  const [risk, setRisk] = useState('1');
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { capital?: string; risk?: string } | null;
      if (v?.capital) setCapital(v.capital);
      if (v?.risk) setRisk(v.risk);
    } catch { /* storage blocked */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ capital, risk })); } catch { /* ignore */ }
  }, [capital, risk]);
  // entry and stop follow the selected stock until the user types their own
  useEffect(() => { setEntry(''); setStop(''); }, [quote.symbol]);
  const entryV = entry === '' ? quote.ltp : Number(entry);
  const stopV = stop === '' ? Math.round(quote.ltp * 0.99 * 20) / 20 : Number(stop);
  const plan = planPosition({ capital: Number(capital), riskPct: Number(risk), entry: entryV, stop: stopV, lowerCircuit: quote.lowerCircuit, upperCircuit: quote.upperCircuit });
  return (
    <Card title={`Position size & stop-loss · ${quote.symbol}`} badges={['computed']} className={className} right={<span className="text-[10px] text-muted">analysis only · no orders</span>}>
      <div data-testid="pos-calc" data-qty={'error' in plan ? 'err' : String(plan.qty)}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="text-[10px] uppercase tracking-wider text-muted">Capital ₹<input aria-label="Capital" data-testid="pos-capital" inputMode="decimal" className={inp} value={capital} onChange={(e) => setCapital(e.target.value)} /></label>
          <label className="text-[10px] uppercase tracking-wider text-muted">Risk % / trade<input aria-label="Risk percent" data-testid="pos-risk" inputMode="decimal" className={inp} value={risk} onChange={(e) => setRisk(e.target.value)} /></label>
          <label className="text-[10px] uppercase tracking-wider text-muted">Entry ₹<input aria-label="Entry" data-testid="pos-entry" inputMode="decimal" className={inp} value={entry} placeholder={quote.ltp.toFixed(2)} onChange={(e) => { setEntry(e.target.value); }} /></label>
          <label className="text-[10px] uppercase tracking-wider text-muted">Stop ₹<input aria-label="Stop" data-testid="pos-stop" inputMode="decimal" className={inp} value={stop} placeholder={stopV.toFixed(2)} onChange={(e) => { setStop(e.target.value); }} /></label>
        </div>
        {'error' in plan ? (
          <p className="mt-3 text-[12px] text-down" role="alert" data-testid="pos-error">{plan.error}</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={`Quantity · ${plan.side}`} value={fmtInt(plan.qty)} valueClass="text-accent" sub={`₹${fmt(plan.perShareRisk)} risk / share`} hint="⌊ capital × risk % ÷ |entry − stop| ⌋, capped by cash" />
              <Stat label="Position value" value={`₹${fmtInt(Math.round(plan.positionValue))}`} sub={`${plan.positionPct.toFixed(1)}% of capital`} />
              <Stat label="Risk budget" value={`₹${fmtInt(Math.round(plan.riskRupees))}`} sub={`loss at stop ₹${fmtInt(Math.round(plan.lossAtStop))}`} valueClass="text-down" />
              <Stat label="Targets (R)" value={<span className="text-[13px]">{plan.targets.map((t) => `${t.r}R ${fmt(t.price)}`).join(' · ')}</span>} sub={`gain at 2R ₹${fmtInt(Math.round(plan.targets[1].gain))}`} />
            </div>
            {plan.warnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-[11px] text-warn" data-testid="pos-warnings">
                {plan.warnings.map((w) => <li key={w}>⚠ {w}</li>)}
              </ul>
            )}
          </>
        )}
        <p className="mt-2 text-[10px] text-muted">Quantity = ⌊capital × risk % ÷ |entry − stop|⌋, capped at what the cash can buy (no leverage). Fills, slippage and brokerage are not modelled.</p>
      </div>
    </Card>
  );
}
