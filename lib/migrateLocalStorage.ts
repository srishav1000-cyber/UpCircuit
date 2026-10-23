// One-time move of pre-cloud data (portfolio, watchlists, focus basket) from this browser into the user's Supabase account.
// Safety rules: never overwrite cloud data (only fills what the cloud lacks); purge a local key ONLY after its upload succeeded;
// a failure leaves everything in place so the next login retries.
import type { Holding } from './types';
import type { CloudClient } from './cloud';
import { parseHoldings } from './holdingsStore';
import { WATCHLIST_KEY, WATCHLISTS_KEY, defaultState, parseState, parseWatchlist, type WatchlistState } from './watchlist';
import { FOCUS_KEY, parseFocus } from './focus';

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
/** the keys named in the migration spec (and used by the very first builds) */
export const LEGACY_PORTFOLIO_KEY = 'upcircuit_portfolio';
export const LEGACY_WATCHLIST_KEY = 'upcircuit_watchlist';
export const HOLDINGS_KEY = 'upcircuit:holdings:v1';
const migratedKey = (uid: string) => `upcircuit:cloud-migrated:${uid}`;

export interface MigrationReport { holdings: number; watchlistSymbols: number; focus: number; purged: string[]; errors: string[]; skipped: boolean }

export async function migrateLocalStorage(cloud: CloudClient, userId: string, store: KV): Promise<MigrationReport> {
  const rep: MigrationReport = { holdings: 0, watchlistSymbols: 0, focus: 0, purged: [], errors: [], skipped: false };
  if (store.getItem(migratedKey(userId)) === '1') return { ...rep, skipped: true };
  const purge = (keys: string[]) => keys.forEach((k) => { if (store.getItem(k) !== null) { store.removeItem(k); rep.purged.push(k); } });

  /* portfolio */
  try {
    const keys = [LEGACY_PORTFOLIO_KEY, HOLDINGS_KEY, `${HOLDINGS_KEY}:${userId}`];
    const local = keys.map((k) => ({ k, h: parseHoldings(store.getItem(k)) })).filter((x) => x.h.length);
    const cloudRows = await cloud.loadPortfolio(userId);
    if (local.length && !cloudRows.length) {
      const merged: Holding[] = [];
      for (const { h } of local) for (const x of h) if (!merged.some((m) => m.symbol === x.symbol)) merged.push(x);
      await cloud.savePortfolio(userId, merged);
      rep.holdings = merged.length;
    }
    // legacy / unscoped keys are cleaned once the cloud holds the data (just uploaded, or already there); the scoped cache stays as the offline copy
    if (cloudRows.length || rep.holdings) purge([LEGACY_PORTFOLIO_KEY, HOLDINGS_KEY]);
  } catch {
    rep.errors.push('portfolio');
  }

  /* watchlists */
  try {
    const candidates: WatchlistState[] = [];
    for (const k of [`${WATCHLISTS_KEY}:${userId}`, WATCHLISTS_KEY]) { const s = parseState(store.getItem(k)); if (s) candidates.push(s); }
    for (const k of [LEGACY_WATCHLIST_KEY, WATCHLIST_KEY, `${WATCHLIST_KEY}:${userId}`]) { const l = parseWatchlist(store.getItem(k)); if (l?.length) candidates.push(defaultState(l)); }
    const local = candidates.find((s) => s.lists.some((l) => l.symbols.length));
    const cloudState = await cloud.loadWatchlists(userId);
    const cloudHas = !!cloudState && cloudState.lists.some((l) => l.symbols.length);
    if (local && !cloudHas) {
      await cloud.saveWatchlists(userId, local);
      rep.watchlistSymbols = local.lists.reduce((n, l) => n + l.symbols.length, 0);
    }
    if (cloudHas || rep.watchlistSymbols) purge([LEGACY_WATCHLIST_KEY, WATCHLIST_KEY, WATCHLISTS_KEY]);
  } catch {
    rep.errors.push('watchlists');
  }

  /* focus basket */
  try {
    const local = parseFocus(store.getItem(`${FOCUS_KEY}:${userId}`));
    const prefs = await cloud.loadPrefs(userId);
    if (local.length && !(prefs.focus && prefs.focus.length)) {
      await cloud.savePrefs(userId, { focus: local });
      rep.focus = local.length;
    }
  } catch {
    rep.errors.push('focus');
  }

  if (!rep.errors.length) store.setItem(migratedKey(userId), '1');
  return rep;
}
