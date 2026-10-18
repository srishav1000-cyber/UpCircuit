export const WATCHLIST_KEY = 'upcircuit:favorites'; // same key as the old ★ favourites — existing lists carry over
export const DEFAULT_WATCHLIST = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'SBIN'];
export const MAX_WATCHLIST = 100;

const clean = (a: unknown): string[] => {
  const out: string[] = [];
  if (Array.isArray(a)) for (const x of a) if (typeof x === 'string' && x && x.length <= 24 && !out.includes(x)) out.push(x);
  return out.slice(0, MAX_WATCHLIST);
};
export const parseWatchlist = (raw: string | null): string[] | null => {
  if (!raw) return null;
  try {
    return clean(JSON.parse(raw));
  } catch {
    return null;
  }
};
export const addSymbol = (list: string[], s: string) => (list.includes(s) || list.length >= MAX_WATCHLIST ? list : [...list, s]);
export const removeSymbol = (list: string[], s: string) => (list.includes(s) ? list.filter((x) => x !== s) : list);

/* ───────────── multi-tab named watchlists ───────────── */

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
}
export interface WatchlistState {
  lists: Watchlist[];
  active: string;
}
export const WATCHLISTS_KEY = 'upcircuit:watchlists:v2';
export const MAX_LISTS = 20;
export const MAX_NAME = 24;
export const PRESET_NAMES = ['Main', 'Today pick', 'future', 'monday hot'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list';

/** Default tabs. `main` carries over the legacy single list (key upcircuit:favorites) when given. */
export function defaultState(mainSymbols: string[] = DEFAULT_WATCHLIST): WatchlistState {
  const lists = PRESET_NAMES.map((name, i) => ({ id: slug(name), name, symbols: i === 0 ? clean(mainSymbols) : [] }));
  return { lists, active: lists[0].id };
}

export function parseState(raw: string | null): WatchlistState | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { lists?: unknown; active?: unknown };
    if (!Array.isArray(j.lists)) return null;
    const seen = new Set<string>();
    const lists: Watchlist[] = [];
    for (const l of j.lists as Partial<Watchlist>[]) {
      if (!l || typeof l.id !== 'string' || typeof l.name !== 'string' || seen.has(l.id) || !l.name.trim()) continue;
      seen.add(l.id);
      lists.push({ id: l.id, name: l.name.trim().slice(0, MAX_NAME), symbols: clean(l.symbols) });
      if (lists.length >= MAX_LISTS) break;
    }
    if (!lists.length) return null;
    return { lists, active: typeof j.active === 'string' && seen.has(j.active) ? j.active : lists[0].id };
  } catch {
    return null;
  }
}

export type OpResult = { state: WatchlistState; ok: true; id: string } | { state: WatchlistState; ok: false; reason: 'empty' | 'duplicate' | 'limit' | 'last' | 'missing' };
const nameTaken = (s: WatchlistState, name: string, exceptId?: string) => s.lists.some((l) => l.id !== exceptId && l.name.toLowerCase() === name.toLowerCase());

export function createList(s: WatchlistState, rawName: string): OpResult {
  const name = rawName.trim().slice(0, MAX_NAME);
  if (!name) return { state: s, ok: false, reason: 'empty' };
  if (nameTaken(s, name)) return { state: s, ok: false, reason: 'duplicate' };
  if (s.lists.length >= MAX_LISTS) return { state: s, ok: false, reason: 'limit' };
  let id = slug(name);
  for (let n = 2; s.lists.some((l) => l.id === id); n++) id = `${slug(name)}-${n}`;
  return { state: { lists: [...s.lists, { id, name, symbols: [] }], active: id }, ok: true, id };
}
export function renameList(s: WatchlistState, id: string, rawName: string): OpResult {
  const name = rawName.trim().slice(0, MAX_NAME);
  if (!s.lists.some((l) => l.id === id)) return { state: s, ok: false, reason: 'missing' };
  if (!name) return { state: s, ok: false, reason: 'empty' };
  if (nameTaken(s, name, id)) return { state: s, ok: false, reason: 'duplicate' };
  return { state: { ...s, lists: s.lists.map((l) => (l.id === id ? { ...l, name } : l)) }, ok: true, id };
}
export function deleteList(s: WatchlistState, id: string): OpResult {
  const i = s.lists.findIndex((l) => l.id === id);
  if (i < 0) return { state: s, ok: false, reason: 'missing' };
  if (s.lists.length <= 1) return { state: s, ok: false, reason: 'last' };
  const lists = s.lists.filter((l) => l.id !== id);
  return { state: { lists, active: s.active === id ? lists[Math.max(0, i - 1)].id : s.active }, ok: true, id };
}
export const setActive = (s: WatchlistState, id: string): WatchlistState => (s.active === id || !s.lists.some((l) => l.id === id) ? s : { ...s, active: id });
/** Apply a symbol-list transform to ONE list (default: the active one). */
export const mapList = (s: WatchlistState, fn: (c: string[]) => string[], id = s.active): WatchlistState => {
  const cur = s.lists.find((l) => l.id === id);
  if (!cur) return s;
  const next = fn(cur.symbols);
  return next === cur.symbols ? s : { ...s, lists: s.lists.map((l) => (l.id === id ? { ...l, symbols: next } : l)) };
};
export const activeList = (s: WatchlistState): Watchlist => s.lists.find((l) => l.id === s.active) ?? s.lists[0];
export const allSymbols = (s: WatchlistState): string[] => Array.from(new Set(s.lists.flatMap((l) => l.symbols)));
