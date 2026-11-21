import { NextRequest } from 'next/server';
import { authorize, storeConfigured, symbolDayTicks } from '@/lib/marketStore';
import { allowAsync, TtlCache } from '@/lib/ttlCache';
import { assembleReplay, defaultReplayDate, isReplayDate, type ReplaySession } from '@/lib/sessionReplay';
import { toYahooSymbol, YAHOO_INDEX } from '@/lib/yahoo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { 'cache-control': 'no-store' } });
const SYM = /^[A-Z0-9&._-]{1,24}$/;
const BASE = () => process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; UpCircuit)' };
const yahooCache = new TtlCache<unknown>(120_000, 40);

async function yahoo1m(symbol: string): Promise<unknown | null> {
  const ys = YAHOO_INDEX[symbol] ? String(YAHOO_INDEX[symbol]) : toYahooSymbol(symbol);
  const hit = yahooCache.get(ys);
  if (hit) return hit.value;
  for (const s of [ys, ...(YAHOO_INDEX[symbol] || !ys.endsWith('.NS') ? [] : [toYahooSymbol(symbol, 'BSE')])]) {
    try {
      const r = await fetch(`${BASE()}/v8/finance/chart/${s}?interval=1m&range=5d`, { headers: HEADERS, signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue;
      const body = await r.json();
      if ((body as { chart?: { result?: unknown[] } })?.chart?.result?.length) { yahooCache.set(ys, body); return body; }
    } catch { /* try next venue */ }
  }
  return null;
}

/**
 * GET /api/market/session-replay?symbol=RELIANCE&date=YYYY-MM-DD[&band=5|10|20][&synthetic=1]
 * One recorded NSE session (09:15–15:30 IST) as precomputed frames + key moments. Read-only: never writes ticks, never touches live quotes.
 * Source order: persisted Supabase ticks (when configured, authorised and ≥ 30 minutes) → Yahoo 1-minute bars → (only with synthetic=1) a labelled synthetic session.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = (q.get('symbol') ?? '').trim().toUpperCase();
  if (!SYM.test(symbol)) return json({ ok: false, error: 'bad symbol' }, 400);
  const date = (q.get('date') ?? '') || defaultReplayDate(Date.now());
  if (!isReplayDate(date)) return json({ ok: false, error: 'bad date (YYYY-MM-DD)' }, 400);
  const bandN = Number(q.get('band'));
  const band = [5, 10, 20].includes(bandN) ? bandN : null;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!(await allowAsync(`sreplay:${ip}`, 30, 60_000))) return json({ ok: false, error: 'rate limited' }, 429);

  let ticks = null;
  if (storeConfigured()) {
    const a = await authorize(req, 'mk-session-replay', 30);
    if (a.ok) ticks = await symbolDayTicks(symbol, date);
  }
  const body = await yahoo1m(symbol);
  const res = assembleReplay({ symbol, date, ticks, yahooBody: body, band, allowSynthetic: q.get('synthetic') === '1' });
  if (!res.ok) return json({ ok: false, error: body ? 'no session for that date' : 'upstream unavailable', availableDates: res.availableDates, notes: res.notes, canUseSynthetic: true }, body ? 404 : 502);
  const s: ReplaySession = res.session;
  return json({ ok: true, session: s });
}
