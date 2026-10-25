'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedMode, MarketEngine } from '@/lib/market';
import type { Fundamentals, Holding, NewsResponse, Timeframe } from '@/lib/types';
import { sentimentChipText, stockNews, summarizeSentiment } from '@/lib/newsEngine';
import { useFullscreen } from '@/hooks/useFullscreen';
import { macd, pivotLevels, rsi14, shortTermOutlook, longTermOutlook, sma, type Outlook } from '@/lib/analytics';
import { fundamentalsOf, orNA, ratioTone, type Tone } from '@/lib/fundamentals';
import { getScreener } from '@/lib/screener';
import { mergeLive } from '@/lib/yahooFundamentals';
import { useFundamentals } from '@/hooks/useFundamentals';
import { buildCopilotContext, type CopilotContext } from '@/lib/copilot';
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
  /** live RSS headlines (for the stock-specific sentiment chip) */
  news?: NewsResponse | null;
  /** 🔍 Deep Research: this page is already the research view, so it hands the stock to Ask UpCircuit for a written deep-dive */
  onDeepResearch: () => void;
  /** 🔔 Set Price Alert */
  onSetAlert: () => void;
  activeAlerts: number;
  onOpenTerminal: () => void;
  onClose: () => void;
}

const INS_TONE = { up: 'border-up/40 bg-up/10 text-up', down: 'border-down/40 bg-down/10 text-down', warn: 'border-warn/40 bg-warn/10 text-warn', muted: 'border-line bg-panel text-muted' };
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

/** ✨ Ask UpCircuit — gradient toggle for the stock Copilot drawer (top bar + floating corner in full-screen mode) */
function AskButton({ open, onClick, className = '', floating, testid }: { open: boolean; onClick: () => void; className?: string; floating?: boolean; testid: string }) {
  return (
    <button onClick={onClick} data-testid={testid} aria-expanded={open} aria-label="Ask UpCircuit" title="Ask UpCircuit about this stock" className={`flex items-center gap-1.5 whitespace-nowrap rounded-md bg-gradient-to-r from-accent to-[#7B61FF] px-3 text-[12px] font-bold text-white shadow-lg shadow-accent/30 ring-1 ring-white/10 transition hover:brightness-110 active:scale-95 ${floating ? 'fixed bottom-5 right-5 z-[60] h-10 rounded-full px-4' : 'h-8'} ${className}`}>
      <span aria-hidden>✨</span>Ask UpCircuit
    </button>
  );
}

/** AI insights strip: a one-line valuation / momentum / trend read computed from the same real numbers shown below (no model call, N/A-safe). */
function insightsOf(f: Fundamentals, rsi: number | null, short: Outlook | null, long: Outlook | null, pb: number | null): { text: string; tone: 'up' | 'down' | 'warn' | 'muted' } {
  const parts: string[] = [];
  if (f.pe !== null) parts.push(`P/E ${f.pe.toFixed(1)}× (${f.pe < 15 ? 'low' : f.pe <= 30 ? 'fair' : 'rich'})`);
  if (pb !== null) parts.push(`P/B ${pb.toFixed(2)}×`);
  if (f.roce !== null) parts.push(`ROCE ${f.roce.toFixed(1)}% (${f.roce >= 15 ? 'strong' : 'moderate'})`);
  if (f.debtToEquity !== null) parts.push(`D/E ${f.debtToEquity.toFixed(2)}`);
  if (rsi !== null) parts.push(`RSI ${rsi.toFixed(0)} (${rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral'})`);
  if (short) parts.push(`short-term ${short.label.toLowerCase()}`);
  if (long) parts.push(`long-term ${long.label.toLowerCase()}`);
  const score = (short?.score ?? 0) + (long?.score ?? 0);
  return { text: parts.join(' · ') || 'Not enough data yet', tone: !short && !long ? 'muted' : score > 20 ? 'up' : score < -20 ? 'down' : 'warn' };
}

/** Stock research page: TradingView chart (10 timeframes), Screener-style ratios, technicals + outlook, AI copilot. */
export function StockResearchModal({ symbol, engine, favorite, onToggleFavorite, holdings, mode, news, onDeepResearch, onSetAlert, activeAlerts, onOpenTerminal, onClose }: Props) {
  const full = useFullscreen();
  const [tf, setTf] = useState<Timeframe>('1D');
  const dialog = useRef<HTMLDivElement>(null);
  const [askOpen, setAskOpen] = useState(false);
  // the Copilot column is collapsed in full-screen mode: it lives in the slide-out drawer instead (and entering / leaving full screen resets it)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setAskOpen(false), [full.fs]);

  const quote = engine.touch(symbol);

  // REAL daily bars (Yahoo, ≈1 year); the last close tracks the live LTP
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => engine.historyOf(symbol, '1Y'), [symbol, engine, engine.histVer]);

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

  useEffect(() => {
    if (!askOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setAskOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [askOpen]);

  const closes = useMemo(() => (base.length ? [...base.slice(0, -1).map((c) => c.close), quote?.ltp ?? base[base.length - 1].close] : []), [base, quote?.ltp]);
  const prevBar = base[base.length - 2];
  // pivots need the previous real session's H/L/C — until Yahoo delivers it they are zeros shown as '—'
  const pivots = useMemo(() => (prevBar ? pivotLevels(prevBar.high, prevBar.low, prevBar.close) : { p: 0, r1: 0, r2: 0, s1: 0, s2: 0 }), [prevBar]);
  const rsi = rsi14(closes);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const mac = macd(closes);
  const short = shortTermOutlook(closes);
  const long = longTermOutlook(closes);
  const liveF = useFundamentals(symbol, quote?.exch ?? 'NSE');
  const f: Fundamentals | null = quote ? fundamentalsOf(mergeLive(getScreener(quote), liveF.data, quote.ltp)) : null;

  // always hand the copilot the freshest numbers
  const latest = useRef<() => CopilotContext>(() => null as never);
  latest.current = () =>
    buildCopilotContext({
      symbol, name: quote?.name, sector: quote?.sector, ltp: quote?.ltp, prevClose: quote?.prevClose, high: quote?.high, low: quote?.low, volume: quote?.volume, circuitBand: quote?.circuitBand,
      ratios: f, // null ratios stay null → N/A (never blocks the request)
      technicals: { rsi, sma50, sma200, pivots, short: short && { label: short.label, score: short.score }, long: long && { label: long.label, score: long.score } },
      simulated: true,
    });
  const getContext = useCallback(() => latest.current(), []);

  if (!quote || !f) return null;
  const sNews = stockNews(news?.items ?? [], symbol, quote.name, 8);
  const sSum = summarizeSentiment(sNews);
  const ins = insightsOf(f, rsi, short, long, f.bookValue ? quote.ltp / f.bookValue : null);
  const chg = quote.ltp - quote.prevClose;
  const pct = (chg / quote.prevClose) * 100;

  const ladder = [
    { k: 'R2', v: pivots.r2, c: 'text-down' },
    { k: 'R1', v: pivots.r1, c: 'text-down' },
    { k: 'Pivot', v: pivots.p, c: 'text-ink' },
    { k: 'S1', v: pivots.s1, c: 'text-up' },
    { k: 'S2', v: pivots.s2, c: 'text-up' },
    { k: 'LTP', v: quote.ltp, c: 'text-accent' },
  ].filter((x) => x.v > 0).sort((a, b) => b.v - a.v);

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
              <Badge tone="warn" className="hidden sm:inline-flex">Session data</Badge>
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
            <AskButton open={askOpen} onClick={() => setAskOpen((o) => !o)} className={full.fs ? '' : 'hidden'} testid="fs-ask-top" />
            <button onClick={full.toggle} aria-pressed={full.fs} data-testid="research-fullscreen" title={full.fs ? 'Exit full screen (Esc)' : 'Expand to a borderless full-window view'} className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded border border-line px-2.5 text-[12px] font-semibold text-ink hover:bg-line">
              <span aria-hidden>🖥️</span>
              <span className="hidden lg:inline">{full.fs ? 'Exit Full Screen' : 'Full Screen Dashboard'}</span>
              <span className="sr-only lg:hidden">{full.fs ? 'Exit full screen' : 'Full screen'}</span>
            </button>
            {!full.fs && <button onClick={onOpenTerminal} className="hidden rounded border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-line xl:block">Open in terminal</button>}
            <button onClick={onClose} aria-label="Close research (Esc)" className="flex h-8 w-8 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
          </div>
        </div>

        {full.fs && !askOpen && <AskButton open={false} onClick={() => setAskOpen(true)} floating testid="fs-ask-float" />}

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
          <div className={`grid gap-4 p-4 lg:h-full ${full.fs ? 'grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_380px]'}`}>
            <div className="min-w-0 space-y-4 lg:h-full lg:overflow-y-auto lg:pr-1">
              <div data-testid="ai-insights-strip" className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-[12px] ${INS_TONE[ins.tone]}`}>
                <span className="font-bold">✨ AI insights</span>
                <span className="num text-ink">{ins.text}</span>
                <span data-testid="news-sentiment-chip" data-dominant={sSum.dominant ?? 'none'} title={sNews.length ? sNews.map((n) => `${n.label}: ${n.title}`).join('\n') : 'No headlines in the live feeds mention this stock right now'} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${sSum.dominant === 'Bullish' ? 'border-up/40 bg-up/10 text-up' : sSum.dominant === 'Bearish' ? 'border-down/40 bg-down/10 text-down' : 'border-line bg-bg text-muted'}`}>📰 News Sentiment: {sentimentChipText(sSum)}</span>
                <button onClick={() => (full.fs ? setAskOpen(true) : undefined)} className={`ml-auto text-[11px] font-semibold text-accent hover:underline ${full.fs ? '' : 'hidden'}`}>Ask more →</button>
              </div>
              <div className="overflow-hidden rounded-md border border-line">
                <PriceChart symbol={symbol} ltp={quote.ltp} volume={quote.volume} tf={tf} onTf={setTf} live={engine.mode === 'live'} subscribeTicks={engine.onTick} className={full.fs ? 'h-[min(62vh,720px)] min-h-[400px]' : 'h-[400px]'} />
              </div>

              <Card title="Key ratios" right={<span className="text-[10px] text-muted">Verified provider data · N/A when unavailable</span>}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 [.fs_&]:min-[1500px]:grid-cols-8">
                  <Ratio label="Market Cap" value={orNA(f.marketCapCr, fmtCr)} tone="na" hint="Share price × shares outstanding" />
                  <Ratio label="Stock P/E" value={orNA(f.pe, (n) => n.toFixed(1))} sub="sector P/E N/A" tone={ratioTone('pe', f)} hint="Price ÷ earnings per share." />
                  <Ratio label="Book Value" value={orNA(f.bookValue, (n) => '₹' + fmt(n))} sub={f.bookValue ? `P/B ${(quote.ltp / f.bookValue).toFixed(2)}` : undefined} tone="na" hint="Net worth per share" />
                  <Ratio label="Dividend Yield" value={orNA(f.dividendYield, (n) => n.toFixed(2) + '%')} tone={ratioTone('dividendYield', f)} hint="Annual dividend ÷ share price" />
                  <Ratio label="ROCE" value={orNA(f.roce, (n) => n.toFixed(1) + '%')} tone={ratioTone('roce', f)} hint="EBIT ÷ capital employed — how well all capital is used. 15%+ is considered good." />
                  <Ratio label="ROE" value={orNA(f.roe, (n) => n.toFixed(1) + '%')} tone={ratioTone('roe', f)} hint="Net profit ÷ shareholders' equity. 15%+ is considered good." />
                  <Ratio label="Debt to equity" value={orNA(f.debtToEquity, (n) => n.toFixed(2))} tone={ratioTone('debtToEquity', f)} hint="Total borrowings ÷ equity. Not meaningful for banks and lenders." />
                  <Ratio label="Promoter holding" value={orNA(f.promoterHolding, (n) => n.toFixed(1) + '%')} tone={ratioTone('promoterHolding', f)} hint="Share of the company held by its promoters" />
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
              <p className="pb-2 text-[10px] text-muted">Prices, ratios and indicators here use real NSE session prices; ratios not available show N/A. Educational only; not investment advice.</p>
            </div>

            {full.fs && askOpen && <div className="fixed inset-0 z-[67] bg-black/30" onMouseDown={() => setAskOpen(false)} data-testid="fs-ask-backdrop" aria-hidden />}
            <div
              data-testid={full.fs ? 'fs-ask-drawer' : 'research-copilot'}
              data-open={full.fs ? askOpen : true}
              {...(full.fs && askOpen ? { 'data-overlay': '' } : {})}
              aria-hidden={full.fs && !askOpen}
              className={full.fs ? `fixed bottom-0 right-0 top-0 z-[68] w-full max-w-[440px] p-2 backdrop-blur-md [&>section]:bg-panel/90 transition-[transform,visibility] duration-200 ${askOpen ? 'visible translate-x-0' : 'invisible translate-x-full'}` : 'h-[560px] min-h-0 lg:h-full'}
            >
              <AIStockCopilot key={symbol} symbol={symbol} name={quote.name} getContext={getContext} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
