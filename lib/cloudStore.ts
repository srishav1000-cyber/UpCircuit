// Supabase PostgREST access for the user's own data (portfolio, watchlists, focus basket, notification prefs, circuit-alert history,
// push subscriptions). Plain fetch + the user's access token — RLS ("Users access own data", docs/PERSISTENCE_SCHEMA.sql) is the security boundary.
import type { Holding } from './types';
import { MAX_NAME, defaultState, slug, type WatchlistState } from './watchlist';
import type { CircuitDir } from './circuit';

export interface CloudCtx {
  base: string;
  anon: string;
  token: string;
  userId: string;
  f?: typeof fetch;
}
export class CloudError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call(ctx: CloudCtx, method: string, path: string, body?: unknown, prefer?: string): Promise<unknown> {
  const f = ctx.f ?? fetch;
  const r = await f(`${ctx.base.replace(/\/+$/, '')}/rest/v1/${path}`, {
    method,
    headers: { apikey: ctx.anon, Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new CloudError(r.status, `${method} ${path.split('?')[0]} → ${r.status}`);
  if (r.status === 204) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const inList = (xs: string[]) => `in.(${xs.map((x) => `"${x.replace(/["\\]/g, '')}"`).join(',')})`;

/* ───────────── preferences row (focus, per-collection "has been synced" markers, watchlist order, notification toggles) ───────────── */

export interface PrefsRow {
  focus: string[];
  focus_synced: boolean;
  portfolio_synced: boolean;
  watchlist_synced: boolean;
  watchlist_meta: { order: string[]; active: string } | null;
  notify_push: boolean;
  notify_email: boolean;
  notify_audio: boolean;
}
export async function getPrefs(ctx: CloudCtx): Promise<Partial<PrefsRow> | null> {
  const rows = (await call(ctx, 'GET', `preferences?${q({ user_id: `eq.${ctx.userId}`, select: '*' })}`)) as Partial<PrefsRow>[] | null;
  return rows?.[0] ?? null;
}
export async function setPrefs(ctx: CloudCtx, patch: Partial<PrefsRow>): Promise<void> {
  await call(ctx, 'POST', `preferences?on_conflict=user_id`, [{ user_id: ctx.userId, ...patch, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
}

/* ───────────── portfolio ───────────── */

export interface PortfolioRow { symbol: string; quantity: number; buy_price: number; sector?: string | null }
export const holdingsToRows = (userId: string, hs: Holding[]) => hs.map((h) => ({ user_id: userId, symbol: h.symbol, quantity: h.qty, buy_price: h.avg, sector: null as string | null }));
export function rowsToHoldings(rows: PortfolioRow[]): Holding[] {
  const out: Holding[] = [];
  for (const r of rows) {
    const qty = Number(r.quantity), avg = Number(r.buy_price);
    if (typeof r.symbol === 'string' && r.symbol && Number.isFinite(qty) && qty > 0 && Number.isFinite(avg) && avg > 0) out.push({ symbol: r.symbol, qty, avg });
  }
  return out;
}
export async function pullPortfolio(ctx: CloudCtx): Promise<Holding[] | null> {
  if (!(await getPrefs(ctx))?.portfolio_synced) return null; // never pushed from any device → let the caller seed the cloud from local
  const rows = (await call(ctx, 'GET', `portfolios?${q({ user_id: `eq.${ctx.userId}`, select: 'symbol,quantity,buy_price,sector', order: 'created_at.asc' })}`)) as PortfolioRow[] | null;
  return rowsToHoldings(rows ?? []);
}
export async function pushPortfolio(ctx: CloudCtx, hs: Holding[]): Promise<void> {
  const existing = ((await call(ctx, 'GET', `portfolios?${q({ user_id: `eq.${ctx.userId}`, select: 'symbol' })}`)) as { symbol: string }[] | null) ?? [];
  const keep = new Set(hs.map((h) => h.symbol));
  const stale = existing.map((e) => e.symbol).filter((s) => !keep.has(s));
  if (hs.length) await call(ctx, 'POST', `portfolios?on_conflict=user_id,symbol`, holdingsToRows(ctx.userId, hs), 'resolution=merge-duplicates,return=minimal');
  if (stale.length) await call(ctx, 'DELETE', `portfolios?${q({ user_id: `eq.${ctx.userId}`, symbol: inList(stale) })}`);
  await setPrefs(ctx, { portfolio_synced: true });
}

/* ───────────── watchlists (one row per list × symbol; list order + active list live in preferences.watchlist_meta) ───────────── */

export interface WatchRow { id?: string; list_name: string; symbol: string; position?: number }
export function stateToRows(userId: string, s: WatchlistState) {
  return s.lists.flatMap((l) => l.symbols.map((symbol, i) => ({ user_id: userId, list_name: l.name, symbol, position: i })));
}
/** null when the cloud holds nothing at all for this user (so the caller seeds it from local) */
export function rowsToState(rows: WatchRow[], meta: { order?: string[]; active?: string } | null): WatchlistState | null {
  const bySym = new Map<string, WatchRow[]>();
  for (const r of rows) {
    if (!r.list_name || !r.symbol) continue;
    (bySym.get(r.list_name) ?? bySym.set(r.list_name, []).get(r.list_name)!).push(r);
  }
  const names = [...(meta?.order ?? []).filter((n) => typeof n === 'string' && n.trim()), ...bySym.keys()].filter((n, i, a) => a.indexOf(n) === i);
  if (!names.length) return null;
  const used = new Set<string>();
  const lists = names.map((name) => {
    let id = slug(name);
    for (let n = 2; used.has(id); n++) id = `${slug(name)}-${n}`;
    used.add(id);
    const syms = (bySym.get(name) ?? []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((r) => r.symbol);
    return { id, name: name.slice(0, MAX_NAME), symbols: [...new Set(syms)] };
  });
  const act = lists.find((l) => l.name === meta?.active) ?? lists[0];
  return { lists, active: act.id };
}
/** identity of a watchlist state that ignores the locally generated ids */
export const watchSig = (s: WatchlistState): string => JSON.stringify({ l: s.lists.map((x) => [x.name, x.symbols]), a: s.lists.find((x) => x.id === s.active)?.name ?? '' });
export async function pullWatchlists(ctx: CloudCtx): Promise<WatchlistState | null> {
  const prefs = await getPrefs(ctx);
  if (!prefs?.watchlist_synced) return null;
  const rows = ((await call(ctx, 'GET', `watchlists?${q({ user_id: `eq.${ctx.userId}`, select: 'list_name,symbol,position', order: 'position.asc' })}`)) as WatchRow[] | null) ?? [];
  return rowsToState(rows, prefs.watchlist_meta ?? null) ?? defaultStateEmpty();
}
const defaultStateEmpty = (): WatchlistState => ({ ...defaultState([]) });
export async function pushWatchlists(ctx: CloudCtx, s: WatchlistState): Promise<void> {
  const want = stateToRows(ctx.userId, s);
  const key = (l: string, y: string) => `${l}\u0000${y}`;
  const wantKeys = new Set(want.map((r) => key(r.list_name, r.symbol)));
  const existing = ((await call(ctx, 'GET', `watchlists?${q({ user_id: `eq.${ctx.userId}`, select: 'id,list_name,symbol' })}`)) as WatchRow[] | null) ?? [];
  const stale = existing.filter((r) => !wantKeys.has(key(r.list_name, r.symbol)) && r.id).map((r) => r.id as string);
  if (want.length) await call(ctx, 'POST', `watchlists?on_conflict=user_id,list_name,symbol`, want, 'resolution=merge-duplicates,return=minimal');
  if (stale.length) await call(ctx, 'DELETE', `watchlists?${q({ user_id: `eq.${ctx.userId}`, id: inList(stale) })}`);
  await setPrefs(ctx, { watchlist_synced: true, watchlist_meta: { order: s.lists.map((l) => l.name), active: s.lists.find((l) => l.id === s.active)?.name ?? s.lists[0]?.name ?? '' } });
}

/* ───────────── focus basket ───────────── */

export async function pullFocus(ctx: CloudCtx): Promise<string[] | null> {
  const p = await getPrefs(ctx);
  return p?.focus_synced ? (p.focus ?? []) : null;
}
export const pushFocus = (ctx: CloudCtx, focus: string[]) => setPrefs(ctx, { focus, focus_synced: true });

/* ───────────── notification toggles ───────────── */

export interface NotifyPrefs { push: boolean; email: boolean; audio: boolean }
export async function pullNotify(ctx: CloudCtx): Promise<NotifyPrefs | null> {
  const p = await getPrefs(ctx);
  if (!p || (p.notify_push === undefined && p.notify_email === undefined && p.notify_audio === undefined)) return null;
  return { push: p.notify_push !== false, email: p.notify_email !== false, audio: p.notify_audio !== false };
}
export const pushNotify = (ctx: CloudCtx, n: NotifyPrefs) => setPrefs(ctx, { notify_push: n.push, notify_email: n.email, notify_audio: n.audio });

/* ───────────── circuit-alert history ───────────── */

export interface AlertRecord { symbol: string; dir: CircuitDir; band: number; price: number; at: number }
interface AlertRow { symbol: string; direction: string; band: number; price: number; triggered_at: string }
/**
 * Insert one alert. The table has a unique (user, symbol, direction, band, trading day) index, so a second device detecting the same hit
 * inserts nothing. Returns true only when THIS call created the row — callers use that to send the e-mail / push exactly once per hit.
 */
export async function insertAlert(ctx: CloudCtx, a: AlertRecord): Promise<boolean> {
  const rows = (await call(
    ctx,
    'POST',
    `alert_history?on_conflict=user_id,symbol,direction,band,trading_date`,
    [{ user_id: ctx.userId, symbol: a.symbol, direction: a.dir === 'upper' ? 'UPPER' : 'LOWER', band: a.band, price: a.price, triggered_at: new Date(a.at).toISOString() }],
    'resolution=ignore-duplicates,return=representation',
  )) as unknown[] | null;
  return Array.isArray(rows) && rows.length > 0;
}
export async function loadAlerts(ctx: CloudCtx, limit = 200): Promise<AlertRecord[]> {
  const rows = ((await call(ctx, 'GET', `alert_history?${q({ user_id: `eq.${ctx.userId}`, select: 'symbol,direction,band,price,triggered_at', order: 'triggered_at.desc', limit: String(limit) })}`)) as AlertRow[] | null) ?? [];
  return rows
    .filter((r) => (r.direction === 'UPPER' || r.direction === 'LOWER') && Number.isFinite(Number(r.price)))
    .map((r) => ({ symbol: r.symbol, dir: (r.direction === 'UPPER' ? 'upper' : 'lower') as CircuitDir, band: Number(r.band), price: Number(r.price), at: Date.parse(r.triggered_at) }));
}

/* ───────────── web-push subscriptions ───────────── */

export interface PushSubJSON { endpoint: string; keys: { p256dh: string; auth: string } }
export async function saveSubscription(ctx: CloudCtx, s: PushSubJSON): Promise<void> {
  await call(ctx, 'POST', `push_subscriptions?on_conflict=endpoint`, [{ user_id: ctx.userId, endpoint: s.endpoint, keys: s.keys }], 'resolution=merge-duplicates,return=minimal');
}
export async function deleteSubscription(ctx: CloudCtx, endpoint: string): Promise<void> {
  await call(ctx, 'DELETE', `push_subscriptions?${q({ user_id: `eq.${ctx.userId}`, endpoint: `eq.${endpoint}` })}`);
}
export async function listSubscriptions(ctx: CloudCtx): Promise<PushSubJSON[]> {
  const rows = ((await call(ctx, 'GET', `push_subscriptions?${q({ user_id: `eq.${ctx.userId}`, select: 'endpoint,keys' })}`)) as PushSubJSON[] | null) ?? [];
  return rows.filter((r) => r.endpoint && r.keys?.p256dh && r.keys?.auth);
}
