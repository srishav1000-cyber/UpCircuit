'use client';

import { useMemo } from 'react';
import { Card } from '../ui';
import type { DepthLevel } from '@/lib/types';
import { imbalanceLabel, MIN_DEPTH_QTY, topFiveImbalance } from '@/lib/depthImbalance';

const TONE = { up: 'text-up', down: 'text-down', muted: 'text-muted' } as const;
const fmtQty = (n: number) => n.toLocaleString('en-IN');
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;

/** half-circle arc from −1 (left) to +1 (right); angle 180° → 0° */
function pt(v: number, r: number, cx: number, cy: number): [number, number] {
  const a = Math.PI * (1 - (v + 1) / 2);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}
const arc = (from: number, to: number, r: number, cx: number, cy: number) => {
  const [x1, y1] = pt(from, r, cx, cy), [x2, y2] = pt(to, r, cx, cy);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};

export interface OrderImbalanceGaugeProps {
  bids: DepthLevel[];
  asks: DepthLevel[];
  symbol: string;
  /** false → the live SmartAPI depth stream is not in use: render N/A, never a stale or invented book */
  live: boolean;
  /** optional rule thresholds to mark on the dial (the magnitude you set: above = +x, below = −x) */
  thresholds?: { above?: number; below?: number };
  className?: string;
}

/**
 * Top-5 depth order-imbalance gauge. imbalance = (Σ bid qty − Σ ask qty) ÷ (Σ bid qty + Σ ask qty) over the best five levels of each side.
 * It describes RESTING orders only — they can be cancelled before they trade — so it is a heuristic, not a prediction (and the card says so).
 */
export function OrderImbalanceGauge({ bids, asks, symbol, live, thresholds, className = '' }: OrderImbalanceGaugeProps) {
  const imb = useMemo(() => (live ? topFiveImbalance(bids, asks) : null), [live, bids, asks]);
  const lab = imb ? imbalanceLabel(imb.value) : null;
  const max = imb ? Math.max(1, ...imb.bids, ...imb.asks) : 1;
  const rows = imb ? Array.from({ length: Math.max(imb.bids.length, imb.asks.length) }, (_, i) => ({ bid: imb.bids[i] ?? 0, ask: imb.asks[i] ?? 0 })) : [];
  const W = 220, CX = 110, CY = 100, R = 82;
  const [nx, ny] = imb ? pt(imb.value, R - 8, CX, CY) : [CX, CY];

  return (
    <Card
      title={`Depth imbalance · ${symbol}`}
      badges={[imb ? 'smartapi' : 'na']}
      className={className}
      right={<span data-testid="imb-tag" className="rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">Top-5 Depth Heuristic Indicator</span>}
    >
      <div data-testid="imb-gauge" data-imbalance={imb ? imb.value.toFixed(3) : 'na'}>
        {!imb ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="imb-na">
            {live ? `N/A — the order book is empty or too thin (under ${fmtQty(MIN_DEPTH_QTY)} shares across the top 5 levels) for a meaningful ratio.` : 'N/A — order-book depth is streamed by SmartAPI only while the market is live.'}
          </p>
        ) : (
          <>
            <div className="mx-auto w-full max-w-[260px]" role="meter" aria-label={`Net order imbalance for ${symbol}`} aria-valuemin={-1} aria-valuemax={1} aria-valuenow={Number(imb.value.toFixed(2))} aria-valuetext={`${signed(imb.value)}, ${lab?.label}`}>
              <svg viewBox={`0 0 ${W} 112`} className="w-full" aria-hidden focusable="false">
                <path d={arc(-1, -0.2, R, CX, CY)} fill="none" stroke="rgb(var(--c-down) / 0.6)" strokeWidth="12" strokeLinecap="butt" />
                <path d={arc(-0.2, 0.2, R, CX, CY)} fill="none" stroke="rgb(var(--c-muted) / 0.35)" strokeWidth="12" />
                <path d={arc(0.2, 1, R, CX, CY)} fill="none" stroke="rgb(var(--c-up) / 0.6)" strokeWidth="12" />
                {thresholds?.above ? <line {...tick(thresholds.above, R, CX, CY)} stroke="currentColor" className="text-ink" strokeWidth="2" /> : null}
                {thresholds?.below ? <line {...tick(-thresholds.below, R, CX, CY)} stroke="currentColor" className="text-ink" strokeWidth="2" /> : null}
                <line x1={CX} y1={CY} x2={nx} y2={ny} stroke="currentColor" className="text-ink" strokeWidth="3" strokeLinecap="round" />
                <circle cx={CX} cy={CY} r="5" fill="currentColor" className="text-ink" />
                <text x="14" y="110" className="fill-muted" fontSize="9">−1 asks</text>
                <text x={CX} y="14" textAnchor="middle" className="fill-muted" fontSize="9">0</text>
                <text x={W - 14} y="110" textAnchor="end" className="fill-muted" fontSize="9">+1 bids</text>
              </svg>
            </div>
            <div className="-mt-1 text-center">
              <div className={`num text-2xl font-semibold ${TONE[lab!.tone]}`} data-testid="imb-value">{signed(imb.value)}</div>
              <div className={`text-[12px] font-semibold ${TONE[lab!.tone]}`} data-testid="imb-label">{lab!.label}</div>
              <div className="mt-0.5 text-[10px] text-muted">(Σbid − Σask) ÷ (Σbid + Σask), best 5 levels</div>
            </div>

            <div className="mt-3" data-testid="imb-levels" aria-label="Quantity by level, bids left, asks right">
              <div className="mb-1 flex justify-between text-[9px] font-semibold uppercase tracking-wider text-muted"><span>Bid qty</span><span>Level</span><span>Ask qty</span></div>
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_1.5rem_1fr] items-center gap-1 py-[2px]">
                  <div className="flex items-center justify-end gap-1.5">
                    <span className="num text-[10px] text-ink">{r.bid ? fmtQty(r.bid) : '—'}</span>
                    <div className="h-2.5 w-full max-w-[90px] rounded-l bg-line/50"><div className="ml-auto h-full rounded-l bg-up" style={{ width: `${(r.bid / max) * 100}%` }} /></div>
                  </div>
                  <span className="text-center text-[9px] text-muted">L{i + 1}</span>
                  <div className="flex items-center gap-1.5">
                    <div className="h-2.5 w-full max-w-[90px] rounded-r bg-line/50"><div className="h-full rounded-r bg-down" style={{ width: `${(r.ask / max) * 100}%` }} /></div>
                    <span className="num text-[10px] text-ink">{r.ask ? fmtQty(r.ask) : '—'}</span>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 flex justify-between text-[11px] text-muted"><span>Σ bid <b className="num text-up" data-testid="imb-bid">{fmtQty(imb.bidQty)}</b></span><span>Σ ask <b className="num text-down" data-testid="imb-ask">{fmtQty(imb.askQty)}</b></span></p>
          </>
        )}
        <p className="mt-2 text-[10px] leading-snug text-muted">Heuristic of resting orders only — quantity can be cancelled before it trades, so this is not a forecast of price direction.</p>
      </div>
    </Card>
  );
}

function tick(v: number, r: number, cx: number, cy: number) {
  const [x1, y1] = pt(v, r - 9, cx, cy), [x2, y2] = pt(v, r + 9, cx, cy);
  return { x1, y1, x2, y2 };
}
