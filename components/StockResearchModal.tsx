'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedMode, MarketEngine } from '@/lib/market';
import { generateHistory } from '@/lib/market';
import type { Fundamentals, Holding, Timeframe } from '@/lib/types';
import { useFullscreen } from '@/hooks/useFullscreen';
import { macd, pivotLevels, rsi14, shortTermOutlook, longTermOutlook, sma, type Outlook } from '@/lib/analytics';
import { getFundamentals, ratioTone, sectorTypicalPe, type Tone } from '@/lib/fundamentals';
import type { CopilotContext } from '@/lib/copilot';
import { fmt, fmtCr, fmtInt, fmtPct, fmtSigned, tone } from '@/lib/format';
import { AnalysisActions } from './AnalysisActions';
import { PriceChart } from './PriceChart';
import { AIStockCopilot } from './AIStockCopilot';
import { ExportReport } from './ExportReport';
import { Badge, Card, Meter, ZONE } from './ui';

interface Props {
  symbol: string;
  engine: MarketEngine;
  favorite: boolean;
  onToggleFavorite: () => void;
  /** for the AI analyst summary in the exported report */
  holdings?: Holding[];
  mode?: FeedMode;
  /** 🔍 Deep Research: this page is already the research view, so it hands the stock to Ask UpCircuit for a written deep-dive */
  onDeepResearch: () => void;
  /** 🔔 Set Price Alert */
  onSetAlert: () => void;
  activeAlerts: number;
  onOpenTerminal: () => void;
  onClose: () => void;
}

const DOT: Record<Tone, string> = { good: 'bg-up', ok: 'bg-warn', bad: 'bg-down', na: 'bg-muted/50' };

function Ratio({ label, value, sub, tone: t, hint }: { label: string; value: string; sub?: string; tone: Tone; hint: string }) {
  return (
    <div className="rounded border border-line bg-bg px-3 py-2" title={hint}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</span>
        <span className={`h-2 w-2 rounded-full ${DOT[t]}`} aria-label={t === 'na' ? 'no rating' : t} />
      </div>
      <div className="num mt-0.5 text-[17px] font-semibold text-ink">{value}</div>
      {sub && <div className="num text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

function OutlookCard({ title, horizon, o }: { title: string; horizon: string; o: Outlook | null }) {
  const badge = o ? (o.label === 'Bullish' ? 'up' : o.label === 'Bearish' ? 'down' : 'muted') : 'muted';
  return (
    <Card title={title} right={<span className="text-[10px] text-muted">{horizon}</span>}>
      {!o ? (
        <p className="text-[12px] text-muted">Not enough history.</p>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-3">
            <Badge tone={badge}>{o.label}</Badge>
            <span className="num text-[12px] text-muted">score {o.score > 0 ? '+' : ''}{o.score}</span>
          </div>
          <Meter value={o.score} min={-100} max={100} zones={[{ to: -33, color: ZONE.down }, { to: 33, color: ZONE.muted }, { to: 100, color: ZONE.up }]} />
          <ul className="mt-3 space-y-1.5">
            {o.signals.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="flex items-center gap-2 text-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.bias === 'bull' ? 'bg-up' : s.bias === 'bear' ? 'bg-down' : 'bg-muted/60'}`} aria-hidden />
                  {s.name}
                </span>
                <span className={`num text-right ${s.bias === 'bull' ? 'text-up' : s.bias === 'bear' ? 'text-down' : 'text-ink'}`}>{s.value}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** Stock research page: TradingView chart (10 timeframes), Screener-style ratios, technicals + outlook, AI copilot. */
export function StockResearchModal({ symbol, engine, favorite, onToggleFavorite, holdings, mode, onDeepResearch, onSetAlert, activeAlerts, onOpenTerminal, onClose }: Props) {
  const full = useFullscreen();
  const [tf, setTf] = useState<Timeframe>('1D');
  const dialog = useRef<HTMLDivElement>(null);

  const quote = engine.touch(symbol);

  // daily history: fixed shape per symbol; last close tracks the live LTP
  const base = useMemo(() => generateHistory(symbol, '1D', engine.touch(symbol)?.ltp ?? 100, Date.now()), [symbol, engine]);

  /* ── dialog behaviour: focus, Esc, focus trap, scroll lock ── */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus(); // the container, not a button: a lingering Enter keypress must not activate anything
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('[data-overlay]')) return; // a dialog on top (price alert) handles its own Esc
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab' && dialog.current) {
        const f = Array.from(dialog.current.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (f.length === 0) return;
        const first = f[0];
        const lastEl = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), lastEl.focus());
        else if (!e.shiftKey && document.activeElement === lastEl) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, []);

  const closes = useMemo(() => [...base.slice(0, -1).map((c) => c.close), quote?.ltp ?? base[base.length - 1].close], [base, quote?.ltp]);
  const prevBar = base[base.length - 2];
  const pivots = useMemo(() => pivotLevels(prevBar.high, prevBar.low, prevBar.close), [prevBar]);
  const rsi = rsi14(closes);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const mac = macd(closes);
  const short = shortTermOutlook(closes);
  const long = longTermOutlook(closes);
  const f: Fundamentals | null = quote ? getFundamentals(quote) : null;

  // always hand the copilot the freshest numbers
  const latest = useRef<() => CopilotContext>(() => null as never);
  latest.current = () => ({
    symbol,
    name: quote?.name ?? symbol,
    sector: quote?.sector ?? 'Others',
    price: { ltp: quote?.ltp ?? 0, changePct: quote ? (quote.ltp / quote.prevClose - 1) * 100 : 0, dayHigh: quote?.high ?? 0, dayLow: quote?.low ?? 0, volume: quote?.volume ?? 0, circuitBandPct: quote?.circuitBand ?? 0 },
    ratios: f!,
    technicals: { rsi, sma50, sma200, pivots, short: short && { label: short.label, score: short.score }, long: long && { label: long.label, score: long.score } },
    simulated: true,
  });
  const getContext = useCallback(() => latest.current(), []);

  if (!quote || !f) return null;
  const chg = quote.ltp - quote.prevClose;
  const pct = (chg / quote.prevClose) * 100;
  const typicalPe = sectorTypicalPe(quote.sector);

  const ladder = [
    { k: 'R2', v: pivots.r2, c: 'text-down' },
    { k: 'R1', v: pivots.r1, c: 'text-down' },
    { k: 'Pivot', v: pivots.p, c: 'text-ink' },
    { k: 'S1', v: pivots.s1, c: 'text-up' },
    { k: 'S2', v: pivots.s2, c: 'text-up' },
    { k: 'LTP', v: quote.ltp, c: 'text-accent' },
  ].sort((a, b) => b.v - a.v);

  return (
    <div className={`fixed inset-0 bg-black/60 ${full.fs ? 'z-[66]' : 'z-[55] md:p-4'}`} onMouseDown={full.fs ? undefined : onClose}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={`${symbol} research`} data-fullscreen={full.fs} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} className={`mx-auto flex h-full flex-col overflow-hidden border-line bg-bg shadow-2xl outline-none ${full.fs ? 'fs w-full' : 'max-w-[1440px] md:rounded-lg md:border'}`}>
        {/* header */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-3">
          <button onClick={onToggleFavorite} aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'} className={`text-xl leading-none ${favorite ? 'text-warn' : 'text-muted hover:text-ink'}`}>
            {favorite ? '★' : '☆'}
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[18px] font-bold text-ink">{symbol}</h2>
              <Badge>{quote.exch ?? 'NSE'} · EQ</Badge>
              <Badge tone="accent">{quote.sector}</Badge>
              <Badge tone="warn" className="hidden sm:inline-flex">Simulated data</Badge>
            </div>
            <div className="truncate text-[12px] text-muted">{quote.name}</div>
          </div>
          <div className="num flex items-baseline gap-2">
            <span className={`text-3xl font-semibold ${tone(chg)}`}>{fmt(quote.ltp)}</span>
            <span className={`text-[14px] ${tone(chg)}`}>{fmtSigned(chg)} ({fmtPct(pct)})</span>
          </div>
          <div className="num hidden gap-4 text-[11px] text-muted xl:flex">
            <span>H <b className="text-ink">{fmt(quote.high)}</b></span>
            <span>L <b className="text-ink">{fmt(quote.low)}</b></span>
            <span>Vol <b className="text-ink">{fmtInt(quote.volume)}</b></span>
            <span title="Price band: trading halts at these prices">Circuit ±{quote.circuitBand}% <b className="text-ink">{fmt(quote.lowerCircuit)}–{fmt(quote.upperCircuit)}</b></span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <AnalysisActions symbol={symbol} watchlisted={favorite} activeAlerts={activeAlerts} onDeepResearch={onDeepResearch} onToggleWatchlist={onToggleFavorite} onSetAlert={onSetAlert} variant="icons" className="md:hidden" />
            <AnalysisActions symbol={symbol} watchlisted={favorite} activeAlerts={activeAlerts} onDeepResearch={onDeepResearch} onToggleWatchlist={onToggleFavorite} onSetAlert={onSetAlert} deepLabel="Deep Research" variant="full" className="hidden md:flex" />
            <ExportReport symbol={symbol} engine={engine} holdings={holdings} mode={mode} compact className="lg:hidden" />
            <ExportReport symbol={symbol} engine={engine} holdings={holdings} mode={mode} className="hidden lg:block" />
            <button onClick={full.toggle} aria-pressed={full.fs} data-testid="research-fullscreen" title={full.fs ? 'Exit full screen (Esc)' : 'Expand to a borderless full-window view'} className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded border border-line px-2.5 text-[12px] font-semibold text-ink hover:bg-line">
              <span aria-hidden>🖥️</span>
              <span className="hidden lg:inline">{full.fs ? 'Exit Full Screen' : 'Full Screen Dashboard'}</span>
              <span className="sr-only lg:hidden">{full.fs ? 'Exit full screen' : 'Full screen'}</span>
            </button>
            {!full.fs && <button onClick={onOpenTerminal} className="hidden rounded border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-line xl:block">Open in terminal</button>}
            <button onClick={onClose} aria-label="Close research (Esc)" className="flex h-8 w-8 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
          <div className="grid gap-4 p-4 lg:h-full lg:grid-cols-[minmax(0,1fr)_380px] [.fs_&]:xl:grid-cols-[minmax(0,1fr)_460px]">
            <div className="min-w-0 space-y-4 lg:h-full lg:overflow-y-auto lg:pr-1">
              <div className="overflow-hidden rounded-md border border-line">
                <PriceChart symbol={symbol} ltp={quote.ltp} volume={quote.volume} tf={tf} onTf={setTf} className={full.fs ? 'h-[min(62vh,720px)] min-h-[400px]' : 'h-[400px]'} />
              </div>

              <Card title="Key ratios" right={<span className="text-[10px] text-muted">Screener-style · simulated</span>}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 [.fs_&]:min-[1500px]:grid-cols-8">
                  <Ratio label="Market Cap" value={fmtCr(f.marketCapCr)} tone="na" hint="Share price × shares outstanding" />
                  <Ratio label="Stock P/E" value={f.pe.toFixed(1)} sub={`sector ≈ ${typicalPe}`} tone={ratioTone('pe', f, quote.sector)} hint="Price ÷ earnings per share. Compared with the sector's typical multiple." />
                  <Ratio label="Book Value" value={'₹' + fmt(f.bookValue)} sub={`P/B ${(quote.ltp / f.bookValue).toFixed(2)}`} tone="na" hint="Net worth per share" />
                  <Ratio label="Dividend Yield" value={f.dividendYield.toFixed(2) + '%'} tone={ratioTone('dividendYield', f, quote.sector)} hint="Annual dividend ÷ share price" />
                  <Ratio label="ROCE" value={f.roce.toFixed(1) + '%'} tone={ratioTone('roce', f, quote.sector)} hint="EBIT ÷ capital employed — how well all capital is used. 15%+ is considered good." />
                  <Ratio label="ROE" value={f.roe.toFixed(1) + '%'} tone={ratioTone('roe', f, quote.sector)} hint="Net profit ÷ shareholders' equity. 15%+ is considered good." />
                  <Ratio label="Debt to equity" value={f.debtToEquity === null ? '—' : f.debtToEquity.toFixed(2)} sub={f.debtToEquity === null ? 'n/a for lenders' : undefined} tone={ratioTone('debtToEquity', f, quote.sector)} hint="Total borrowings ÷ equity. Not meaningful for banks and lenders." />
                  <Ratio label="Promoter holding" value={f.promoterHolding.toFixed(1) + '%'} tone={ratioTone('promoterHolding', f, quote.sector)} hint="Share of the company held by its promoters" />
                </div>
              </Card>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                <Card title="Support & resistance" right={<span className="text-[10px] text-muted">prior session H/L/C</span>}>
                  <ul className="num divide-y divide-line text-[12px]">
                    {ladder.map((r) => (
                      <li key={r.k} className={`flex items-center justify-between py-1.5 ${r.k === 'LTP' ? 'rounded bg-accent/10 px-2 font-semibold' : ''}`}>
                        <span className={`w-12 font-semibold ${r.c}`}>{r.k}</span>
                        <span className="text-ink">₹{fmt(r.v)}</span>
                        <span className={`w-16 text-right ${r.k === 'LTP' ? 'text-muted' : tone(r.v - quote.ltp)}`}>{r.k === 'LTP' ? 'now' : fmtPct((r.v / quote.ltp - 1) * 100, 1)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="num mt-3 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line pt-2 text-[11px] text-muted">
                    <span>RSI(14) <b className="text-ink">{rsi === null ? '—' : rsi.toFixed(1)}</b></span>
                    <span>MACD hist <b className={mac ? tone(mac.hist) : ''}>{mac ? mac.hist.toFixed(2) : '—'}</b></span>
                    <span>50-DMA <b className="text-ink">{sma50 ? fmt(sma50) : '—'}</b></span>
                    <span>200-DMA <b className="text-ink">{sma200 ? fmt(sma200) : '—'}</b></span>
                  </div>
                </Card>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                  <OutlookCard title="Short-term outlook" horizon="1–4 weeks" o={short} />
                  <OutlookCard title="Long-term outlook" horizon="6–12 months" o={long} />
                </div>
              </div>
              <p className="pb-2 text-[10px] text-muted">Prices, ratios and indicators here are computed from simulated data for demonstration. Educational only; not investment advice.</p>
            </div>

            <div className="h-[560px] min-h-0 lg:h-full">
              <AIStockCopilot key={symbol} symbol={symbol} name={quote.name} getContext={getContext} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
