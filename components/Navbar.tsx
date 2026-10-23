'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { IndexQuote, Instrument } from '@/lib/types';
import { feedBadge, isMarketOpen, smartApiStatus, type FeedConn, type FeedMode, type Health, type LiveReason } from '@/lib/market';
import type { Persona } from '@/lib/personas';
import { useDismiss } from '@/hooks/useClickOutside';
import { testChime } from '@/lib/audioAlerts';
import { AnalysisActions } from './AnalysisActions';
import { IndexCard } from './IndexCard';
import { SearchBox } from './SearchBox';
import { ThemeToggle } from './ThemeToggle';
import { ProfilePopover } from './ProfilePopover';
import { ROLES, canUse, planFor, planOf } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';

export type View = 'home' | 'terminal';

interface Props {
  view: View;
  onView: (v: View) => void;
  persona: Persona;
  onPersona: (p: Persona) => void;
  /** open the plans dialog */
  onPlans?: () => void;
  /** 🔔 circuit-alert chimes */
  audioOn?: boolean;
  onToggleAudio?: () => void;
  /** circuit hits this session (badge on the sound/log menu) */
  circuitCount?: number;
  demo?: DemoControl;
  onOpenCircuitLog?: () => void;
  indices: IndexQuote[];
  instruments: Instrument[];
  /** a stock was chosen from universal search → open research */
  onSelect: (symbol: string) => void;
  /** an index card in the ticker was clicked → chart it */
  onOpenIndex?: (id: string) => void;
  /** the stock the analytical actions apply to (last selected) */
  symbol: string;
  watchlisted: boolean;
  activeAlerts: number;
  onDeepResearch: () => void;
  onToggleWatchlist: () => void;
  onSetAlert: () => void;
  searchRef: RefObject<HTMLInputElement>;
  /** feed status badge: LIVE MARKET / OFF-MARKET REPLAY / SIMULATED */
  mode: FeedMode;
  liveReason?: LiveReason;
  /** ⭐ button / W → open the Watchlist drawer */
  onOpenWatchlist?: () => void;
  /** live LTP for search results */
  priceOf?: (symbol: string) => number | undefined;
  /** browser ↔ SmartAPI socket state */
  conn: FeedConn;
  /** opens the CSV / image / PDF import modal */
  onOpenImport: () => void;
  /** opens the Ask UpCircuit drawer */
  onAsk: () => void;
}

export function FeedBadge({ mode, className = '' }: { mode: FeedMode; className?: string }) {
  const b = feedBadge(mode, isMarketOpen(Date.now()));
  const cls = b.tone === 'down' ? 'bg-down/15 text-down' : b.tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent';
  return (
    <span role="status" title={b.title} data-testid="feed-badge" data-mode={mode} className={`inline-flex shrink-0 items-center whitespace-nowrap rounded px-2 py-1 text-[10px] font-bold tracking-wide ${cls} ${mode === 'live' ? 'animate-pulse' : ''} ${className}`}>
      {b.text}
    </span>
  );
}

function UploadButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button onClick={onClick} title="Import portfolio (CSV, image or PDF)" aria-label="Import portfolio" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-muted hover:bg-line hover:text-ink ${className}`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
      </svg>
    </button>
  );
}

/** 🔊 sound-test + circuit-log menu: verify speakers / pitch before market open without waiting for a real breach. */
export interface DemoControl {
  active: boolean;
  onToggle: () => void;
  msg?: string;
}
export function SoundMenu({ count, onOpenLog, demo }: { count: number; onOpenLog?: () => void; demo?: DemoControl }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const item = 'block w-full px-3 py-1.5 text-left text-ink hover:bg-line';
  return (
    <div ref={ref} className="relative shrink-0" data-testid="sound-menu">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Sound test and circuit log" data-testid="sound-menu-trigger" className="flex h-8 items-center gap-1 rounded-md border border-line px-2 text-[11px] font-semibold text-muted hover:bg-line hover:text-ink">
        <span aria-hidden>🔊</span>
        {count > 0 && <span className="num rounded-full bg-accent/20 px-1.5 text-accent">{count}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-line bg-panel text-[12px] shadow-xl">
          <button role="menuitem" data-testid="menu-test-upper" className={item} onClick={() => void testChime('upper')}>▲ Test Upper Chime</button>
          <button role="menuitem" data-testid="menu-test-lower" className={item} onClick={() => void testChime('lower')}>▼ Test Lower Chime</button>
          {demo && (
            <>
              <button role="menuitemcheckbox" aria-checked={demo.active} data-testid="menu-demo-simulator" className={`${item} border-t border-line font-semibold ${demo.active ? 'text-warn' : ''}`} onClick={() => { demo.onToggle(); }} title="Off-hours only: drives RELIANCE / HFCL / PNB to circuit limits to test the overlay, chimes and log. Demo data — never real prices, never e-mailed.">⚡ Demo Circuit Simulator{demo.active ? ' · running (stop)' : ''}</button>
              {demo.msg && <div className="px-3 pb-1 text-[10px] text-muted" data-testid="demo-msg">{demo.msg}</div>}
            </>
          )}
          <button role="menuitem" data-testid="menu-circuit-log" className={`${item} border-t border-line`} onClick={() => { close(); onOpenLog?.(); }}>📋 Circuit Hit Log ({count})</button>
        </div>
      )}
    </div>
  );
}

export function AudioToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      data-testid="audio-toggle"
      title={on ? 'Circuit alert chimes are on — click to mute' : 'Circuit alert chimes are muted — click to enable'}
      className={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[11px] font-semibold transition ${on ? 'border-accent/60 bg-accent/10 text-accent' : 'border-line text-muted hover:bg-line'}`}
    >
      <span aria-hidden>{on ? '🔔' : '🔕'}</span>
      <span className="hidden xl:inline">Audio Alerts {on ? 'ON' : 'OFF'}</span>
      <span className="sr-only xl:hidden">Audio alerts {on ? 'on' : 'off'}</span>
    </button>
  );
}

export function AskButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button onClick={onClick} data-testid="ask-trigger" title="Ask UpCircuit AI about the market or your portfolio" aria-label="Ask UpCircuit AI" className={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-gradient-to-r from-accent to-[#7B61FF] px-2.5 text-[12px] font-bold text-white shadow-sm shadow-accent/30 ring-1 ring-white/10 transition hover:brightness-110 active:scale-95 sm:px-3 ${className}`}>
      <span aria-hidden>✨</span>
      <span className="sm:hidden">Ask</span>
      <span className="hidden sm:inline">Ask UpCircuit</span>
    </button>
  );
}


/* ───────────── credentials / connection status ───────────── */

interface ServerStatus {
  gemini: { configured: boolean; valid: boolean | null; reason?: 'rejected' | 'quota' | 'unreachable'; model: string };
  smartapi: { serverCreds: boolean; missing: string[]; publicKeyConfigured: boolean };
}

const DOT: Record<Health, string> = { ok: 'bg-up', warn: 'bg-warn', off: 'bg-muted/60' };

function aiStatus(st: ServerStatus | null, failed: boolean): { health: Health; label: string; detail: string } {
  if (failed) return { health: 'off', label: 'AI ?', detail: 'Could not reach /api/status.' };
  if (!st) return { health: 'off', label: 'AI …', detail: 'Checking…' };
  const g = st.gemini;
  if (!g.configured) return { health: 'off', label: 'Local rules', detail: 'GEMINI_API_KEY is not set on the server — Ask UpCircuit, the stock Copilot and news sentiment run on the local VADER + rules engine.' };
  if (g.valid === false) return { health: 'warn', label: 'Key rejected', detail: 'GEMINI_API_KEY is set but Google rejected it — answers fall back to local rules.' };
  if (g.valid === null) return { health: 'warn', label: 'Gemini ?', detail: 'GEMINI_API_KEY is set but Google could not be reached to validate it. Answers fall back to local rules on errors.' };
  if (g.reason === 'quota') return { health: 'warn', label: 'Gemini quota', detail: `Key accepted (${g.model}) but the quota is exhausted right now — local rules answer meanwhile (cached 5 min).` };
  return { health: 'ok', label: 'Gemini', detail: `Key accepted by Google (model ${g.model}). Local rules remain the fallback on quota or errors.` };
}

function StatusPill({ mode, conn, liveReason }: { mode: FeedMode; conn: FeedConn; liveReason?: LiveReason }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<ServerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      setSt((await r.json()) as ServerStatus);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => clearInterval(id);
  }, [load]);

  const ai = aiStatus(st, failed);
  const feed = smartApiStatus({ mode, conn, reason: liveReason });

  return (
    <div ref={ref} className="relative flex shrink-0 items-stretch border-l border-line">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="status-pill"
        aria-label={`Connections: AI ${ai.label}; market feed ${feed.label}`}
        className="flex items-center gap-2.5 px-2.5 text-[10px] font-semibold text-muted hover:bg-line md:text-[11px]"
      >
        <span className="flex items-center gap-1" data-testid="status-ai" data-health={ai.health}>
          <span className={`h-2 w-2 rounded-full ${DOT[ai.health]}`} />
          <span className="text-ink md:hidden">AI</span>
          <span className="hidden text-ink md:inline">{ai.label}</span>
        </span>
        <span className="flex items-center gap-1" data-testid="status-feed" data-health={feed.health}>
          <span className={`h-2 w-2 rounded-full ${DOT[feed.health]}`} />
          <span className="text-ink md:hidden">Feed</span>
          <span className="hidden text-ink md:inline">{feed.label}</span>
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label="Connection status" className="absolute right-0 top-full z-50 mt-1 w-[min(23rem,calc(100vw-1.5rem))] space-y-3 rounded-md border border-line bg-panel p-3 text-[12px] shadow-2xl shadow-black/40">
          <section>
            <h3 className="mb-0.5 flex items-center gap-1.5 font-bold text-ink"><span className={`h-2 w-2 rounded-full ${DOT[ai.health]}`} />AI · Gemini <span className="font-normal text-muted">— {ai.label}</span></h3>
            <p className="text-muted">{ai.detail}</p>
            {ai.health !== 'ok' && (
              <p className="mt-1 text-muted">To connect: set <code className="rounded bg-bg px-1 text-ink">GEMINI_API_KEY</code> (optional <code className="rounded bg-bg px-1 text-ink">GEMINI_MODEL</code>) in <code className="rounded bg-bg px-1 text-ink">.env.local</code> or your host’s environment variables, then restart / redeploy.</p>
            )}
          </section>
          <section>
            <h3 className="mb-0.5 flex items-center gap-1.5 font-bold text-ink"><span className={`h-2 w-2 rounded-full ${DOT[feed.health]}`} />Market feed · Angel One SmartAPI <span className="font-normal text-muted">— {feed.label}</span></h3>
            <p className="text-muted">{feed.detail}</p>
            {feed.health !== 'ok' && (
              <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-muted">
                <li>Set <code className="rounded bg-bg px-1 text-ink">SMARTAPI_API_KEY</code>, <code className="rounded bg-bg px-1 text-ink">SMARTAPI_CLIENT_CODE</code>, <code className="rounded bg-bg px-1 text-ink">SMARTAPI_PASSWORD</code>, <code className="rounded bg-bg px-1 text-ink">SMARTAPI_TOTP_SECRET</code> on the server (Vercel env vars).</li>
                <li>Set <code className="rounded bg-bg px-1 text-ink">NEXT_PUBLIC_SMARTAPI_API_KEY</code> (same API key) and redeploy — it is baked in at build time.</li>
                <li>Sign in with a Supabase account; the feed token is only issued to verified users.</li>
              </ol>
            )}
            {st && !st.smartapi.serverCreds && st.smartapi.missing.length < 4 && <p className="mt-1 text-warn">Partially set on this server — missing: {st.smartapi.missing.join(', ')}</p>}
          </section>
          <div className="flex items-center justify-between border-t border-line pt-2 text-[10px] text-muted">
            <span>Keys are read on the server only — never typed into or stored by this page.</span>
            <button onClick={load} className="shrink-0 rounded border border-line px-2 py-0.5 font-semibold text-accent hover:bg-accent/10">Recheck</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Below 1400 px the three analytical actions collapse into one menu. */
function ActionsMenu({ symbol, watchlisted, activeAlerts, onDeepResearch, onToggleWatchlist, onSetAlert, onOpenWatchlist, className = '' }: Pick<Props, 'symbol' | 'watchlisted' | 'activeAlerts' | 'onDeepResearch' | 'onToggleWatchlist' | 'onSetAlert' | 'onOpenWatchlist'> & { className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${symbol}`} data-testid="actions-menu" className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-accent bg-accent/10 px-2.5 text-[12px] font-semibold text-accent hover:bg-accent/20">
        <span aria-hidden>🔍</span>
        <span className="hidden lg:inline">{symbol}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-line bg-panel py-1 text-[13px] shadow-2xl shadow-black/40">
          <div className="border-b border-line px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{symbol}</div>
          <button role="menuitem" onClick={run(onDeepResearch)} className="block w-full px-3 py-2 text-left text-ink hover:bg-line">🔍 Deep Research</button>
          <button role="menuitem" onClick={run(onOpenWatchlist ?? onToggleWatchlist)} className="block w-full px-3 py-2 text-left text-ink hover:bg-line">{onOpenWatchlist ? '⭐ Watchlist' : watchlisted ? '⭐ In Watchlist (remove)' : '⭐ Add to Watchlist'}</button>
          <button role="menuitem" onClick={run(onSetAlert)} className="flex w-full items-center justify-between px-3 py-2 text-left text-ink hover:bg-line">
            <span>🔔 Set Price Alert</span>
            {activeAlerts > 0 && <span className="num rounded-full bg-accent px-1.5 text-[10px] font-bold leading-4 text-white">{activeAlerts}</span>}
          </button>
        </div>
      )}
    </div>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2 pr-1">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="rgb(var(--c-accent))" />
        <path d="M8 21a8 8 0 1 1 16 0" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M10 22l4-5 3 3 5-7" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="hidden text-[15px] font-bold tracking-tight text-ink sm:inline">
        Up<span className="text-accent">Circuit</span>
      </span>
    </div>
  );
}

const PERSONA_OPTIONS = ROLES;

/** Standard persona dropdown: [ icon + selected persona ▾ ] with the four lenses as options. */
function PersonaDropdown({ persona, onPersona, className = '', testId = 'persona-dropdown', compact = false }: { persona: Persona; onPersona: (p: Persona) => void; className?: string; testId?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const { user } = useAuth();
  const cur = PERSONA_OPTIONS.find((o) => o.id === persona) ?? PERSONA_OPTIONS[1];
  return (
    <div ref={ref} className={`relative shrink-0 ${className}`} data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Persona: ${cur.label}`}
        data-testid={`${testId}-trigger`}
        className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-panel/80 px-2.5 text-xs font-medium text-ink transition-all hover:bg-line"
      >
        <span aria-hidden>{cur.icon}</span>
        <span className={compact ? 'sr-only' : 'hidden lg:inline'}>{cur.label}</span>
        <span aria-hidden className="text-[10px] text-muted">▾</span>
      </button>
      {open && (
        <ul role="listbox" aria-label="Workspace persona" className="absolute right-0 top-full z-[80] mt-1 w-60 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-2xl">
          {PERSONA_OPTIONS.map((o) => (
            <li key={o.id} role="none">
              <button
                role="option"
                aria-selected={o.id === persona}
                data-persona={o.id}
                onClick={() => {
                  setOpen(false);
                  onPersona(o.id);
                }}
                className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-line ${!canUse(user?.plan, o.id) ? 'text-muted ' : ''}${o.id === persona ? 'bg-accent/15 font-semibold text-accent' : 'text-ink'}`}
              >
                <span aria-hidden>{o.icon}</span>
                <span className="flex-1">{o.label}</span>
                {!canUse(user?.plan, o.id) ? <span title={`Unlocks with ${planFor(o.id).name} or Full Access`} data-testid={`lock-${o.id}`}>🔒</span> : o.id === persona && <span aria-hidden>✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AvatarMenu({ mode, conn, liveReason, onPlans }: { mode: FeedMode; conn: FeedConn; liveReason?: LiveReason; onPlans?: () => void }) {
  return <ProfilePopover mode={mode} conn={conn} liveReason={liveReason} onPlans={onPlans} />;
}


export function Navbar({ view, onView, persona, onPersona, onPlans, audioOn = true, onToggleAudio, circuitCount = 0, onOpenCircuitLog, demo, indices, instruments, onSelect, onOpenIndex, symbol, watchlisted, activeAlerts, onDeepResearch, onToggleWatchlist, onSetAlert, searchRef, mode, liveReason, conn, onOpenWatchlist, priceOf, onOpenImport, onAsk }: Props) {
  const actionProps = { symbol, watchlisted, activeAlerts, onDeepResearch, onToggleWatchlist, onSetAlert, onOpenWatchlist };
  return (
    <header className="relative">
      <div className="flex h-[52px] items-center gap-2 border-b border-line bg-panel px-3 md:gap-3">
        <Logo />

        <nav className="flex shrink-0 items-center gap-0.5" aria-label="Primary">
          {(['home', 'terminal'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => onView(v)}
              aria-current={view === v ? 'page' : undefined}
              className={`rounded px-2 py-1.5 text-[12px] font-semibold sm:px-2.5 sm:text-[13px] ${view === v ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}
            >
              {v === 'home' ? (<><span className="sm:hidden">Discover</span><span className="hidden sm:inline">Discovery Hub</span></>) : 'Terminal'}
            </button>
          ))}
        </nav>

        <div className="hidden min-w-0 flex-1 justify-center md:flex">
          <SearchBox instruments={instruments} onSelect={onSelect} inputRef={searchRef} priceOf={priceOf} />
        </div>
        <div className="flex-1 md:hidden" />

        <PersonaDropdown persona={persona} onPersona={onPersona} className="hidden sm:block" />
        <UploadButton onClick={onOpenImport} className="hidden md:flex" />
        <AskButton onClick={onAsk} />
        {onToggleAudio && <AudioToggle on={audioOn} onToggle={onToggleAudio} />}
        {onToggleAudio && <SoundMenu count={circuitCount} onOpenLog={onOpenCircuitLog} demo={demo} />}
        <ThemeToggle />
        <ActionsMenu {...actionProps} className="hidden md:block min-[1400px]:hidden" />
        <div className="hidden items-center gap-2 min-[1400px]:flex">
          <span className="rounded bg-bg px-1.5 py-1 text-[10px] font-bold text-muted" title="The analytical actions apply to the last selected stock">{symbol}</span>
          <AnalysisActions {...actionProps} variant="responsive" />
        </div>
        <div className="hidden sm:block">
          <AvatarMenu mode={mode} conn={conn} liveReason={liveReason} onPlans={onPlans} />
        </div>
      </div>

      {/* mobile search + import */}
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 md:hidden">
        <div className="min-w-0 flex-1">
          <SearchBox instruments={instruments} onSelect={onSelect} inputRef={searchRef} priceOf={priceOf} />
        </div>
        <PersonaDropdown persona={persona} onPersona={onPersona} className="sm:hidden" testId="persona-dropdown-mobile" compact />
        <ActionsMenu {...actionProps} />
        <UploadButton onClick={onOpenImport} />
        <div className="sm:hidden"><AvatarMenu mode={mode} conn={conn} liveReason={liveReason} onPlans={onPlans} /></div>
      </div>

      {/* feed status + index ticker */}
      <div className="flex items-stretch border-b border-line bg-panel" aria-label="Market indices">
        <div className="flex shrink-0 items-center border-r border-line px-2">
          <FeedBadge mode={mode} />
        </div>
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {indices.map((ix) => (
            <IndexCard key={ix.id} ix={ix} onOpen={onOpenIndex} />
          ))}
        </div>
        <StatusPill mode={mode} conn={conn} liveReason={liveReason} />
      </div>
    </header>
  );
}
