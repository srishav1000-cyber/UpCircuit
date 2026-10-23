'use client';

import { TickPriceFlash } from './TickPriceFlash';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import { buildIndex, searchInstruments } from '@/lib/fuzzy';
import type { Instrument } from '@/lib/types';
import { dayPct } from '@/lib/analytics';
import { fmt, fmtPct, tone } from '@/lib/format';
import { MAX_LISTS, MAX_NAME, type OpResult, type Watchlist } from '@/lib/watchlist';

interface Props {
  open: boolean;
  onClose: () => void;
  instruments: Instrument[];
  engine: MarketEngine;
  /** named watchlist tabs + the active one (single source of truth: useWatchlist) */
  lists: Watchlist[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => OpResult;
  onRename: (id: string, name: string) => OpResult;
  onDelete: (id: string) => OpResult;
  /** symbols of the ACTIVE list */
  list: string[];
  /** is the symbol in ANY list (drives the ✓ state) */
  inAny: (symbol: string) => boolean;
  /** open the "Add to Watchlist" selector (checkbox per list) for a symbol */
  onPick: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  /** open the stock's chart */
  onOpenChart: (symbol: string) => void;
}

/** Slide-over watchlist: search all instruments, add / remove, live LTP, open chart. Controlled — state lives in useWatchlist. */
const WHY: Record<string, string> = { empty: 'Enter a name', duplicate: 'That name already exists', limit: `Max ${MAX_LISTS} watchlists`, last: 'Keep at least one watchlist', missing: 'Watchlist not found' };

export function WatchlistDrawer({ open, onClose, instruments, engine, lists, activeId, onSelect, onCreate, onRename, onDelete, list, inAny, onPick, onRemove, onOpenChart }: Props) {
  const active = lists.find((l) => l.id === activeId) ?? lists[0];
  // tab editing: adding a new list, renaming one, the ⋯ menu, delete confirmation
  const [mode, setMode] = useState<null | 'new' | 'rename'>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const endEdit = () => { setMode(null); setDraft(''); setErr(''); };
  const submit = () => {
    const r = mode === 'new' ? onCreate(draft) : onRename(active.id, draft);
    if (r.ok) endEdit();
    else setErr(WHY[r.reason] ?? 'Could not save');
  };
  useEffect(() => { if (mode) nameInput.current?.focus(); }, [mode]);
  useEffect(() => { setMenu(false); setConfirmDel(false); }, [activeId, open]);
  useEffect(() => { if (!open) endEdit(); }, [open]);

  const index = useMemo(() => buildIndex(instruments), [instruments]);
  const bySymbol = useMemo(() => new Map(instruments.map((i) => [i.symbol, i])), [instruments]);
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => input.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
    setQ('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const results = useMemo(() => (open ? searchInstruments(index, q, 30) : []), [open, index, q]);
  
  return (
    <>
      <div className={`fixed inset-0 z-[70] bg-black/50 transition-opacity duration-200 sm:bg-black/30 ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`} onMouseDown={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Watchlist"
        aria-hidden={!open}
        data-testid="watchlist-drawer"
        className={`fixed right-0 top-0 z-[75] flex h-[100dvh] w-full max-w-full flex-col border-l border-line bg-panel shadow-2xl transition-[transform,visibility] duration-200 sm:w-[420px] ${open ? 'translate-x-0 visible' : 'invisible translate-x-full'}`}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="text-lg" aria-hidden>⭐</span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-bold text-ink">Watchlist</h2>
            <p className="truncate text-[10px] text-muted">{active.name} · {list.length} stock{list.length === 1 ? '' : 's'} · search {instruments.length.toLocaleString('en-IN')} NSE + BSE instruments</p>
          </div>
          <button onClick={onClose} aria-label="Close watchlist (Esc)" className="flex h-8 w-8 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
        </header>

        {/* named watchlist tabs */}
        <div className="relative border-b border-line" data-testid="wl-tabbar">
          <div className="flex items-stretch overflow-x-auto px-2" role="tablist" aria-label="Watchlists">
            {lists.map((l) => {
              const on = l.id === active.id;
              if (on && mode === 'rename')
                return (
                  <input key={l.id} ref={nameInput} value={draft} maxLength={MAX_NAME} onChange={(e) => { setDraft(e.target.value); setErr(''); }} onBlur={endEdit} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { e.stopPropagation(); endEdit(); } }} aria-label="Rename watchlist" data-testid="wl-name-input" className="my-1 w-32 shrink-0 rounded border border-accent bg-bg px-2 py-1 text-[12px] text-ink outline-none" />
                );
              return (
                <div key={l.id} className={`flex shrink-0 items-center border-b-2 ${on ? 'border-accent' : 'border-transparent'}`}>
                  <button
                    role="tab"
                    aria-selected={on}
                    data-testid="wl-tab"
                    data-id={l.id}
                    onClick={() => onSelect(l.id)}
                    onDoubleClick={() => { onSelect(l.id); setDraft(l.name); setMode('rename'); }}
                    title={on ? `${l.name} — double-click to rename` : l.name}
                    className={`cursor-pointer whitespace-nowrap px-3 py-2 text-[13px] ${on ? 'font-semibold text-accent' : 'text-muted hover:text-ink'}`}
                  >
                    {l.name}
                    <span className="ml-1 text-[10px] opacity-60">{l.symbols.length}</span>
                  </button>
                  {on && (
                    <button onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label={`${l.name} actions`} data-testid="wl-menu" className="mr-1 flex h-6 w-6 items-center justify-center rounded text-[14px] leading-none text-muted hover:bg-line hover:text-ink">⋯</button>
                  )}
                </div>
              );
            })}
            {mode === 'new' ? (
              <input ref={nameInput} value={draft} maxLength={MAX_NAME} placeholder="Name, e.g. Swing Trading" onChange={(e) => { setDraft(e.target.value); setErr(''); }} onBlur={() => !draft.trim() && endEdit()} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { e.stopPropagation(); endEdit(); } }} aria-label="New watchlist name" data-testid="wl-name-input" className="my-1 w-44 shrink-0 rounded border border-accent bg-bg px-2 py-1 text-[12px] text-ink outline-none placeholder:text-muted" />
            ) : (
              <button onClick={() => { setDraft(''); setErr(''); setMode('new'); }} disabled={lists.length >= MAX_LISTS} aria-label="Add new watchlist" title="New watchlist" data-testid="wl-new" className="my-1 ml-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded border border-line text-[15px] leading-none text-muted hover:border-accent hover:text-accent disabled:opacity-40">+</button>
            )}
          </div>
          {err && <p role="alert" data-testid="wl-error" className="px-4 pb-1 text-[11px] text-down">{err}</p>}
          {menu && (
            <div role="menu" className="absolute right-3 top-full z-10 mt-0.5 w-44 overflow-hidden rounded-md border border-line bg-panel py-1 shadow-xl">
              <button role="menuitem" data-testid="wl-rename" onClick={() => { setMenu(false); setDraft(active.name); setErr(''); setMode('rename'); }} className="block w-full px-3 py-1.5 text-left text-[12px] text-ink hover:bg-line">✎ Rename</button>
              {confirmDel ? (
                <button role="menuitem" data-testid="wl-delete-confirm" onClick={() => { const r = onDelete(active.id); setConfirmDel(false); setMenu(false); if (!r.ok) setErr(WHY[r.reason] ?? ''); }} className="block w-full px-3 py-1.5 text-left text-[12px] font-semibold text-down hover:bg-line">Confirm delete “{active.name}”</button>
              ) : (
                <button role="menuitem" data-testid="wl-delete" disabled={lists.length <= 1} onClick={() => setConfirmDel(true)} className="block w-full px-3 py-1.5 text-left text-[12px] text-down hover:bg-line disabled:opacity-40">🗑 Delete</button>
              )}
            </div>
          )}
        </div>

        <div className="border-b border-line p-3">
          <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-3 py-1.5 focus-within:border-accent">
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search symbol or company to add to ${active.name}…`}
              aria-label="Search stocks to add"
              data-testid="watch-search"
              className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
              spellCheck={false}
              autoComplete="off"
            />
            {q && <button onClick={() => setQ('')} aria-label="Clear search" className="text-muted hover:text-ink">×</button>}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {q.trim() ? (
            <ul data-testid="watch-results" aria-label="Search results">
              {results.length === 0 && <li className="px-4 py-4 text-[13px] text-muted">No instruments match “{q}”</li>}
              {results.map((r) => {
                const on = inAny(r.symbol);
                return (
                  <li key={r.symbol} className="flex items-center gap-3 border-b border-line/60 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-ink">{r.symbol}</span>
                        <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{r.exch ?? 'NSE'}</span>
                      </div>
                      <div className="truncate text-[11px] text-muted">{r.name}</div>
                    </div>
                    <button
                      onClick={() => onPick(r.symbol)}
                      aria-haspopup="dialog"
                      aria-pressed={on}
                      data-testid={on ? 'watch-added' : 'watch-add'}
                      className={`shrink-0 rounded-md border px-2.5 py-1 text-[12px] font-semibold ${on ? 'border-warn/60 bg-warn/10 text-warn' : 'border-accent text-accent hover:bg-accent/10'} disabled:opacity-40`}
                    >
                      {on ? '★ In Watchlist' : '+ Add to Watchlist'}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : list.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted">“{active.name}” is empty — search above to add stocks.</p>
          ) : (
            <ul data-testid="watch-items" aria-label="Watchlist items">
              {list.map((s) => {
                const quote = engine.touch(s);
                const inst = bySymbol.get(s);
                const pct = quote ? dayPct(quote) : 0;
                return (
                  <li key={s} data-symbol={s} className="flex items-center gap-2 border-b border-line/60 px-4 py-2 hover:bg-line/40">
                    <button onClick={() => { onOpenChart(s); onClose(); }} title={`Open ${s} chart`} className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-ink">{s}</span>
                        <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{inst?.exch ?? 'NSE'}</span>
                      </div>
                      <div className="truncate text-[11px] text-muted">{inst?.name ?? quote?.name ?? ''}</div>
                    </button>
                    <div className="num text-right">
                      <div className="text-[13px] font-semibold text-ink">{quote ? <TickPriceFlash value={quote.ltp}>{`₹${fmt(quote.ltp)}`}</TickPriceFlash> : '—'}</div>
                      <div className={`text-[11px] ${tone(pct)}`}>{quote ? fmtPct(pct) : ''}</div>
                    </div>
                    <button onClick={() => onRemove(s)} aria-label={`Remove ${s} from ${active.name}`} title="Remove" className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line text-[15px] leading-none text-muted hover:border-down hover:text-down">×</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
