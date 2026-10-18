import { NextRequest } from 'next/server';
import { parseYahooSession, toYahooSymbol } from '@/lib/yahoo';
import { TtlCache, allow } from '@/lib/ttlCache';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const cache = new TtlCache<{ date: string; bars: unknown[] }>(30 * 60_000, 200);
const miss = new TtlCache<true>(5 * 60_000, 200);
const SYMBOL = /^[A-Za-z0-9&._-]{1,24}$/;
const json = (b: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(b, { status, headers: { 'Cache-Control': 'public, s-maxage=1800', ...extra } });

/** GET /api/session/RELIANCE?exch=NSE → the previous session's REAL 1-minute OHLCV bars from Yahoo Finance (for the off-market replay). */
export async function GET(req: NextRequest, { params }: { params: { symbol: string } }) {
  const symbol = decodeURIComponent(params.symbol ?? '').toUpperCase();
  if (!SYMBOL.test(symbol)) return json({ ok: false }, 400, { 'Cache-Control': 'no-store' });
  const exch = req.nextUrl.searchParams.get('exch') === 'BSE' ? 'BSE' : 'NSE';
  const key = `${symbol}:${exch}`;
  const hit = cache.get(key);
  if (hit) return json({ ok: true, ...hit.value });
  if (miss.get(key)) return json({ ok: false }, 404);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!allow(`sess:${ip}`, 40, 60_000)) return json({ ok: false }, 429, { 'Cache-Control': 'no-store' });
  const base = process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com';
  for (const e of exch === 'NSE' ? (['NSE', 'BSE'] as const) : (['BSE', 'NSE'] as const)) {
    try {
      const res = await fetch(`${base}/v8/finance/chart/${toYahooSymbol(symbol, e)}?interval=1m&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UpCircuit)', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const s = parseYahooSession(await res.json());
      if (s) {
        cache.set(key, s);
        return json({ ok: true, ...s });
      }
    } catch {
      /* try the other exchange */
    }
  }
  miss.set(key, true);
  return json({ ok: false }, 404);
}
