// Cloud persistence over Supabase PostgREST (plain fetch, no SDK). Every call carries the user's access token, so Row Level Security
// (docs/PERSISTENCE_SCHEMA.sql) confines it to that user's rows. Saves are UPSERT-then-delete: a failed save never loses the previous data.
import type { Holding } from './types';
import type { WatchlistState } from './watchlist';

export interface CloudConfig {
  url: string;
  anonKey: string;
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** every REST call reports its outcome (drives the 🟢 Supabase Synced / 🟡 Local Cache Only badge) */
  onResult?: (ok: boolean) => void;
}
/** Everything in `preferences.notify` (one jsonb blob, one sync path): alert channels + alarm sound + startup screen + density. */
export type AlarmSound = 'default' | 'arpeggio';
export type Landing = 'home' | 'terminal';
export type Density = 'comfortable' | 'compact';
export interface NotifyPrefs { push: boolean; email: boolean; audio: boolean; sound: AlarmSound; volume: number; landing: Landing; density: Density }
export const DEFAULT_NOTIFY: NotifyPrefs = { push: false, email: true, audio: true, sound: 'default', volume: 1, landing: 'home', density: 'comfortable' };
export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
export interface AlertRow { symbol: string; direction: 'UPPER' | 'LOWER'; band: number; price: number; triggered_at: string }

/* ───────────── pure row mapping (unit-tested) ───────────── */

const SYM = /^[A-Za-z0-9&._-]{1,24}$/;
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);

export function holdingsToRows(userId: string, holdings: Holding[], sectorOf?: (s: string) => string | undefined) {
  const seen = new Set<string>();
  const rows: { user_id: string; symbol: string; quantity: number; buy_price: number; sector: string | null }[] = [];
  for (const h of holdings) {
    const symbol = h.symbol.trim().toUpperCase();
    if (!SYM.test(symbol) || seen.has(symbol) || !(h.qty > 0) || !(h.avg > 0)) continue; // un-priced demo rows (avg 0) are not user data
    seen.add(symbol);
    rows.push({ user_id: userId, symbol, quantity: h.qty, buy_price: h.avg, sector: sectorOf?.(symbol) ?? null });
  }
  return rows;
}
export function rowsToHoldings(rows: unknown): Holding[] {
  if (!Array.isArray(rows)) return [];
  const out: Holding[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const qty = num(r.quantity), avg = num(r.buy_price);
    if (typeof r.symbol === 'string' && SYM.test(r.symbol) && qty && qty > 0 && avg && avg > 0) out.push({ symbol: r.symbol, qty, avg });
  }
  return out;
}

export function watchlistsToRows(userId: string, st: WatchlistState) {
  const rows: { user_id: string; list_id: string; symbol: string; position: number }[] = [];
  for (const l of st.lists) l.symbols.forEach((symbol, position) => { if (SYM.test(symbol)) rows.push({ user_id: userId, list_id: l.id, symbol, position }); });
  return rows;
}
export const watchlistMeta = (st: WatchlistState) => ({ lists: st.lists.map((l) => ({ id: l.id, name: l.name })), active: st.active });
/** Rebuild the app's WatchlistState from cloud rows + meta; null when the cloud holds nothing usable. */
export function rowsToWatchlists(rows: unknown, meta: unknown): WatchlistState | null {
  const m = meta as { lists?: unknown; active?: unknown } | null;
  const lists: WatchlistState['lists'] = [];
  if (m && Array.isArray(m.lists)) for (const l of m.lists as { id?: unknown; name?: unknown }[]) if (l && typeof l.id === 'string' && typeof l.name === 'string' && !lists.some((x) => x.id === l.id)) lists.push({ id: l.id, name: l.name, symbols: [] });
  const byList = new Map<string, { symbol: string; position: number }[]>();
  if (Array.isArray(rows)) for (const r of rows as Record<string, unknown>[]) if (typeof r.list_id === 'string' && typeof r.symbol === 'string' && SYM.test(r.symbol)) byList.set(r.list_id, [...(byList.get(r.list_id) ?? []), { symbol: r.symbol, position: num(r.position) ?? 0 }]);
  for (const [id, items] of byList) if (!lists.some((l) => l.id === id)) lists.push({ id, name: id === 'main' ? 'Main' : id, symbols: [] });
  if (!lists.length) return null;
  for (const l of lists) l.symbols = (byList.get(l.id) ?? []).sort((a, b) => a.position - b.position).map((x) => x.symbol);
  const active = m && typeof m.active === 'string' && lists.some((l) => l.id === m.active) ? (m.active as string) : lists[0].id;
  return { lists, active };
}

export function parseNotify(x: unknown): NotifyPrefs {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const D = DEFAULT_NOTIFY;
  const vol = typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0.1, Math.round(o.volume * 100) / 100)) : D.volume;
  return {
    push: typeof o.push === 'boolean' ? o.push : D.push,
    email: typeof o.email === 'boolean' ? o.email : D.email,
    audio: typeof o.audio === 'boolean' ? o.audio : D.audio,
    sound: o.sound === 'arpeggio' ? 'arpeggio' : D.sound,
    volume: vol,
    landing: o.landing === 'terminal' ? 'terminal' : D.landing,
    density: o.density === 'compact' ? 'compact' : D.density,
  };
}

/** PostgREST `in.(…)` list with each value double-quoted (symbols may contain & . -) */
const enc = encodeURIComponent;
export const inList = (vals: string[]) => `(${vals.map((v) => `"${v.replace(/"/g, '')}"`).join(',')})`;

/* ───────────── REST client ───────────── */

export type CloudClient = ReturnType<typeof createCloud>;
export function createCloud(cfg: CloudConfig) {
  const base = cfg.url.replace(/\/+$/, '');
  const f = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  async function call(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<unknown> {
    const t = await cfg.getToken();
    if (!t) throw new Error('not signed in');
    const r = await f(`${base}/rest/v1/${path}`, {
      method: init.method ?? 'GET',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }).catch((e) => { cfg.onResult?.(false); throw e; });
    if (!r.ok) { cfg.onResult?.(false); throw new Error(`cloud ${r.status}`); }
    cfg.onResult?.(true);
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }
  const uid = (id: string) => `user_id=eq.${encodeURIComponent(id)}`;
  return {
    async loadPortfolio(userId: string): Promise<Holding[]> {
      return rowsToHoldings(await call(`portfolios?${uid(userId)}&select=symbol,quantity,buy_price&order=created_at.asc`));
    },
    async savePortfolio(userId: string, holdings: Holding[], sectorOf?: (s: string) => string | undefined): Promise<void> {
      const rows = holdingsToRows(userId, holdings, sectorOf);
      if (rows.length) await call('portfolios?on_conflict=user_id,symbol', { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
      const gone = rows.length ? `&symbol=not.in.${enc(inList(rows.map((r) => r.symbol)))}` : '';
      await call(`portfolios?${uid(userId)}${gone}`, { method: 'DELETE', prefer: 'return=minimal' });
    },
    async loadWatchlists(userId: string): Promise<WatchlistState | null> {
      const [rows, prefs] = await Promise.all([call(`watchlists?${uid(userId)}&select=list_id,symbol,position`), call(`preferences?${uid(userId)}&select=watchlist_meta`)]);
      return rowsToWatchlists(rows, (prefs as { watchlist_meta?: unknown }[] | null)?.[0]?.watchlist_meta ?? null);
    },
    async saveWatchlists(userId: string, st: WatchlistState): Promise<void> {
      const rows = watchlistsToRows(userId, st);
      if (rows.length) await call('watchlists?on_conflict=user_id,list_id,symbol', { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
      // remove (list, symbol) pairs that are gone: per list, delete symbols not in its current set; lists that no longer exist are dropped whole
      for (const l of st.lists) {
        const gone = l.symbols.length ? `&symbol=not.in.${enc(inList(l.symbols))}` : '';
        await call(`watchlists?${uid(userId)}&list_id=eq.${encodeURIComponent(l.id)}${gone}`, { method: 'DELETE', prefer: 'return=minimal' });
      }
      await call(`watchlists?${uid(userId)}&list_id=not.in.${enc(inList(st.lists.map((l) => l.id)))}`, { method: 'DELETE', prefer: 'return=minimal' });
      await call('preferences?on_conflict=user_id', { method: 'POST', body: [{ user_id: userId, watchlist_meta: watchlistMeta(st), updated_at: new Date().toISOString() }], prefer: 'resolution=merge-duplicates,return=minimal' });
    },
    async loadPrefs(userId: string): Promise<{ focus: string[] | null; notify: NotifyPrefs | null }> {
      const r = ((await call(`preferences?${uid(userId)}&select=focus,notify`)) as { focus?: unknown; notify?: unknown }[] | null)?.[0];
      if (!r) return { focus: null, notify: null };
      return { focus: Array.isArray(r.focus) ? (r.focus as unknown[]).filter((x): x is string => typeof x === 'string') : null, notify: r.notify ? parseNotify(r.notify) : null };
    },
    async savePrefs(userId: string, p: { focus?: string[]; notify?: NotifyPrefs }): Promise<void> {
      await call('preferences?on_conflict=user_id', { method: 'POST', body: [{ user_id: userId, ...(p.focus ? { focus: p.focus } : {}), ...(p.notify ? { notify: p.notify } : {}), updated_at: new Date().toISOString() }], prefer: 'resolution=merge-duplicates,return=minimal' });
    },
    /** Settings → Cloud & Data → "Reset cloud data": removes this account's portfolio, watchlists, preferences and alert history (profile and push devices stay) */
    async resetAccountData(userId: string): Promise<void> {
      for (const t of ['portfolios', 'watchlists', 'alert_history', 'preferences']) await call(`${t}?${uid(userId)}`, { method: 'DELETE', prefer: 'return=minimal' });
    },
    async logAlert(userId: string, a: Omit<AlertRow, 'triggered_at'> & { at?: number }): Promise<void> {
      await call('alert_history', { method: 'POST', body: [{ user_id: userId, symbol: a.symbol, direction: a.direction, band: a.band, price: a.price, triggered_at: new Date(a.at ?? Date.now()).toISOString() }], prefer: 'return=minimal' });
    },
    async recentAlerts(userId: string, limit = 50): Promise<AlertRow[]> {
      const rows = (await call(`alert_history?${uid(userId)}&select=symbol,direction,band,price,triggered_at&order=triggered_at.desc&limit=${limit}`)) as AlertRow[] | null;
      return Array.isArray(rows) ? rows : [];
    },
    async savePushSubscription(userId: string, s: PushSub): Promise<void> {
      await call('push_subscriptions?on_conflict=user_id,endpoint', { method: 'POST', body: [{ user_id: userId, endpoint: s.endpoint, keys: s.keys }], prefer: 'resolution=merge-duplicates,return=minimal' });
    },
    async deletePushSubscription(userId: string, endpoint: string): Promise<void> {
      await call(`push_subscriptions?${uid(userId)}&endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE', prefer: 'return=minimal' });
    },
    async hasPushSubscription(userId: string, endpoint: string): Promise<boolean> {
      const r = (await call(`push_subscriptions?${uid(userId)}&endpoint=eq.${encodeURIComponent(endpoint)}&select=id`)) as unknown[] | null;
      return Array.isArray(r) && r.length > 0;
    },
  };
}
