'use client';

import { useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import type { Holding } from '@/lib/types';
import type { Persona } from '@/lib/personas';
import { MAX_FOCUS } from '@/lib/focus';
import { fmt, fmtInt, fmtPct, tone } from '@/lib/format';
import { Card } from './ui';

interface Props {
  persona: Persona;
  engine: MarketEngine;
  focus: string[];
  /** symbols the user can add: watchlists + holdings */
  candidates: string[];
  holdings: Holding[];
  onToggle: (sym: string) => string | null;
  onSelect: (sym: string) => void;
  /** bumps with every market render so the tiles stay live */
  version: number;
}

/** Live tiles for the user's 5–6 focus tickers, shown at the top of the Day Trader and Retail dashboards. */
export function FocusBoard({ persona, engine, focus, candidates, holdings, onToggle, onSelect }: Props) {
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const toggle = (s: string) => setErr(onToggle(s));
  const avail = candidates.filter((s) => !focus.includes(s));
  return (
    <Card
      title={`🎯 My focus · ${focus.length}/${MAX_FOCUS}`}
      right={
        <button onClick={() => setPick((o) => !o)} data-testid="focus-edit" className="rounded border border-line px-2 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/10">
          {pick ? 'Done' : 'Edit'}
        </button>
      }
      className="mb-3"
    >
      <div data-testid="focus-board" className="p-3">
        {focus.length === 0 && <p className="text-[12px] text-muted">Pick up to {MAX_FOCUS} stocks from your watchlists and this dashboard will track just those, live. Click <b>Edit</b>.</p>}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {focus.map((s) => {
            const q = engine.touch(s);
            if (!q) return null;
            const chg = q.ltp - q.prevClose;
            const pct = q.prevClose ? (chg / q.prevClose) * 100 : 0;
            const pos = q.high > q.low ? ((q.ltp - q.low) / (q.high - q.low)) * 100 : 50;
            const vwap = q.sumV > 0 ? q.sumPV / q.sumV : q.ltp;
            const h = holdings.find((x) => x.symbol === s);
            return (
              <div key={s} data-testid={`focus-${s}`} className="rounded-md border border-line bg-bg/40 p-2 text-[11px]">
                <div className="flex items-center justify-between">
                  <button onClick={() => onSelect(s)} className="font-bold text-ink hover:text-accent">{s}</button>
                  {pick && <button onClick={() => toggle(s)} aria-label={`Remove ${s}`} className="text-muted hover:text-down">✕</button>}
                </div>
                <div className="num flex items-baseline gap-1.5">
                  <span className={`text-[15px] font-semibold ${tone(chg)}`}>{fmt(q.ltp)}</span>
                  <span className={tone(chg)}>{fmtPct(pct)}</span>
                </div>
                <div className="my-1 h-1 rounded bg-line" title="Position in today's range"><div className="h-1 rounded bg-accent" style={{ width: `${Math.max(2, Math.min(100, pos))}%` }} /></div>
                <div className="num text-muted">
                  {persona === 'day' ? (
                    <>VWAP <b className="text-ink">{fmt(vwap)}</b> · <span className={tone(q.ltp - vwap)}>{q.ltp >= vwap ? 'above' : 'below'}</span> · Vol <b className="text-ink">{fmtInt(q.volume)}</b></>
                  ) : h ? (
                    <>P&amp;L <b className={tone(q.ltp - h.avg)}>₹{fmt((q.ltp - h.avg) * h.qty)}</b> · {h.qty} sh</>
                  ) : (
                    <>Yield <b className="text-ink">{fmt(q.dividendYield)}%</b> · Mcap <b className="text-ink">₹{fmtInt(q.mcapCr)} Cr</b></>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {pick && (
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="focus-picker">
            {avail.length === 0 && <span className="text-[11px] text-muted">Add stocks to a watchlist (⭐) to choose them here.</span>}
            {avail.map((s) => (
              <button key={s} onClick={() => toggle(s)} data-testid={`focus-add-${s}`} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-accent/10">+ {s}</button>
            ))}
          </div>
        )}
        {err && <p role="alert" className="mt-2 text-[11px] text-warn">{err}</p>}
      </div>
    </Card>
  );
}
