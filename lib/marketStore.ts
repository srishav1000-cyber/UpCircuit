// Server-only: Supabase (PostgREST) access to `market_ticks` with the SERVICE-ROLE key. The table has RLS enabled and no policies,
// so the browser (anon key) can never read or write it directly — everything goes through /api/market/* after verifying the user.
import { bearer, supabaseConfigured, whoami } from './serverAuth';
import { allow } from './ttlCache';
import type { TickRow } from './offmarketSimulation';
import { tradingDateOf } from './offmarketSimulation';

const base = () => (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
const svc = () => process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
export const storeConfigured = (): boolean => Boolean(base() && svc());
const H = (extra: Record<string, string> = {}) => ({ apikey: svc(), Authorization: `Bearer ${svc()}`, 'content-type': 'application/json', ...extra });

/** Same rule as /api/smartapi/session: a verified Supabase user, or SMARTAPI_SESSION_PUBLIC=1 on a private non-Supabase deployment. */
export async function authorize(req: Request, bucket: string, limit: number): Promise<{ ok: true; id: string } | { ok: false; status: number; reason: string }> {
  if (supabaseConfigured()) {
    const t = bearer(req);
    const u = t ? await whoami(t) : null;
    if (!u) return { ok: false, status: 401, reason: 'unauthorized' };
    if (!allow(`${bucket}:${u.id}`, limit, 60_000)) return { ok: false, status: 429, reason: 'rate_limited' };
    return { ok: true, id: u.id };
  }
  if (process.env.SMARTAPI_SESSION_PUBLIC !== '1') return { ok: false, status: 401, reason: 'unauthorized' };
  if (!allow(`${bucket}:public`, limit, 60_000)) return { ok: false, status: 429, reason: 'rate_limited' };
  return { ok: true, id: 'public' };
}

export async function insertTicks(rows: TickRow[]): Promise<{ ok: boolean; inserted: number }> {
  if (!rows.length) return { ok: true, inserted: 0 };
  const body = rows.map((r) => ({ symbol: r.symbol, ltp: r.ltp, high: r.high, low: r.low, volume: r.volume, ts: new Date(r.ts).toISOString(), trading_date: tradingDateOf(r.ts) }));
  try {
    const r = await fetch(`${base()}/rest/v1/market_ticks?on_conflict=symbol,ts`, {
      method: 'POST',
      headers: H({ Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: r.ok, inserted: r.ok ? rows.length : 0 };
  } catch {
    return { ok: false, inserted: 0 };
  }
}

interface DbRow { symbol: string; ltp: number; high: number; low: number; volume: number; ts: string }
const toRow = (d: DbRow): TickRow => ({ symbol: d.symbol, ltp: Number(d.ltp), high: Number(d.high), low: Number(d.low), volume: Number(d.volume), ts: Date.parse(d.ts) });

async function get(path: string): Promise<unknown[] | null> {
  try {
    const r = await fetch(`${base()}/rest/v1/${path}`, { headers: H(), signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    return r.ok ? ((await r.json()) as unknown[]) : null;
  } catch {
    return null;
  }
}

/** The most recent trading_date that has any logged tick. */
export async function latestDate(): Promise<string | null> {
  const r = (await get('market_ticks?select=trading_date&order=trading_date.desc&limit=1')) as { trading_date: string }[] | null;
  return r?.[0]?.trading_date ?? null;
}

/** Last `n` ticks (ascending) of one symbol on `date`. */
export async function lastTicks(symbol: string, date: string, n: number): Promise<TickRow[]> {
  const r = (await get(`market_ticks?select=symbol,ltp,high,low,volume,ts&symbol=eq.${encodeURIComponent(symbol)}&trading_date=eq.${date}&order=ts.desc&limit=${n}`)) as DbRow[] | null;
  return (r ?? []).map(toRow).reverse();
}

/** Every tick of `date`, symbol → time order, capped at `cap` rows (paged 1 000 at a time). */
export async function dayTicks(date: string, cap = 100_000): Promise<{ rows: TickRow[]; truncated: boolean } | null> {
  const rows: TickRow[] = [];
  for (let off = 0; off < cap; off += 1000) {
    const page = (await get(`market_ticks?select=symbol,ltp,high,low,volume,ts&trading_date=eq.${date}&order=symbol.asc,ts.asc&limit=1000&offset=${off}`)) as DbRow[] | null;
    if (!page) return off === 0 ? null : { rows, truncated: true };
    rows.push(...page.map(toRow));
    if (page.length < 1000) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
