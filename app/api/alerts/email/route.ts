import { NextRequest } from 'next/server';
import { buildCircuitEmail, sendEmail } from '@/lib/email';
import { TtlCache, allow } from '@/lib/ttlCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYMBOL = /^[A-Za-z0-9&._-]{1,24}$/;
const sentToday = new TtlCache<true>(24 * 3600_000, 5000);
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Resolve the caller from their Supabase access token. The recipient is ALWAYS the verified account e-mail — never client-supplied. */
async function whoami(token: string): Promise<{ id: string; email: string } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const u = (await r.json()) as { id?: string; email?: string };
    return u.id && u.email ? { id: u.id, email: u.email } : null;
  } catch {
    return null;
  }
}

/** POST /api/alerts/email  { symbol, dir, ltp, limit, band, pct, exact? }  +  Authorization: Bearer <Supabase access token> */
export async function POST(req: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return Response.json({ ok: false, error: 'E-mail alerts need Supabase accounts.' }, { status: 501 });
  const token = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return Response.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
  const user = await whoami(token);
  if (!user) return Response.json({ ok: false, error: 'Invalid or expired session.' }, { status: 401 });

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'Bad JSON.' }, { status: 400 });
  }
  const symbol = typeof b.symbol === 'string' ? b.symbol.toUpperCase() : '';
  const ltp = num(b.ltp), limit = num(b.limit), pct = num(b.pct), band = num(b.band);
  if (!SYMBOL.test(symbol) || (b.dir !== 'upper' && b.dir !== 'lower') || ltp === null || limit === null || pct === null || band === null || ltp <= 0 || limit <= 0 || ![5, 10, 20].includes(band))
    return Response.json({ ok: false, error: 'Invalid alert.' }, { status: 400 });

  // one e-mail per user · stock · direction · band per day, and at most 20 an hour per user
  const day = new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
  const dedupe = `${user.id}:${symbol}:${b.dir}:${band}:${day}`;
  if (sentToday.get(dedupe)) return Response.json({ ok: true, deduped: true });
  if (!allow(`mail:${user.id}`, 20, 3600_000)) return Response.json({ ok: false, error: 'Too many alert e-mails — try later.' }, { status: 429 });

  const mail = buildCircuitEmail({ symbol, dir: b.dir, ltp, limit, band, pct, exact: b.exact === true });
  const res = await sendEmail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
  if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: res.status ?? 502 });
  sentToday.set(dedupe, true);
  return Response.json({ ok: true, id: res.id });
}
