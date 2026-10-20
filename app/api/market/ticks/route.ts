import { NextRequest } from 'next/server';
import { authorize, insertTicks, storeConfigured } from '@/lib/marketStore';
import { validateRows } from '@/lib/offmarketSimulation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { 'cache-control': 'no-store' } });

/**
 * POST /api/market/ticks  { rows: [{ symbol, ltp, high, low, volume, ts }] }
 * Persists REAL SmartAPI ticks (sampled by the browser, 09:15–15:30 IST only) into Supabase `market_ticks` using the service-role key.
 * Needs a verified user; every row is re-validated (symbol shape, positive prices, inside the session, not in the future); ≤ 500 rows per call.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, 'mk-ticks', 20);
  if (!a.ok) return json({ ok: false, reason: a.reason }, a.status);
  if (!storeConfigured()) return json({ ok: false, reason: 'not_configured', message: 'Set SUPABASE_SERVICE_ROLE_KEY and run docs/MARKET_TICKS.sql.' }, 501);
  let body: { rows?: unknown } = {};
  try { body = await req.json(); } catch { return json({ ok: false, reason: 'bad_json' }, 400); }
  const rows = validateRows(body.rows);
  const r = await insertTicks(rows);
  return json({ ok: r.ok, accepted: rows.length, inserted: r.inserted }, r.ok ? 200 : 502);
}
