'use client';

import { useEffect, useRef, useState } from 'react';
import { MAX_LISTS, MAX_NAME, type OpResult, type Watchlist } from '@/lib/watchlist';

interface Props {
  symbol: string;
  name?: string;
  lists: Watchlist[];
  /** check / uncheck: add the stock to, or remove it from, that specific list */
  onSet: (listId: string, symbol: string, on: boolean) => void;
  /** create a list and put the stock into it */
  onCreate: (name: string, symbol: string) => OpResult;
  onClose: () => void;
  /** called once when the popover is closed by any route (Done, ×, Esc, backdrop) with the net result of this session */
  onDone?: (r: { added: number; removed: number; total: number }) => void;
}

const WHY: Record<string, string> = { empty: 'Enter a name', duplicate: 'That name already exists', limit: `Max ${MAX_LISTS} watchlists`, last: '', missing: '' };

/** "Add to Watchlist" — one checkbox per named list (checked = the stock is in it), plus an inline "+ Create New Watchlist". */
export function WatchlistSelectorModal({ symbol, name, lists, onSet, onCreate, onClose, onDone }: Props) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const count = lists.filter((l) => l.symbols.includes(symbol)).length;
  // which lists held the stock when the popover opened → "Added to 2 watchlists" / "Removed from 1" on Done
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(lists.filter((l) => l.symbols.includes(symbol)).map((l) => l.id));
  const listsRef = useRef(lists);
  listsRef.current = lists;
  const closed = useRef(false);
  const finish = () => {
    if (closed.current) return;
    closed.current = true;
    const now = new Set(listsRef.current.filter((l) => l.symbols.includes(symbol)).map((l) => l.id));
    let added = 0;
    let removed = 0;
    now.forEach((id) => !initial.current!.has(id) && added++);
    initial.current!.forEach((id) => !now.has(id) && removed++);
    onDone?.({ added, removed, total: now.size });
    onClose();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      finishRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const create = () => {
    const r = onCreate(draft, symbol);
    if (r.ok) {
      setDraft('');
      setErr('');
    } else setErr(WHY[r.reason] || 'Could not create');
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-3 sm:items-center" onMouseDown={finish} data-testid="wl-selector-backdrop">
      <div role="dialog" aria-modal="true" aria-label={`Add ${symbol} to watchlist`} data-testid="wl-selector" onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-sm overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className={`text-lg leading-none ${count ? 'text-warn' : 'text-muted'}`} aria-hidden>{count ? '★' : '☆'}</span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-bold text-ink">Add to Watchlist</h2>
            <p className="truncate text-[11px] text-muted">{symbol}{name ? ` · ${name}` : ''}</p>
          </div>
          <button onClick={finish} aria-label="Close (Esc)" className="flex h-7 w-7 items-center justify-center rounded border border-line text-[16px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
        </header>

        <ul className="max-h-[50vh] overflow-y-auto py-1" role="group" aria-label="Watchlists">
          {lists.map((l) => {
            const on = l.symbols.includes(symbol);
            return (
              <li key={l.id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-line/50">
                  <input type="checkbox" checked={on} onChange={(e) => onSet(l.id, symbol, e.target.checked)} data-testid="wl-check" data-id={l.id} className="h-4 w-4 cursor-pointer accent-accent" />
                  <span className="flex-1 truncate text-[13px] text-ink">{l.name}</span>
                  <span className="num text-[11px] text-muted">{l.symbols.length}</span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5 focus-within:border-accent">
            <span aria-hidden className="text-[14px] text-accent">+</span>
            <input
              ref={input}
              value={draft}
              maxLength={MAX_NAME}
              onChange={(e) => { setDraft(e.target.value); setErr(''); }}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), create())}
              placeholder="Create New Watchlist (e.g. Swing Trades)"
              aria-label="New watchlist name"
              data-testid="wl-selector-new"
              className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
              disabled={lists.length >= MAX_LISTS}
              autoComplete="off"
            />
          </div>
          {err ? <p role="alert" data-testid="wl-selector-error" className="mt-1 text-[11px] text-down">{err}</p> : <p className="mt-1 text-[10px] text-muted">Press Enter to create it and add {symbol}.</p>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-line bg-bg/40 px-3 py-2.5">
          <span className="text-[11px] text-muted" data-testid="wl-count">{count === 0 ? 'Not in any watchlist' : `In ${count} watchlist${count === 1 ? '' : 's'}`}</span>
          <button type="button" onClick={finish} data-testid="wl-done" className="cursor-pointer rounded-md bg-accent px-5 py-1.5 text-[13px] font-bold text-white shadow-sm shadow-accent/30 transition hover:brightness-110 active:scale-95">Done</button>
        </footer>
      </div>
    </div>
  );
}
