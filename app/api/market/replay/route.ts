import { NextRequest } from 'next/server';
import { authorize, latestDate, lastTicks, storeConfigured } from '@/lib/marketStore';
import { REPLAY_WINDOW } from '@/lib/offmarketSimulation';
import { TtlCache } from '@/lib/ttlCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { 'cache-control': 'no-store' } });
const dateCache = new TtlCache<string | null>(60_000, 2);

/**
 * GET /api/market/replay?s=RELIANCE,TCS
 * The closing stretch (last 60 ticks) of the most recent logged session, per symbol: { date, ticks: { SYM: [{ltp,high,low,volume,ts}] } }.
 * With no Supabase service role / no logged ticks it answers ok with an empty map so the client falls back to real 1-minute bars.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, 'mk-replay', 30);
  if (!a.ok) return json({ ok: false, reason: a.reason }, a.status);
  const syms = [...new Set((req.nextUrl.searchParams.get('s') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9&\-]{1,20}$/.test(s)))].slice(0, 20);
  if (!syms.length) return json({ ok: false, reason: 'no_symbols' }, 400);
  if (!storeConfigured()) return json({ ok: true, date: null, ticks: {}, source: 'none' });
  let date = dateCache.get('d')?.value;
  if (date === undefined) {
    date = await latestDate();
    dateCache.set('d', date);
  }
  if (!date) return json({ ok: true, date: null, ticks: {}, source: 'empty' });
  const out: Record<string, { ltp: number; high: number; low: number; volume: number; ts: number }[]> = {};
  await Promise.all(syms.map(async (s) => {
    const rows = await lastTicks(s, date!, REPLAY_WINDOW);
    if (rows.length) out[s] = rows.map(({ ltp, high, low, volume, ts }) => ({ ltp, high, low, volume, ts }));
  }));
  return json({ ok: true, date, ticks: out, source: 'supabase' });
}
