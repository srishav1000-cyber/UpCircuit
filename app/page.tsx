'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AskButton, FeedBadge, Navbar, type View } from '@/components/Navbar';
import { AnalysisActions } from '@/components/AnalysisActions';
import { AskUpCircuitDrawer, type AskRequest } from '@/components/AskUpCircuitDrawer';
import { PortfolioUploadModal } from '@/components/PortfolioUploadModal';
import { PriceAlertDialog } from '@/components/PriceAlertDialog';
import { CircuitBanner } from '@/components/CircuitBanner';
import { CircuitAlerts } from '@/components/CircuitAlerts';
import { CircuitAlertOverlay } from '@/components/CircuitAlertOverlay';
import { useCircuitAlerts } from '@/hooks/useCircuitAlerts';
import { useDemoSimulator } from '@/hooks/useDemoSimulator';
import { useAudioAlerts } from '@/hooks/useAudioAlerts';
import { appUrl } from '@/lib/appUrl';
import { CircuitLogDrawer } from '@/components/CircuitLogDrawer';
import { nearLimit } from '@/lib/circuitTracker';
import { sendCircuitEmail } from '@/lib/alertEmail';
import { sendCircuitPush } from '@/lib/alertPush';
import { currentPushEndpoint } from '@/lib/pushNotifications';
import { getNotify } from '@/lib/notifyStore';
import { useCloud } from '@/hooks/useCloud';
import { useNotifySync } from '@/hooks/useNotify';
import { mergeHolding } from '@/lib/holdingsStore';
import { HomePage } from '@/components/HomePage';
import { ChartWorkspace } from '@/components/ChartWorkspace';
import { StockResearchModal } from '@/components/StockResearchModal';
import { SystemTelemetryModal } from '@/components/SystemTelemetryModal';
import { Week7MilestoneModal } from '@/components/Week7MilestoneModal';
import { DayTraderDashboard } from '@/components/dashboards/DayTrader';
import { RetailDashboard } from '@/components/dashboards/Retail';
import { InstitutionalDashboard } from '@/components/dashboards/Institutional';
import { ExecutiveDashboard } from '@/components/dashboards/Executive';
import { useMarket } from '@/hooks/useMarket';
import { useInstruments } from '@/hooks/useInstruments';
import { useWatchlist } from '@/hooks/useWatchlist';
import { MethodologyDrawer } from '@/components/MethodologyDrawer';
import { RebalanceModal } from '@/components/RebalanceModal';
import { WatchlistSelectorModal } from '@/components/WatchlistSelectorModal';
import { WatchlistDrawer } from '@/components/WatchlistDrawer';
import { StockOverview } from '@/components/StockOverview';
import { useHoldings } from '@/hooks/useHoldings';
import { useFocus } from '@/hooks/useFocus';
import { MyFocusBasket } from '@/components/MyFocusBasket';
import { FocusDeepDive } from '@/components/FocusDeepDive';
import { WelcomeBanner } from '@/components/WelcomeBanner';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { AuthScreen } from '@/components/AuthScreen';
import { TerminalSkeleton } from '@/components/TerminalSkeleton';
import { PlansModal } from '@/components/PlansModal';
import { allowedRoles, canUse, coerceRole, type Role } from '@/lib/auth';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useNews } from '@/hooks/useNews';
import { useFullscreen } from '@/hooks/useFullscreen';
import { usePriceAlerts } from '@/hooks/usePriceAlerts';
import { buildAskContext } from '@/lib/ask';
import { fmt } from '@/lib/format';
import { personaOf, type Persona } from '@/lib/personas';
import type { Holding, Quote, Timeframe } from '@/lib/types';
import type { DataState } from '@/hooks/useMarket';

/** Demo portfolio: quantities only. Cost basis is filled from each stock's REAL previous close once Yahoo has delivered it (avg 0 = "not priced yet"). */
const DEMO_HOLDINGS: Holding[] = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ITC', 'SBIN'].map((symbol, i) => ({ symbol, qty: [25, 10, 40, 30, 100, 60][i], avg: 0 }));

/** Never rendered: only keeps hooks below safe for the one render before the first real quote arrives (the data gate covers the screen). */
const EMPTY_QUOTE = (symbol: string): Quote => ({ symbol, name: symbol, sector: 'Others', ltp: 0, prevClose: 1, open: 0, high: 0, low: 0, volume: 0, sumPV: 0, sumV: 0, mcapCr: 0, dividendYield: 0, avgVolume: 0, circuitBand: 20, upperCircuit: 0, lowerCircuit: 0 });

function MarketGate({ state, onRetry }: { state: DataState; onRetry: () => void }) {
  // always-dark skeleton (components/TerminalSkeleton.tsx) so the post-login handoff never flashes white, whatever the saved theme
  return (
    <div data-testid="market-gate">
      {state === 'error' ? (
        <TerminalSkeleton message="Market data is temporarily unavailable">
          <p className="max-w-sm">UpCircuit shows only real market data and never fills gaps with simulated prices. Check your connection and try again.</p>
          <button onClick={onRetry} data-testid="market-retry" className="rounded-md border border-blue-500 px-3 py-1.5 font-semibold text-blue-400 hover:bg-blue-500/10">Retry</button>
        </TerminalSkeleton>
      ) : (
        <TerminalSkeleton message="Connecting to SmartAPI Live Market Stream..." />
      )}
    </div>
  );
}

/** /terminal?symbol=XYZ (e-mail deep link) opens the Terminal view on that stock; plain / opens the Discovery Hub. Client-only (Terminal mounts after hydration). */
function initialNav(): { view: View; symbol: string } {
  const sym = new URLSearchParams(window.location.search).get('symbol')?.toUpperCase();
  return { view: window.location.pathname.startsWith('/terminal') ? 'terminal' : 'home', symbol: sym && /^[A-Z0-9&._-]{1,24}$/.test(sym) ? sym : 'RELIANCE' };
}

function Terminal() {
  const instruments = useInstruments();
  const knownSymbols = useMemo(() => new Set(instruments.map((i) => i.symbol)), [instruments]);
  const bseOnly = useMemo(() => instruments.reduce((n, i) => n + (i.exch === 'BSE' ? 1 : 0), 0), [instruments]);
  const { list: favs, all: allWatched, lists: wlists, activeId: wActive, activeName: wName, select: selectWatch, toggle: toggleFav, add: addWatch, remove: removeWatch, create: createWatch, rename: renameWatch, del: deleteWatch, setIn: setWatchIn, createWith: createWatchWith, inAny: inAnyList } = useWatchlist();
  const [watchOpen, setWatchOpen] = useState(false);
  /** symbol whose "Add to Watchlist" selector (checkbox per list) is open */
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [rebalanceOpen, setRebalanceOpen] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);
  const [teleOpen, setTeleOpen] = useState(false);
  const [week7Open, setWeek7Open] = useState(false);
  const { holdings: rawHoldings, setHoldings, resetHoldings } = useHoldings(DEMO_HOLDINGS);
  const { focus, toggle: toggleFocus, welcome, dismissWelcome } = useFocus();
  const { user, update: updateAccount, getToken } = useAuth();
  const [plansFor, setPlansFor] = useState<Role | 'any' | null>(null);
  const { news, error: newsError } = useNews();
  const priceAlerts = usePriceAlerts();
  const dashFs = useFullscreen();

  // the app opens on the Angel One-style Discovery Hub; persona lenses are chosen from the Navbar dropdown
  const initial = useMemo(() => initialNav(), []);
  const [view, setView] = useState<View>(initial.view);
  const [persona, setPersonaRaw] = useState<Persona>(() => coerceRole(user?.plan, user?.role));
  /** plan gate: a locked role opens the plans dialog instead of switching; allowed switches are saved as the primary role */
  const setPersona = useCallback(
    (x: Persona) => {
      if (!canUse(user?.plan, x)) return setPlansFor(x);
      setPersonaRaw(x);
      if (user && x !== user.role) void updateAccount({ role: x });
    },
    [user, updateAccount],
  );
  const [symbol, setSymbol] = useState(initial.symbol);
  /** when set, the terminal charts this index (engine id) instead of `symbol` */
  /** right-hand panel of the terminal: the inspected stock's fundamentals, or the persona dashboard */
  const [panel, setPanel] = useState<'overview' | 'dashboard'>('overview');
  const [chartIndex, setChartIndex] = useState<string | null>(null);
  const [research, setResearch] = useState<string | null>(null);
  const [tf, setTf] = useState<Timeframe>('5m');
  const [toast, setToast] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askReq, setAskReq] = useState<AskRequest | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [alertFor, setAlertFor] = useState<string | null>(null);
  const askSeq = useRef(1);
  const searchRef = useRef<HTMLInputElement>(null);

  const alertSymbols = useMemo(() => priceAlerts.alerts.filter((a) => !a.triggeredAt).map((a) => a.symbol), [priceAlerts.alerts]);
  const focusCandidates = useMemo(() => [...new Set([...allWatched, ...rawHoldings.map((h) => h.symbol)])], [allWatched, rawHoldings]);
  const watch = useMemo(() => [...allWatched, ...rawHoldings.map((h) => h.symbol), ...alertSymbols], [allWatched, rawHoldings, alertSymbols]);
  const { engine, version, mode, conn, liveReason, state: dataState, retry: retryData } = useMarket(instruments, symbol, watch, focus);

  useNotifySync();
  const { cloud, userId: cloudUser } = useCloud();
  const audio = useAudioAlerts();
  // startup screen (Settings → Market & Layout): once per page load, only when the URL did not already pick a view / symbol
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !user) return;
    landed.current = true;
    if (getNotify().landing === 'terminal' && !window.location.pathname.startsWith('/terminal') && !new URLSearchParams(window.location.search).get('symbol')) setView('terminal');
  }, [user]);
  const [logOpen, setLogOpen] = useState(false);
  const circuitSymbols = useMemo(() => [...new Set([...favs, ...focus])], [favs, focus]);
  const demo = useDemoSimulator(engine, circuitSymbols);
  const watchedForCircuits = useMemo(() => [...new Set([...circuitSymbols, ...demo.symbols])], [circuitSymbols, demo.symbols]);
  const circuit = useCircuitAlerts(engine, version, watchedForCircuits, (hit) => {
    // every real hit is logged to the account's alert_history; e-mail / push follow the Settings toggles (Supabase accounts only)
    if (cloud && cloudUser) void cloud.logAlert(cloudUser, { symbol: hit.symbol, direction: hit.dir === 'upper' ? 'UPPER' : 'LOWER', band: hit.band, price: hit.ltp }).catch(() => undefined);
    const n = getNotify();
    void getToken().then(async (t) => {
      if (n.email) void sendCircuitEmail(hit, t);
      if (n.push) void sendCircuitPush(hit, t, await currentPushEndpoint());
    });
  }, demo.active, cloud && cloudUser ? () => cloud.recentAlerts(cloudUser, 200) : undefined);

  useEffect(() => { if (logOpen) void circuit.refreshHistory(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logOpen]);

  const quote = engine.touch(symbol) ?? engine.quotes.get('RELIANCE') ?? engine.quotes.values().next().value ?? EMPTY_QUOTE(symbol);
  /** portfolio with real cost bases: a demo holding (avg 0) is costed at the stock's real previous close; unpriced ones wait for Yahoo */
  const holdings = useMemo(
    () => rawHoldings.map((h) => (h.avg > 0 ? h : { ...h, avg: engine.quotes.get(h.symbol)?.prevClose ?? 0 })).filter((h) => h.avg > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawHoldings, engine, engine.lastQuotesAt],
  );

  // real daily closes (Yahoo) for RSI / Sharpe — the last bar tracks the live LTP
  const closes1D = useMemo(() => {
    const c = engine.closes(symbol);
    return c.length ? [...c.slice(0, -1), quote.ltp] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, engine, engine.histVer, quote.ltp]);

  const flash = useCallback((msg: string, ms = 3200) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), ms);
  }, []);

  const openStock = useCallback((s: string) => {
    setSymbol(s);
    setChartIndex(null);
    setPanel('overview');
    setResearch(s);
  }, []);

  /** open a stock's chart in the terminal (budget cards, index ticker) */
  const openChart = useCallback((s: string) => {
    setSymbol(s);
    setChartIndex(null);
    setPanel('overview');
    setResearch(null);
    setView('terminal');
  }, []);
  const openIndex = useCallback((id: string) => {
    setChartIndex(id);
    setPanel('dashboard');
    setView('terminal');
  }, []);

  const openAsk = useCallback((prompt?: string) => {
    setAskOpen(true);
    if (prompt) setAskReq({ id: askSeq.current++, text: prompt });
  }, []);

  /** 🔍 Deep Research: from anywhere → the research page; from the research page itself → a written deep-dive in Ask UpCircuit */
  const deepResearch = useCallback(() => {
    if (research !== symbol) return openStock(symbol);
    const q = engine.touch(symbol);
    openAsk(`Deep research on ${symbol}${q ? ` (${q.name})` : ''}: valuation vs its sector, quality (ROE / ROCE), debt, dividends, technical levels and trend, news sentiment, and the key risks. Be balanced and use the numbers on screen.`);
  }, [research, symbol, openStock, openAsk, engine]);

  /** ⭐ / "Add to Watchlist" / "In Watchlist": open the list selector for the current stock */
  const toggleWatchlist = useCallback(() => setPickFor(symbol), [symbol]);

  const setAlert = useCallback(() => setAlertFor(symbol), [symbol]);

  const importPortfolio = useCallback(
    (h: Holding[]) => {
      setHoldings(h);
      flash(`Portfolio replaced with ${h.length} holding${h.length === 1 ? '' : 's'}`);
      if (canUse(user?.plan, 'retail')) setPersonaRaw('retail');
      setView('terminal');
      setImportOpen(false);
    },
    [setHoldings, flash, user?.plan],
  );

  const holdingsRef = useRef(rawHoldings);
  holdingsRef.current = rawHoldings;
  const addHolding = useCallback(
    (h: Holding): string | null => {
      setHoldings(mergeHolding(holdingsRef.current, h));
      flash(`Added ${h.qty} × ${h.symbol} to your portfolio`);
      return null;
    },
    [setHoldings, flash],
  );

  const act = useCallback(
    (key: string) => {
      switch (key) {
        case 'r': return deepResearch();
        case 'w': return setWatchOpen((o) => !o);
        case 'f': return toggleWatchlist();
        case 'a': return setAlert();
        case '1': return setTf('1m');
        case '2': return setTf('5m');
        case '3': return setTf('1D');
        case '/': return searchRef.current?.focus();
        case 'Escape': return setAlertFor(null);
      }
    },
    [deepResearch, toggleWatchlist, setAlert],
  );

  useHotkeys(
    { r: () => act('r'), w: () => act('w'), f: () => act('f'), a: () => act('a'), '1': () => act('1'), '2': () => act('2'), '3': () => act('3'), '/': () => act('/'), Escape: () => act('Escape') },
    !askOpen && !importOpen && !watchOpen && alertFor === null,
  );

  useEffect(() => {
    if (engine.ready) document.title = `${quote.ltp.toFixed(2)} ${quote.symbol} · UpCircuit`;
  }, [quote.ltp, quote.symbol, engine.ready]);

  // price alerts are checked on every market render
  useEffect(() => {
    const fired = priceAlerts.evaluate((s) => engine.touch(s)?.ltp);
    fired.forEach((a) => flash(`🔔 ${a.symbol} ${a.dir === 'above' ? 'rose to' : 'fell to'} ₹${fmt(a.triggeredPrice ?? a.target)} — your alert at ₹${fmt(a.target)}`, 9000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // leaving the workspace view also leaves full screen
  const exitFs = dashFs.exit;
  /** mini chart → full interactive chart canvas: leave full-screen dashboard and show the stock's chart workspace */
  const expandChart = useCallback(() => {
    dashFs.exit();
    setChartIndex(null);
    setPanel('overview');
    setView('terminal');
  }, [dashFs]);
  useEffect(() => {
    if (view !== 'terminal') exitFs();
  }, [view, exitFs]);

  const getAskContext = useCallback(() => buildAskContext(engine, holdings, research ?? symbol, mode), [engine, holdings, research, symbol, mode]);

  const dash = {
    engine,
    quote,
    closes1D,
    holdings,
    favorites: allWatched,
    knownSymbols,
    mode,
    onSelect: setSymbol,
    onToggleFavorite: (s: string) => setPickFor(s),
    onOpenImport: () => setImportOpen(true),
    onOpenRebalance: () => setRebalanceOpen(true),
    onAskAI: openAsk,
    onResetPortfolio: resetHoldings,
    onAction: act,
  };
  // a plan change (upgrade / downgrade) can leave the active lens locked → fall back to an allowed one
  useEffect(() => {
    if (!canUse(user?.plan, persona)) setPersonaRaw(coerceRole(user?.plan, user?.role));
  }, [user?.plan, user?.role, persona]);
  const p = personaOf(persona);
  const showOverview = panel === 'overview' && !chartIndex && !dashFs.fs;
  const activeAlerts = alertSymbols.length;
  const actions = { symbol, watchlisted: inAnyList(symbol), activeAlerts, onDeepResearch: deepResearch, onToggleWatchlist: toggleWatchlist, onSetAlert: setAlert };
  const alertTarget = alertFor ? engine.touch(alertFor) : undefined;

  if (!engine.ready) return <MarketGate state={dataState} onRetry={retryData} />;

  return (
    <div className={`flex min-h-screen flex-col bg-bg ${view === 'terminal' ? 'lg:h-screen' : ''}`}>
      <div className="sticky top-0 z-50 shrink-0">
        <CircuitBanner alerts={engine.alerts} onSelect={openStock} />
        <Navbar
          view={view}
          onView={setView}
          persona={persona}
          onPlans={() => setPlansFor('any')}
          audioOn={audio.on}
          onToggleAudio={audio.toggle}
          circuitCount={circuit.log.length}
          onOpenCircuitLog={() => setLogOpen(true)}
          demo={{ active: demo.active, onToggle: demo.toggle, msg: demo.msg }}
          onPersona={(x) => {
            setPersona(x);
            setPanel('dashboard');
            setView('terminal');
          }}
          indices={engine.indices}
          instruments={instruments}
          onSelect={openStock}
          onOpenIndex={openIndex}
          liveReason={liveReason}
          onOpenWatchlist={() => setWatchOpen(true)}
          priceOf={(s) => engine.touch(s)?.ltp}
          {...actions}
          searchRef={searchRef}
          mode={mode}
          conn={conn}
          onOpenImport={() => setImportOpen(true)}
          onAsk={() => openAsk()}
        />
        <CircuitAlerts log={circuit.log} glow={circuit.glow} audio={audio} onOpen={openChart} onOpenLog={() => setLogOpen(true)} />
        <CircuitAlertOverlay log={circuit.log} audioOn={audio.on} />
        <CircuitLogDrawer open={logOpen} onClose={() => setLogOpen(false)} history={circuit.history} near={logOpen ? nearLimit(engine.quotes.values()) : []} nameOf={(s) => engine.master.get(s)?.name ?? engine.quotes.get(s)?.name ?? ''} onAnalyze={openStock} onClear={circuit.clearLog} synced={!!(cloud && cloudUser)} />
        {welcome && <WelcomeBanner onDismiss={dismissWelcome} />}
      </div>

      {view === 'home' ? (
        <main className="flex-1">
          <HomePage engine={engine} news={news} newsError={newsError} onOpenStock={openStock} instruments={instruments} onOpenChart={openChart} />
        </main>
      ) : (
        <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.45fr)_minmax(400px,1fr)]">
          <section className="min-h-[600px] min-w-0 border-r border-line lg:min-h-0">
            <ChartWorkspace
              subscribeTicks={engine.onTick}
              quote={quote}
              tf={tf}
              onTf={setTf}
              onResearch={deepResearch}
              favorite={inAnyList(symbol)}
              onToggleFavorite={toggleWatchlist}
              onSetAlert={setAlert}
              activeAlerts={activeAlerts}
              live={mode === 'live'}
              index={chartIndex ? engine.indices.find((i) => i.id === chartIndex) ?? null : null}
            />
          </section>
          <section
            data-testid="persona-dashboard"
            data-fullscreen={dashFs.fs}
            className={dashFs.fs ? 'fs fixed inset-0 z-[65] overflow-y-auto bg-bg' : 'min-w-0 overflow-y-auto bg-bg p-3'}
            aria-label={`${p.label} dashboard`}
          >
            {!dashFs.fs && !chartIndex && (
              <div className="mb-3 flex items-center">
                <button
                  type="button"
                  data-testid="panel-overview"
                  aria-pressed={showOverview}
                  onClick={() => setPanel('overview')}
                  className={`max-w-full truncate rounded-full border px-3 py-1 text-[12px] font-semibold ${showOverview ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted hover:text-ink'}`}
                >
                  📜 {quote.symbol} Overview
                </button>
              </div>
            )}
            {showOverview ? (
              <StockOverview quote={quote} engine={engine} instruments={instruments} onOpenPeer={openChart} onResearch={deepResearch} />
            ) : (
            <>
            <div className={`flex flex-wrap items-center gap-x-2 gap-y-2 ${dashFs.fs ? 'sticky top-0 z-10 border-b border-line bg-bg/95 px-3 py-2 backdrop-blur sm:px-5' : 'mb-3'}`}>
              <span key={'i' + persona} className="animate-fade-in text-lg" aria-hidden>{p.icon}</span>
              <div key={'t' + persona} className="animate-fade-in min-w-0 flex-1">
                <h2 className="truncate text-[14px] font-bold leading-tight text-ink">{p.label} dashboard{dashFs.fs && <span className="num ml-2 text-[12px] font-semibold text-muted">· {quote.symbol} ₹{fmt(quote.ltp)}</span>}</h2>
                <p className="truncate text-[11px] text-muted">{p.blurb}</p>
              </div>
              {dashFs.fs && <AnalysisActions {...actions} variant="icons" />}
              {dashFs.fs && <FeedBadge mode={mode} className="hidden sm:inline-flex" />}
              <button
                onClick={dashFs.toggle}
                aria-pressed={dashFs.fs}
                data-testid="dash-fullscreen"
                title={dashFs.fs ? 'Exit full screen (Esc)' : 'Expand charts and heatmaps to a borderless full-window view'}
                className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink hover:bg-line"
              >
                <span aria-hidden>🖥️</span>
                <span className="hidden sm:inline">{dashFs.fs ? 'Exit Full Screen' : 'Full Screen Dashboard'}</span>
                <span className="sr-only sm:hidden">{dashFs.fs ? 'Exit full screen' : 'Full screen'}</span>
              </button>
              <AskButton onClick={() => openAsk()} />
            </div>
            {/* keyed on persona: each lens switch remounts the view and replays the 300 ms fade + scale-in */}
            <div key={persona} data-testid="persona-view" className={`animate-fade-in ${dashFs.fs ? 'p-3 sm:p-5' : ''}`}>
              {canUse(user?.plan, persona) && (persona === 'day' || persona === 'retail') && (
                <>
                  <MyFocusBasket persona={persona} engine={engine} version={version} focus={focus} selected={symbol} glow={circuit.glow} candidates={focusCandidates} instruments={instruments} priceOf={(s) => engine.touch(s)?.ltp} holdings={holdings} onSelect={setSymbol} onToggle={(sym) => { const r = toggleFocus(sym); return r.ok ? null : r.error; }} />
                  {focus.includes(symbol) && (
                    <FocusDeepDive engine={engine} quote={quote} mode={mode} news={news} onExpand={expandChart} />
                  )}
                </>
              )}
              {canUse(user?.plan, persona) && persona === 'day' && <DayTraderDashboard {...dash} />}
              {canUse(user?.plan, persona) && persona === 'retail' && <RetailDashboard {...dash} />}
              {canUse(user?.plan, persona) && persona === 'institutional' && <InstitutionalDashboard {...dash} />}
              {canUse(user?.plan, persona) && persona === 'executive' && <ExecutiveDashboard {...dash} />}
            </div>
            </>
            )}
          </section>
        </main>
      )}

      <footer className="flex shrink-0 items-center gap-3 border-t border-line bg-panel px-3 py-1 text-[10px] text-muted">
        <span>
          <span data-testid="indexed-count" title={instruments.length < 1000 ? 'Only the bundled seed is loaded — run npm run sync:instruments to index the full NSE + BSE master' : undefined}>{instruments.length.toLocaleString('en-IN')} Instruments Indexed</span>
          {bseOnly > 0 && <> · NSE {(instruments.length - bseOnly).toLocaleString('en-IN')} + BSE-only {bseOnly.toLocaleString('en-IN')}</>}
        </span>
        <button type="button" onClick={() => setMethodOpen(true)} data-testid="methodology-open" className="cursor-pointer rounded border border-line px-1.5 py-px font-semibold text-accent hover:bg-accent/10">ƒ Methodology</button>
        <button type="button" onClick={() => setTeleOpen(true)} data-testid="telemetry-open" title="Live feed diagnostics" className="cursor-pointer rounded border border-line px-1.5 py-px font-semibold text-accent hover:bg-accent/10">📡 Telemetry</button>
        <button type="button" onClick={() => setWeek7Open(true)} data-testid="week7-open" title="Week 7 architecture summary" className="cursor-pointer rounded border border-line px-1.5 py-px font-semibold text-accent hover:bg-accent/10">Week 7 Specs</button>
        <span className="ml-auto hidden sm:inline">{mode === 'live' ? 'Prices streamed via Angel One SmartAPI; fundamentals not available from the feed show N/A.' : 'Prices are real NSE session data; fundamentals not available from the feed show N/A.'} Not investment advice.</span>
      </footer>

      <MethodologyDrawer open={methodOpen} onClose={() => setMethodOpen(false)} />
      <SystemTelemetryModal open={teleOpen} onClose={() => setTeleOpen(false)} engine={engine} mode={mode} instruments={instruments.length} />
      <Week7MilestoneModal open={week7Open} onClose={() => setWeek7Open(false)} />

      {research && (
        <StockResearchModal
          key={research}
          symbol={research}
          engine={engine}
          favorite={inAnyList(research)}
          holdings={holdings}
          mode={mode}
          news={news}
          onToggleFavorite={() => setPickFor(research)}
          onDeepResearch={deepResearch}
          onSetAlert={setAlert}
          activeAlerts={activeAlerts}
          onOpenTerminal={() => {
            setSymbol(research);
            setResearch(null);
            setView('terminal');
          }}
          onClose={() => setResearch(null)}
        />
      )}

      {importOpen && <PortfolioUploadModal instruments={instruments} engine={engine} mode={mode} onAddHolding={addHolding} onImport={importPortfolio} onReset={() => { resetHoldings(); setImportOpen(false); }} onClose={() => setImportOpen(false)} />}

      <WatchlistDrawer
        open={watchOpen}
        onClose={() => setWatchOpen(false)}
        instruments={instruments}
        engine={engine}
        lists={wlists}
        activeId={wActive}
        onSelect={selectWatch}
        onCreate={createWatch}
        onRename={renameWatch}
        onDelete={deleteWatch}
        list={favs}
        inAny={inAnyList}
        onPick={setPickFor}
        onRemove={(s) => { removeWatch(s); flash(`Removed ${s} from ${wName}`); }}
        onOpenChart={openChart}
      />

      {rebalanceOpen && (
        <RebalanceModal
          holdings={holdings}
          engine={engine}
          onApply={(h) => { setHoldings(h); flash(`Portfolio rebalanced · ${h.length} holdings`); }}
          onClose={() => setRebalanceOpen(false)}
        />
      )}

      {pickFor && (
        <WatchlistSelectorModal
          symbol={pickFor}
          name={engine.quotes.get(pickFor)?.name}
          lists={wlists}
          onSet={(id, sym, on) => {
            setWatchIn(id, sym, on); // saved immediately; the confirmation toast comes from "Done"
          }}
          onCreate={(n, sym) => {
            return createWatchWith(n, sym);
          }}
          onDone={({ added, removed, total }) => {
            const w = (n: number) => `${n} watchlist${n === 1 ? '' : 's'}`;
            const sym = pickFor;
            flash(added && removed ? `⭐ ${sym}: added to ${w(added)}, removed from ${w(removed)}` : added ? `⭐ Added ${sym} to ${w(added)}` : removed ? `Removed ${sym} from ${w(removed)}` : total ? `${sym} is in ${w(total)}` : `${sym} is not in any watchlist`);
          }}
          onClose={() => setPickFor(null)}
        />
      )}

      <AskUpCircuitDrawer open={askOpen} onClose={() => setAskOpen(false)} getContext={getAskContext} request={askReq} focusSymbol={research ?? (view === 'terminal' ? symbol : null)} hasPortfolio={holdings.length > 0} />

      {alertFor && alertTarget && (
        <PriceAlertDialog
          symbol={alertFor}
          ltp={alertTarget.ltp}
          alerts={priceAlerts.alerts}
          onAdd={(target) => {
            const r = priceAlerts.add(alertFor, target, alertTarget.ltp);
            if (!r.ok) return r.error;
            flash(`🔔 Alert set: ${alertFor} ${r.alert.dir === 'above' ? '≥' : '≤'} ₹${fmt(r.alert.target)}`);
            return null;
          }}
          onRemove={priceAlerts.remove}
          onClearTriggered={priceAlerts.clearTriggered}
          onClose={() => setAlertFor(null)}
        />
      )}

      {plansFor && <PlansModal want={plansFor === 'any' ? undefined : plansFor} onClose={() => setPlansFor(null)} />}
      {toast && (
        <div role="status" className="fixed right-4 top-[130px] z-[90] max-w-[calc(100vw-2rem)] rounded-md border border-line bg-panel px-4 py-2 text-[13px] text-ink shadow-2xl">
          {toast}
        </div>
      )}
    </div>
  );
}

/** The engine uses Date/Math.random, so render the terminal client-side only to avoid hydration mismatches. */
export default function Page() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <TerminalSkeleton />;
  }
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

/** login wall → terminal. Keyed on the user id so switching accounts remounts every hook with its own storage namespace. */
function Gate() {
  const { user, ready } = useAuth();
  if (!ready) return <TerminalSkeleton />;
  if (!user) {
    // deep links (/terminal?symbol=…) go through /login and come back after sign-in; every redirect resolves via NEXT_PUBLIC_APP_URL
    const p = window.location.pathname;
    if (p !== '/' && p !== '/login') {
      window.location.replace(appUrl(`/login?next=${encodeURIComponent(p + window.location.search)}`));
      return null;
    }
    return <AuthScreen />;
  }
  return <Terminal key={user.id} />;
}
