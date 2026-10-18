'use client';

import { scoped } from '@/lib/scope';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_WATCHLIST, WATCHLIST_KEY, WATCHLISTS_KEY, activeList, addSymbol, allSymbols, createList, defaultState, deleteList, mapList, parseState, parseWatchlist, removeSymbol, renameList, setActive,
  type OpResult, type WatchlistState,
} from '@/lib/watchlist';

/** Load v2 state; else migrate the legacy single list (upcircuit:favorites) into "Main". */
function load(): WatchlistState {
  try {
    const v2 = parseState(localStorage.getItem(scoped(WATCHLISTS_KEY)));
    if (v2) return v2;
    return defaultState(parseWatchlist(localStorage.getItem(WATCHLIST_KEY)) ?? DEFAULT_WATCHLIST);
  } catch {
    return defaultState();
  }
}

/**
 * Single source of truth for the named watchlists (★ on charts, Navbar button, drawer tabs). Persisted + synced across browser tabs.
 * `list` / `add` / `remove` / `toggle` / `has` act on the ACTIVE tab; `all` is the union (used to keep every watched symbol simulated / subscribed).
 */
export function useWatchlist() {
  const [state, setState] = useState<WatchlistState>(() => defaultState());
  const ref = useRef(state); // latest committed state, so create / rename / delete can report their outcome synchronously

  const apply = useCallback((next: WatchlistState, persist: boolean) => {
    ref.current = next;
    setState(next);
    if (!persist) return;
    try {
      localStorage.setItem(scoped(WATCHLISTS_KEY), JSON.stringify(next));
    } catch {
      /* storage unavailable — in-memory only */
    }
  }, []);

  useEffect(() => {
    apply(load(), false);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== scoped(WATCHLISTS_KEY)) return;
      const p = parseState(e.newValue);
      if (p) apply(p, false);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [apply]);

  const commit = useCallback(
    (fn: (s: WatchlistState) => WatchlistState) => {
      const next = fn(ref.current);
      if (next !== ref.current) apply(next, true);
    },
    [apply],
  );

  const act = activeList(state);
  const add = useCallback((s: string) => commit((st) => mapList(st, (c) => addSymbol(c, s))), [commit]);
  const remove = useCallback((s: string) => commit((st) => mapList(st, (c) => removeSymbol(c, s))), [commit]);
  const toggle = useCallback((s: string) => commit((st) => mapList(st, (c) => (c.includes(s) ? removeSymbol(c, s) : addSymbol(c, s)))), [commit]);
  const has = useCallback((s: string) => act.symbols.includes(s), [act]);
  const select = useCallback((id: string) => commit((st) => setActive(st, id)), [commit]);

  /** create / rename / delete return the outcome so the UI can show why it was refused; state commits only when ok */
  const op = useCallback(
    (fn: (s: WatchlistState) => OpResult): OpResult => {
      const res = fn(ref.current);
      if (res.ok) apply(res.state, true);
      return res;
    },
    [apply],
  );
  const create = useCallback((name: string) => op((s) => createList(s, name)), [op]);
  const rename = useCallback((id: string, name: string) => op((s) => renameList(s, id, name)), [op]);
  const del = useCallback((id: string) => op((s) => deleteList(s, id)), [op]);

  /** check / uncheck: put the symbol into (or take it out of) one specific list */
  const setIn = useCallback((id: string, sym: string, on: boolean) => commit((st) => mapList(st, (c) => (on ? addSymbol(c, sym) : removeSymbol(c, sym)), id)), [commit]);
  /** create a list (it becomes active) and put the symbol straight into it */
  const createWith = useCallback(
    (name: string, sym: string): OpResult => {
      const res = createList(ref.current, name);
      if (res.ok) apply(mapList(res.state, (c) => addSymbol(c, sym), res.id), true);
      return res;
    },
    [apply],
  );

  const all = useMemo(() => allSymbols(state), [state]);
  const allSet = useMemo(() => new Set(all), [all]);
  /** ★ state: the symbol is in ANY list */
  const inAny = useCallback((sym: string) => allSet.has(sym), [allSet]);
  return { setIn, createWith, inAny, lists: state.lists, activeId: act.id, activeName: act.name, list: act.symbols, all, select, add, remove, toggle, has, create, rename, del };
}
