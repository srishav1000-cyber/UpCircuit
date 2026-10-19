import { NextRequest } from 'next/server';
import { fetchBars } from '@/lib/yahooQuotes';
import { TF_CONFIG } from '@/lib/market';
import type { Candle, Timeframe } from '@/lib/types';
import { TtlCache, allow } from '@/lib/ttlCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYM = /^[A-Za-z0-9&._ -]{1,24}$/;
const cache = new TtlCache<Candle[]>(30_000, 300);

/** GET /api/bars/RELIANCE?tf=5m&exch=NSE → REAL Yahoo Finance OHLCV bars (IST-shifted seconds). Index ids (NIFTY, SENSEX, BANKNIFTY, INDIAVIX) work too. */
export async function GET(req: NextRequest, { params }: { params: { symbol: string } }) {
  const symbol = decodeURIComponent(params.symbol ?? '').toUpperCase();
  const tf = (req.nextUrl.searchParams.get('tf') ?? '1D') as Timeframe;
  if (!SYM.test(symbol) || !(tf in TF_CONFIG)) return Response.json({ ok: false, error: 'bad request' }, { status: 400 });
  const exch = req.nextUrl.searchParams.get('exch') === 'BSE' ? 'BSE' : 'NSE';
  const key = `${symbol}:${exch}:${tf}`;
  const hit = cache.get(key);
  if (hit) return Response.json({ ok: true, bars: hit.value });
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!allow(`bars:${ip}`, 120, 60_000)) return Response.json({ ok: false, error: 'rate limited' }, { status: 429 });
  const bars = await fetchBars({ symbol, exch }, tf);
  if (!bars.length) return Response.json({ ok: false, error: 'no data' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  cache.set(key, bars);
  return Response.json({ ok: true, bars }, { headers: { 'Cache-Control': 'no-store' } });
}
