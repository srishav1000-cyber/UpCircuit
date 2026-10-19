import { NextRequest } from 'next/server';
import { fetchQuoteRows } from '@/lib/yahooQuotes';
import type { YahooRow } from '@/lib/yahooData';
import { TtlCache, allow } from '@/lib/ttlCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYM = /^[A-Za-z0-9&._-]{1,24}$/;
const cache = new TtlCache<{ rows: YahooRow[]; via: string; at: number }>(8_000, 200);

/** GET /api/quotes?s=RELIANCE,TCS:NSE,SOMEBSE:BSE,NIFTY → REAL delayed Yahoo Finance quotes (no simulation). Missing symbols are omitted. */
export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get('s') ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 60);
  const wants = raw.map((x) => {
    const [symbol, e] = x.split(':');
    return { symbol: symbol.toUpperCase(), exch: e === 'BSE' ? ('BSE' as const) : ('NSE' as const) };
  });
  if (!wants.length || wants.some((w) => !SYM.test(w.symbol))) return Response.json({ ok: false, error: 'bad symbols' }, { status: 400 });
  const key = wants.map((w) => `${w.symbol}:${w.exch}`).sort().join(',');
  const hit = cache.get(key);
  if (hit) return Response.json({ ok: true, ...hit.value });
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!allow(`q:${ip}`, 90, 60_000)) return Response.json({ ok: false, error: 'rate limited' }, { status: 429 });
  const { rows, via } = await fetchQuoteRows(wants);
  const body = { rows, via, at: Date.now() };
  if (rows.length) cache.set(key, body);
  return Response.json({ ok: rows.length > 0, ...body }, { status: rows.length ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
