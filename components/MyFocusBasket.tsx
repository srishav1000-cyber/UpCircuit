'use client';

import { TickPriceFlash } from './TickPriceFlash';
import { useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import type { Holding, Instrument } from '@/lib/types';
import { StockAutocomplete } from './StockAutocomplete';
import type { Persona } from '@/lib/personas';
import { MAX_FOCUS } from '@/lib/focus';
import { fmt, fmtInt, fmtPct, tone } from '@/lib/format';
import { Card } from './ui';
import { GLOW } from './CircuitAlerts';
import type { CircuitDir } from '@/lib/circuit';

interface Props {
  persona: Persona;
  engine: MarketEngine;
  focus: string[];
  /** symbols the user can add: watchlists + holdings */
  candidates: string[];
  /** the full instrument master — the "+ Add" box searches ALL of it, not just `candidates` */
  instruments: Instrument[];
  priceOf?: (symbol: string) => number | undefined;
  holdings: Holding[];
  onToggle: (sym: string) => string | null;
  onSelect: (sym: string) => void;
  /** bumps with every market render so the tiles stay live */
  version: number;
  /** the globally selected symbol → blue glowing ring */
  selected?: string;
  /** symbols currently at a circuit → pulsing glow */
  glow?: Record<string, CircuitDir>;
}

/** Live tiles for the user's 5–6 focus tickers ("My Focus"), shown at the top of the Day Trader and Retail dashboards. Clicking a tile selects that stock everywhere. */
export function MyFocusBasket({ persona, engine, focus, candidates, instruments, priceOf, holdings, onToggle, onSelect, selected, glow = {} }: Props) {
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
            if (!q)
              return (
                <div key={s} data-testid={`focus-${s}`} data-loading="true" className="rounded-md border border-dashed border-line bg-bg/40 p-2 text-[11px]">
                  <div className="flex items-center justify-between"><span className="font-bold text-ink">{s}</span>{pick && <button onClick={() => toggle(s)} aria-label={`Remove ${s}`} className="text-muted hover:text-down">✕</button>}</div>
                  <div className="mt-1 animate-pulse text-muted">Resolving token &amp; loading quote…</div>
                </div>
              );
            const chg = q.ltp - q.prevClose;
            const pct = q.prevClose ? (chg / q.prevClose) * 100 : 0;
            const pos = q.high > q.low ? ((q.ltp - q.low) / (q.high - q.low)) * 100 : 50;
            const vwap = q.sumV > 0 ? q.sumPV / q.sumV : q.ltp;
            const h = holdings.find((x) => x.symbol === s);
            return (
              <div
                key={s}
                role="button"
                tabIndex={0}
                aria-pressed={selected === s}
                aria-label={`Select ${s}`}
                onClick={() => onSelect(s)}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onSelect(s); } }}
                data-testid={`focus-${s}`}
                data-selected={selected === s ? 'true' : undefined}
                data-glow={glow[s] ?? undefined}
                className={`cursor-pointer rounded-md border p-2 text-[11px] outline-none transition focus-visible:ring-2 focus-visible:ring-blue-400 ${selected === s ? 'ring-2 ring-blue-500/80 bg-blue-500/10 shadow-[0_0_20px_rgba(59,130,246,0.3)] ' : 'bg-bg/40 '}${glow[s] ? `border-2 ${GLOW[glow[s]]}` : 'border-line'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-ink">{s}</span>
                  {pick && <button onClick={(e) => { e.stopPropagation(); toggle(s); }} aria-label={`Remove ${s}`} className="text-muted hover:text-down">✕</button>}
                </div>
                <div className="num flex items-baseline gap-1.5">
                  <span className={`text-[15px] font-semibold ${tone(chg)}`}><TickPriceFlash value={q.ltp}>{fmt(q.ltp)}</TickPriceFlash></span>
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
          <div className="mt-3" data-testid="focus-picker">
            <StockAutocomplete
              testid="focus-search"
              instruments={instruments}
              exclude={focus}
              priceOf={priceOf}
              placeholder={`Add any stock — ticker, company or BSE code (${instruments.length.toLocaleString('en-IN')} listed)`}
              onAdd={(i) => onToggle(i.symbol)}
            />
            {candidates.filter((c) => !focus.includes(c)).length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="focus-suggest">
                <span className="text-[10px] uppercase tracking-wider text-muted">From your lists</span>
                {candidates.filter((c) => !focus.includes(c)).slice(0, 8).map((s) => (
                  <button key={s} onClick={() => toggle(s)} data-testid={`focus-add-${s}`} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-accent/10">+ {s}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {err && <p role="alert" className="mt-2 text-[11px] text-warn">{err}</p>}
      </div>
    </Card>
  );
}
