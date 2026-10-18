'use client';

import { Card, Meter, Stat, ZONE } from '../ui';
import { BandChart, BarChart, CARD_GRID, WIDE } from './charts';
import { C, alpha } from '@/lib/theme';
import { intradaySigma, tickVolumeBuckets, vwapBands } from '@/lib/analytics';
import { fmt, fmtInt, fmtPct, fmtSigned, tone } from '@/lib/format';
import { spreadOf } from '@/lib/market';
import type { DashboardProps } from './types';

/** Analytical shortcuts (no order entry anywhere in UpCircuit). */
const SHORTCUTS: { key: string; label: string; action: string; cls?: string }[] = [
  { key: 'R', label: '🔍 Deep Research', action: 'r', cls: 'text-accent' },
  { key: 'W', label: '⭐ Watchlist', action: 'w', cls: 'text-warn' },
  { key: 'A', label: '🔔 Set Price Alert', action: 'a' },
  { key: '1', label: '1m chart', action: '1' },
  { key: '2', label: '5m chart', action: '2' },
  { key: '3', label: '1D chart', action: '3' },
  { key: '/', label: 'Search', action: '/' },
  { key: 'Esc', label: 'Close / exit full screen', action: 'Escape' },
];

export function DayTraderDashboard({ engine, quote, onAction }: DashboardProps) {
  const { bids, asks } = engine.depth;
  const maxQty = Math.max(1, ...bids.map((l) => l.qty), ...asks.map((l) => l.qty));
  const bidTot = bids.reduce((a, l) => a + l.qty, 0);
  const askTot = asks.reduce((a, l) => a + l.qty, 0);
  const imbalance = bidTot + askTot > 0 ? ((bidTot - askTot) / (bidTot + askTot)) * 100 : 0;

  const session = quote.sumV > 0 ? quote.sumPV / quote.sumV : quote.ltp;
  const rolling = engine.rollingVwap(5 * 60_000);
  const vwap = rolling ?? session;
  const vwapSpread = quote.ltp - vwap;
  const vol = engine.realisedVol();
  const tpm = engine.ticksPerMin();

  const trades5m = engine.recentTrades(5 * 60_000);
  const bands = vwapBands(trades5m, 2);
  const bandPrices = (() => {
    const step = Math.max(1, Math.ceil(trades5m.length / 120));
    return trades5m.filter((_, i) => i % step === 0 || i === trades5m.length - 1).map((t) => t.p);
  })();
  const tv = tickVolumeBuckets(engine.recentTrades(3 * 60_000), Date.now(), 5000, 36);
  const sig = intradaySigma(engine.priceSamples(240), 4 * 22500 * 252);
  const sigmaMin = sig ? sig.perSamplePct * Math.sqrt(240) : null; // 240 samples per minute
  const volTone = sig === null ? 'text-muted' : sig.annualisedPct < 20 ? 'text-up' : sig.annualisedPct < 40 ? 'text-ink' : 'text-down';
  const volLabel = sig === null ? 'warming up' : sig.annualisedPct < 20 ? 'Low' : sig.annualisedPct < 40 ? 'Normal' : 'High';
  const noDepth = bids.length === 0 || asks.length === 0;

  return (
    <div className={CARD_GRID}>
      <Card
        title="Market depth · 5 levels"
        right={noDepth ? undefined : <span className={`num text-[11px] ${tone(imbalance)}`}>{engine.depthReal ? 'Exchange · ' : 'Simulated · '}imbalance {fmtPct(imbalance, 1)}</span>}
      >
        {noDepth && <p className="py-6 text-center text-[12px] text-muted">Waiting for order-book depth from the feed…</p>}
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 pb-1 text-[10px] uppercase tracking-wider text-muted">
          <span>Price</span>
          <span className="text-right">Orders</span>
          <span className="w-16 text-right">Qty</span>
        </div>
        <div className="space-y-px">
          {[...asks].reverse().map((l, i) => (
            <DepthRow key={'a' + i} price={l.price} qty={l.qty} orders={l.orders} pct={(l.qty / maxQty) * 100} side="ask" />
          ))}
        </div>
        <div className="num my-1.5 flex items-center justify-between rounded bg-bg px-2 py-1.5 text-[12px]">
          <span className={`text-[15px] font-semibold ${tone(quote.ltp - quote.prevClose)}`}>{fmt(quote.ltp)}</span>
          <span className="text-muted">Spread ₹{fmt(spreadOf(quote.ltp))}</span>
        </div>
        <div className="space-y-px">
          {bids.map((l, i) => (
            <DepthRow key={'b' + i} price={l.price} qty={l.qty} orders={l.orders} pct={(l.qty / maxQty) * 100} side="bid" />
          ))}
        </div>
        <div className="num mt-2 flex justify-between text-[11px]">
          <span className="text-up">Bid total {fmtInt(bidTot)}</span>
          <span className="text-down">Ask total {fmtInt(askTot)}</span>
        </div>
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-full">
          <div className="bg-up" style={{ width: `${(bidTot / (bidTot + askTot || 1)) * 100}%` }} />
          <div className="flex-1 bg-down" />
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Ticks / Min" value={fmtInt(tpm)} sub="trades, rolling 60 s" />
        <Stat label="Rolling VWAP · 5m" value={fmt(vwap)} sub={rolling === null ? 'warming up — session VWAP' : `Session ${fmt(session)}`} hint="Σ(price × volume) ÷ Σ(volume) over the last 5 minutes of trades" />
        <Stat label="VWAP Spread" value={<span className={tone(vwapSpread)}>{fmtSigned(vwapSpread)}</span>} sub={fmtPct((vwapSpread / vwap) * 100) + ' vs VWAP'} />
        <Stat label="Volatility σ" value={vol === null ? '…' : vol.toFixed(1) + '%'} sub="Realised, annualised" hint="Std-dev of 250 ms log-returns over the last 60 s, annualised" />
      </div>

      <Card title="VWAP bands · ±2σ" right={<span className="num text-[10px] text-muted">last 5 min · {bands?.n ?? 0} trades</span>}>
        {bands ? (
          <>
            <BandChart price={bandPrices} vwap={bands.vwap} upper={bands.upper} lower={bands.lower} />
            <div className="num mt-1 grid grid-cols-3 gap-2 text-center text-[11px]">
              <div><div className="text-[10px] uppercase tracking-wider text-muted">Upper</div><b className="text-down">{fmt(bands.upper)}</b></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted">VWAP</div><b className="text-warn">{fmt(bands.vwap)}</b></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted">Lower</div><b className="text-up">{fmt(bands.lower)}</b></div>
            </div>
            <p className="mt-1.5 text-[10px] text-muted">
              {quote.ltp > bands.upper ? 'Price is above the upper band — stretched vs VWAP.' : quote.ltp < bands.lower ? 'Price is below the lower band — stretched vs VWAP.' : `Price is inside the bands (σ ${bands.sd.toFixed(2)}).`} Bands = VWAP ± 2 × volume-weighted σ.
            </p>
          </>
        ) : (
          <p className="py-6 text-center text-[12px] text-muted">Collecting trades…</p>
        )}
      </Card>

      <Card title="Tick volume · 5 s buckets" right={<span className="text-[10px] text-muted">last 3 min · <span className="text-up">upticks</span> / <span className="text-down">downticks</span></span>}>
        <BarChart
          bars={tv.map((b, i) => ({ label: i % 6 === 0 ? `−${(36 - i) * 5}s` : '', value: b.volume, color: b.net >= 0 ? alpha('up', 0.8) : alpha('down', 0.8), title: `${fmtInt(b.volume)} shares · net ${b.net >= 0 ? '+' : ''}${fmtInt(b.net)}` }))}
          showEvery={6}
        />
      </Card>

      <Card title="Intraday volatility index σ" right={<span className={`text-[11px] font-semibold ${volTone}`}>{volLabel}</span>}>
        <div className="flex items-baseline gap-3">
          <span className={`num text-3xl font-semibold ${volTone}`}>{sig ? sig.annualisedPct.toFixed(1) + '%' : '…'}</span>
          <span className="num text-[12px] text-muted">{sigmaMin === null ? '' : `σ ≈ ${sigmaMin.toFixed(3)}% per minute`}</span>
        </div>
        <div className="mt-2">
          <Meter value={Math.min(80, sig?.annualisedPct ?? 0)} max={80} zones={[{ to: 20, color: ZONE.up }, { to: 40, color: ZONE.muted }, { to: 80, color: ZONE.down }]} />
          <div className="num mt-1 flex justify-between text-[10px] text-muted"><span>0</span><span>20 low</span><span>40 high</span><span>80+</span></div>
        </div>
        <p className="mt-2 text-[10px] text-muted" style={{ color: C.muted }}>Stdev of 250 ms log-returns over the last 60 s, annualised.</p>
      </Card>

      <Card title="Analysis shortcuts" right={<span className="text-[10px] text-muted">R · W · A</span>} className={WIDE}>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-2 [.fs_&]:lg:grid-cols-4">
          {SHORTCUTS.map((h) => (
            <button key={h.key} onClick={() => onAction(h.action)} className="flex items-center justify-between gap-2 rounded border border-line bg-bg px-2.5 py-1.5 text-[12px] hover:border-accent">
              <span className={`truncate ${h.cls ?? 'text-ink'}`}>{h.label}</span>
              <kbd>{h.key}</kbd>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function DepthRow({ price, qty, orders, pct, side }: { price: number; qty: number; orders: number; pct: number; side: 'bid' | 'ask' }) {
  return (
    <div className="num relative grid grid-cols-[1fr_auto_auto] gap-x-3 rounded-sm px-1.5 py-[3px] text-[12px]">
      <div className="absolute inset-y-0 right-0 rounded-sm" style={{ width: `${pct}%`, background: alpha(side === 'bid' ? 'up' : 'down', 0.2) }} />
      <span className={`relative ${side === 'bid' ? 'text-up' : 'text-down'}`}>{fmt(price)}</span>
      <span className="relative text-right text-muted">{orders}</span>
      <span className="relative w-16 text-right text-ink">{fmtInt(qty)}</span>
    </div>
  );
}
