'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AskButton, FeedBadge, Navbar, type View } from '@/components/Navbar';
import { AnalysisActions } from '@/components/AnalysisActions';
import { AskUpCircuitDrawer, type AskRequest } from '@/components/AskUpCircuitDrawer';
import { PortfolioUploadModal } from '@/components/PortfolioUploadModal';
import { PriceAlertDialog } from '@/components/PriceAlertDialog';
import { CircuitBanner } from '@/components/CircuitBanner';
import { HomePage } from '@/components/HomePage';
import { ChartWorkspace } from '@/components/ChartWorkspace';
import { StockResearchModal } from '@/components/StockResearchModal';
import { DayTraderDashboard } from '@/components/dashboards/DayTrader';
import { RetailDashboard } from '@/components/dashboards/Retail';
import { InstitutionalDashboard } from '@/components/dashboards/Institutional';
import { ExecutiveDashboard } from '@/components/dashboards/Executive';
import { useMarket } from '@/hooks/useMarket';
import { useInstruments } from '@/hooks/useInstruments';
import { useWatchlist } from '@/hooks/useWatchlist';
import { RebalanceModal } from '@/components/RebalanceModal';
import { WatchlistSelectorModal } from '@/components/WatchlistSelectorModal';
import { WatchlistDrawer } from '@/components/WatchlistDrawer';
import { StockOverview } from '@/components/StockOverview';
import { useHoldings } from '@/hooks/useHoldings';
import { useFocus } from '@/hooks/useFocus';
import { FocusBoard } from '@/components/FocusBoard';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { AuthScreen } from '@/components/AuthScreen';
import { PlansModal } from '@/components/PlansModal';
import { allowedRoles, canUse, coerceRole, type Role } from '@/lib/auth';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useNews } from '@/hooks/useNews';
import { useFullscreen } from '@/hooks/useFullscreen';
import { usePriceAlerts } from '@/hooks/usePriceAlerts';
import { buildAskContext } from '@/lib/ask';
import { fmt } from '@/lib/format';
import { basePrice, generateHistory, hashStr, mulberry32, roundTick } from '@/lib/market';
import { personaOf, type Persona } from '@/lib/personas';
import type { Holding, Timeframe } from '@/lib/types';

const DEMO_HOLDINGS: Holding[] = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ITC', 'SBIN'].map((symbol, i) => ({
  symbol,
  qty: [25, 10, 40, 30, 100, 60][i],
  avg: roundTick(basePrice(symbol) * (0.88 + mulberry32(hashStr(symbol + ':avg'))() * 0.2)),
}));

function Terminal() {
  const instruments = useInstruments();
  const knownSymbols = useMemo(() => new Set(instruments.map((i) => i.symbol)), [instruments]);
  const bseOnly = useMemo(() => instruments.reduce((n, i) => n + (i.exch === 'BSE' ? 1 : 0), 0), [instruments]);
  const { list: favs, all: allWatched, lists: wlists, activeId: wActive, activeName: wName, select: selectWatch, toggle: toggleFav, add: addWatch, remove: removeWatch, create: createWatch, rename: renameWatch, del: deleteWatch, setIn: setWatchIn, createWith: createWatchWith, inAny: inAnyList } = useWatchlist();
  const [watchOpen, setWatchOpen] = useState(false);
  /** symbol whose "Add to Watchlist" selector (checkbox per list) is open */
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [rebalanceOpen, setRebalanceOpen] = useState(false);
  const { holdings, setHoldings, resetHoldings } = useHoldings(DEMO_HOLDINGS);
  const { focus, toggle: toggleFocus } = useFocus();
  const { user, update: updateAccount } = useAuth();
  const [plansFor, setPlansFor] = useState<Role | 'any' | null>(null);
  const { news, error: newsError } = useNews();
  const priceAlerts = usePriceAlerts();
  const dashFs = useFullscreen();

  // the app opens on the Angel One-style Discovery Hub; persona lenses are chosen from the Navbar dropdown
  const [view, setView] = useState<View>('home');
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
  const [symbol, setSymbol] = useState('RELIANCE');
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
  const focusCandidates = useMemo(() => [...new Set([...allWatched, ...holdings.map((h) => h.symbol)])], [allWatched, holdings]);
  const watch = useMemo(() => [...allWatched, ...holdings.map((h) => h.symbol), ...alertSymbols], [allWatched, holdings, alertSymbols]);
  const { engine, version, mode, conn, source } = useMarket(instruments, symbol, watch, focus);

  const quote = engine.touch(symbol) ?? engine.touch('RELIANCE')!;

  // daily closes for RSI / Sharpe — history shape is fixed per symbol, last bar tracks the live LTP
  const dailyBase = useMemo(() => generateHistory(symbol, '1D', engine.touch(symbol)?.ltp ?? 100, Date.now()).map((c) => c.close), [symbol, engine]);
  const closes1D = useMemo(() => [...dailyBase.slice(0, -1), quote.ltp], [dailyBase, quote.ltp]);

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
    document.title = `${quote.ltp.toFixed(2)} ${quote.symbol} · UpCircuit`;
  }, [quote.ltp, quote.symbol]);

  // price alerts are checked on every market render
  useEffect(() => {
    const fired = priceAlerts.evaluate((s) => engine.touch(s)?.ltp);
    fired.forEach((a) => flash(`🔔 ${a.symbol} ${a.dir === 'above' ? 'rose to' : 'fell to'} ₹${fmt(a.triggeredPrice ?? a.target)} — your alert at ₹${fmt(a.target)}`, 9000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // leaving the workspace view also leaves full screen
  const exitFs = dashFs.exit;
  useEffect(() => {
    if (view !== 'terminal') exitFs();
  }, [view, exitFs]);

  /** off-market: ▶ replay the previous session of the charted stock (real Yahoo 1-minute bars when available, else the deterministic series) */
  const [replayBusy, setReplayBusy] = useState(false);
  const toggleReplay = useCallback(async () => {
    if (engine.replaying) return engine.stopSessionReplay();
    setReplayBusy(true);
    let bars: { open: number; high: number; low: number; close: number; volume: number }[] | undefined;
    try {
      const inst = instruments.find((i) => i.symbol === symbol);
      const res = await fetch(`/api/session/${encodeURIComponent(symbol)}?exch=${inst?.exch ?? 'NSE'}`, { signal: AbortSignal.timeout(7000) });
      const j = res.ok ? await res.json() : null;
      if (j?.ok && Array.isArray(j.bars)) bars = j.bars;
    } catch {
      /* no real bars → deterministic series */
    }
    setReplayBusy(false);
    if (engine.startSessionReplay(symbol, bars)) flash(bars ? `▶ Replaying the last session of ${symbol} (real 1-minute bars)` : `▶ Replaying a simulated last session of ${symbol}`);
  }, [engine, symbol, instruments, flash]);

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

  return (
    <div className={`flex min-h-screen flex-col bg-bg ${view === 'terminal' ? 'lg:h-screen' : ''}`}>
      <div className="sticky top-0 z-50 shrink-0">
        <CircuitBanner alerts={engine.alerts} onSelect={openStock} />
        <Navbar
          view={view}
          onView={setView}
          persona={persona}
          onPlans={() => setPlansFor('any')}
          onPersona={(x) => {
            setPersona(x);
            setPanel('dashboard');
            setView('terminal');
          }}
          indices={engine.indices}
          instruments={instruments}
          onSelect={openStock}
          onOpenIndex={openIndex}
          source={source}
          onOpenWatchlist={() => setWatchOpen(true)}
          priceOf={(s) => engine.touch(s)?.ltp}
          {...actions}
          searchRef={searchRef}
          mode={mode}
          conn={conn}
          onOpenImport={() => setImportOpen(true)}
          onAsk={() => openAsk()}
        />
      </div>

      {view === 'home' ? (
        <main className="flex-1">
          <HomePage engine={engine} news={news} newsError={newsError} onOpenStock={openStock} instruments={instruments} onOpenChart={openChart} />
        </main>
      ) : (
        <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.45fr)_minmax(400px,1fr)]">
          <section className="min-h-[600px] min-w-0 border-r border-line lg:min-h-0">
            <ChartWorkspace
              quote={quote}
              tf={tf}
              onTf={setTf}
              onResearch={deepResearch}
              favorite={inAnyList(symbol)}
              onToggleFavorite={toggleWatchlist}
              onSetAlert={setAlert}
              activeAlerts={activeAlerts}
              index={chartIndex ? engine.indices.find((i) => i.id === chartIndex) ?? null : null}
              replay={mode === 'replay' ? { active: engine.replaying?.symbol === symbol, real: !!engine.replaying?.real, progress: engine.replaying?.progress ?? 0, busy: replayBusy, onToggle: toggleReplay } : undefined}
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
                <FocusBoard persona={persona} engine={engine} version={version} focus={focus} candidates={focusCandidates} holdings={holdings} onSelect={setSymbol} onToggle={(sym) => { const r = toggleFocus(sym); return r.ok ? null : r.error; }} />
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
          {instruments.length.toLocaleString('en-IN')} instruments indexed
          {bseOnly > 0 && <> · NSE {(instruments.length - bseOnly).toLocaleString('en-IN')} + BSE-only {bseOnly.toLocaleString('en-IN')}</>}
        </span>
        <span className="ml-auto hidden sm:inline">{mode === 'live' ? 'Prices streamed via Angel One SmartAPI; ratios are simulated.' : 'Prices, depth and ratios are synthetic and for demonstration only.'} Not investment advice.</span>
      </footer>

      {research && (
        <StockResearchModal
          key={research}
          symbol={research}
          engine={engine}
          favorite={inAnyList(research)}
          holdings={holdings}
          mode={mode}
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

      {importOpen && <PortfolioUploadModal instruments={instruments} engine={engine} mode={mode} onImport={importPortfolio} onReset={() => { resetHoldings(); setImportOpen(false); }} onClose={() => setImportOpen(false)} />}

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
            setWatchIn(id, sym, on);
            const n = wlists.find((l) => l.id === id)?.name ?? 'watchlist';
            flash(on ? `⭐ Added ${sym} to ${n}` : `Removed ${sym} from ${n}`);
          }}
          onCreate={(n, sym) => {
            const r = createWatchWith(n, sym);
            if (r.ok) flash(`⭐ Created “${n.trim()}” and added ${sym}`);
            return r;
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
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-[13px] text-muted">
        <span className="animate-pulse">Starting UpCircuit…</span>
      </div>
    );
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
  if (!ready) return <div className="flex h-screen items-center justify-center bg-bg text-[13px] text-muted"><span className="animate-pulse">Starting UpCircuit…</span></div>;
  if (!user) return <AuthScreen />;
  return <Terminal key={user.id} />;
}
