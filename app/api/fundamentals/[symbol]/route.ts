import { NextRequest } from 'next/server';
import { fetchLiveFundamentals, type LiveFundamentals } from '@/lib/yahooFundamentals';
import { TtlCache, allow } from '@/lib/ttlCache';

// Node runtime: the Yahoo crumb flow needs the Set-Cookie header of the cookie request.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ok = new TtlCache<LiveFundamentals>(30 * 60_000, 600);
const miss = new TtlCache<true>(5 * 60_000, 600);
const SYMBOL = /^[A-Za-z0-9&._-]{1,24}$/;

/** GET /api/fundamentals/RELIANCE?exch=NSE → { ok, data } with REAL Yahoo Finance fundamentals; { ok:false } when Yahoo has none (client keeps its estimate). */
export async function GET(req: NextRequest, { params }: { params: { symbol: string } }) {
  const symbol = decodeURIComponent(params.symbol ?? '').toUpperCase();
  if (!SYMBOL.test(symbol)) return Response.json({ ok: false, error: 'bad symbol' }, { status: 400 });
  const exch = req.nextUrl.searchParams.get('exch') === 'BSE' ? 'BSE' : 'NSE';
  const key = `${symbol}:${exch}`;
  const hit = ok.get(key);
  if (hit) return Response.json({ ok: true, data: hit.value }, { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } });
  if (miss.get(key)) return Response.json({ ok: false, error: 'no data' }, { status: 404, headers: { 'Cache-Control': 'public, s-maxage=300' } });
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!allow(`fund:${ip}`, 60, 60_000)) return Response.json({ ok: false, error: 'rate limited' }, { status: 429 });
  const data = await fetchLiveFundamentals(symbol, exch);
  if (!data) {
    miss.set(key, true);
    return Response.json({ ok: false, error: 'no data' }, { status: 404 });
  }
  ok.set(key, data);
  return Response.json({ ok: true, data }, { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } });
}
