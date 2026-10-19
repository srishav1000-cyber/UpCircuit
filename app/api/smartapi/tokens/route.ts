import { NextRequest } from 'next/server';
import { loadListings } from '@/lib/scripMaster';
import { allow } from '@/lib/ttlCache';

export const runtime = 'nodejs';
export const maxDuration = 30;

const SYM = /^[A-Za-z0-9&._-]{1,24}$/;

/** GET /api/smartapi/tokens?s=RELIANCE,TCS — public instrument tokens (not secret) the browser needs to subscribe on the SmartAPI socket. */
export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
  if (!allow('sa-tok:' + ip, 60, 60_000)) return Response.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  const syms = (req.nextUrl.searchParams.get('s') ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).slice(0, 200);
  if (!syms.length || syms.some((s) => !SYM.test(s))) return Response.json({ ok: false, error: 'bad symbols' }, { status: 400 });
  try {
    const all = await loadListings();
    const listings: Record<string, { token: string; exchangeType: number }> = {};
    for (const s of syms) {
      const l = all.get(s);
      if (l) listings[s] = l;
    }
    return Response.json({ ok: true, listings }, { headers: { 'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400' } });
  } catch {
    return Response.json({ ok: false, error: 'scrip master unavailable' }, { status: 502 });
  }
}
