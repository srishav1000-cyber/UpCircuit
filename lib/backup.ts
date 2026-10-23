// Portfolio & watchlist backup (JSON export) and "Force Sync Cloud State" (push this browser's cached state to Supabase).
import type { Holding } from './types';
import type { CloudClient, NotifyPrefs } from './cloud';
import { HOLDINGS_BASE, parseHoldings } from './holdingsStore';
import { DEFAULT_WATCHLIST, WATCHLISTS_KEY, defaultState, parseState, type WatchlistState } from './watchlist';
import { FOCUS_KEY, parseFocus } from './focus';

/** reads one logical storage key of the signed-in user (the caller binds `scoped()`), null when absent */
export type ReadKey = (base: string) => string | null;
export interface Snapshot { holdings: Holding[] | null; watchlists: WatchlistState | null; focus: string[] | null }

/** what this browser currently holds; `null` = never stored (as opposed to deliberately empty) */
export function readSnapshot(read: ReadKey): Snapshot {
  const h = read(HOLDINGS_BASE);
  const f = read(FOCUS_KEY);
  return { holdings: h === null ? null : parseHoldings(h), watchlists: parseState(read(WATCHLISTS_KEY)), focus: f === null ? null : parseFocus(f) };
}

export interface BackupFile {
  app: 'UpCircuit';
  version: 1;
  exportedAt: string;
  account: { id: string; email?: string; phone?: string };
  holdings: Holding[];
  watchlists: { active: string; lists: { id: string; name: string; symbols: string[] }[] };
  focus: string[];
  preferences: NotifyPrefs;
}
export function buildBackup(i: { user: { id: string; email?: string; phone?: string }; snap: Snapshot; prefs: NotifyPrefs; now?: Date }): BackupFile {
  const w = i.snap.watchlists ?? defaultState(DEFAULT_WATCHLIST); // never edited → the lists the app is showing (its defaults)
  return {
    app: 'UpCircuit',
    version: 1,
    exportedAt: (i.now ?? new Date()).toISOString(),
    account: { id: i.user.id, ...(i.user.email ? { email: i.user.email } : {}), ...(i.user.phone ? { phone: i.user.phone } : {}) },
    holdings: i.snap.holdings ?? [],
    watchlists: { active: w.active, lists: w.lists.map((l) => ({ id: l.id, name: l.name, symbols: [...l.symbols] })) },
    focus: i.snap.focus ?? [],
    preferences: i.prefs,
  };
}
export const backupFilename = (now = new Date()) => `upcircuit-backup-${now.toISOString().slice(0, 10)}.json`;

export interface ForceSyncResult { ok: boolean; holdings: number | null; watchlistSymbols: number | null; errors: string[] }
/** Push this browser's cached portfolio / watchlists / focus / preferences to the account. Parts never stored locally are skipped (never wipe the cloud with "nothing"). */
export async function forceSync(cloud: CloudClient, userId: string, snap: Snapshot, prefs: NotifyPrefs): Promise<ForceSyncResult> {
  const res: ForceSyncResult = { ok: true, holdings: null, watchlistSymbols: null, errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch { res.ok = false; res.errors.push(name); }
  };
  if (snap.holdings) await step('portfolio', async () => { await cloud.savePortfolio(userId, snap.holdings!); res.holdings = snap.holdings!.length; });
  if (snap.watchlists) await step('watchlists', async () => { await cloud.saveWatchlists(userId, snap.watchlists!); res.watchlistSymbols = snap.watchlists!.lists.reduce((n, l) => n + l.symbols.length, 0); });
  await step('preferences', () => cloud.savePrefs(userId, { notify: prefs, ...(snap.focus ? { focus: snap.focus } : {}) }));
  return res;
}
