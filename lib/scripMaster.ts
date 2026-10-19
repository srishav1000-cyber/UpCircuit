// Server-only: ticker → SmartAPI { token, exchangeType } from Angel's public scrip master (no auth needed). Mirrors scripts/sync-instruments.mjs.
import { ExchangeType } from './smartapi';

export const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
export interface Listing { token: string; exchangeType: number }
interface Row { token: string; symbol: string; exch_seg: string; name: string; instrumenttype?: string }

/** NSE cash rows ("RELIANCE-EQ", keyed by `name`) win; BSE cash rows (keyed by `symbol`) are added for BSE-only names. BSE layout UNVERIFIED on a live feed. */
export function buildListings(rows: Row[]): Map<string, Listing> {
  const m = new Map<string, Listing>();
  for (const r of rows) if (r.exch_seg === 'NSE' && /-(EQ|BE|BZ|SM|ST)$/.test(r.symbol) && !r.instrumenttype) m.set(r.name.toUpperCase(), { token: r.token, exchangeType: ExchangeType.NSE_CM });
  for (const r of rows) if (r.exch_seg === 'BSE' && !r.instrumenttype && /^[A-Z][A-Z0-9&-]{0,19}$/.test(r.symbol) && !m.has(r.symbol)) m.set(r.symbol, { token: r.token, exchangeType: ExchangeType.BSE_CM });
  return m;
}

let cache: { at: number; map: Map<string, Listing> } | null = null;
let loading: Promise<Map<string, Listing>> | null = null;
const TTL = 12 * 3600_000;

export async function loadListings(f: typeof fetch = fetch): Promise<Map<string, Listing>> {
  if (cache && Date.now() - cache.at < TTL) return cache.map;
  loading ??= (async () => {
    const res = await f(process.env.SMARTAPI_SCRIP_MASTER_URL || SCRIP_MASTER_URL, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error('scrip master ' + res.status);
    const map = buildListings((await res.json()) as Row[]);
    cache = { at: Date.now(), map };
    return map;
  })().finally(() => (loading = null));
  return loading;
}
