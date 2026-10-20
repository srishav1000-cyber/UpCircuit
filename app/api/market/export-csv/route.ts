import { NextRequest } from 'next/server';
import { authorize, dayTicks, latestDate, storeConfigured } from '@/lib/marketStore';
import { rowsToCsv } from '@/lib/offmarketSimulation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/market/export-csv[?date=YYYY-MM-DD]  → text/csv  (Symbol,LTP,High,Low,Volume,Timestamp)
 * The persisted SmartAPI ticks of one trading day (default: the latest logged day). Needs a verified user; capped at 100 000 rows.
 */
export async function GET(req: NextRequest) {
  const fail = (b: unknown, status: number) => Response.json(b, { status, headers: { 'cache-control': 'no-store' } });
  const a = await authorize(req, 'mk-csv', 6);
  if (!a.ok) return fail({ ok: false, reason: a.reason }, a.status);
  if (!storeConfigured()) return fail({ ok: false, reason: 'not_configured', message: 'Set SUPABASE_SERVICE_ROLE_KEY and run docs/MARKET_TICKS.sql.' }, 501);
  const q = req.nextUrl.searchParams.get('date');
  if (q && !/^\d{4}-\d{2}-\d{2}$/.test(q)) return fail({ ok: false, reason: 'bad_date' }, 400);
  const date = q ?? (await latestDate());
  if (!date) return fail({ ok: false, reason: 'no_data', message: 'No ticks have been logged yet.' }, 404);
  const d = await dayTicks(date);
  if (!d) return fail({ ok: false, reason: 'store_unreachable' }, 502);
  if (!d.rows.length) return fail({ ok: false, reason: 'no_data', message: `No ticks logged for ${date}.` }, 404);
  return new Response(rowsToCsv(d.rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="upcircuit-ticks-${date}.csv"`,
      'cache-control': 'no-store',
      ...(d.truncated ? { 'x-truncated': '1' } : {}),
    },
  });
}
