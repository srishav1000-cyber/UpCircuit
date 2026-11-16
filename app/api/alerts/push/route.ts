import { NextRequest } from 'next/server';
import webpush from 'web-push';
import { TtlCache, allowAsync } from '@/lib/ttlCache';
import { bearer, supabaseConfigured, whoami } from '@/lib/serverAuth';
import { circuitPushPayload, fanOut, isB64Url, isPushEndpoint } from '@/lib/pushSender';
import type { PushSub } from '@/lib/cloud';
import { adminHeaders, resendConfigured, userHeaders } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYMBOL = /^[A-Za-z0-9&._-]{1,24}$/;
const sentToday = new TtlCache<true>(24 * 3600_000, 5000);
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);


/** REST access for one verified user: the service key when configured (works with legacy JWT and `sb_secret_…` keys; rows are always filtered by the verified user id), else the user's own token through RLS. */
function access(token: string) {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL as string).replace(/\/+$/, '');
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = svc ? adminHeaders(svc, true) : { ...userHeaders(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, token), 'Content-Type': 'application/json' };
  return { base, headers, mode: svc ? ('service' as const) : ('user' as const) };
}
type Row = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
const validRows = (rows: Row[]): PushSub[] => rows.flatMap((x) => (isPushEndpoint(x.endpoint, process.env.PUSH_ENDPOINT_ALLOW) && isB64Url(x.keys?.p256dh, 40) && isB64Url(x.keys?.auth, 10, 40) ? [{ endpoint: x.endpoint as string, keys: { p256dh: x.keys!.p256dh as string, auth: x.keys!.auth as string } }] : []));
async function readDevices(userId: string, token: string): Promise<{ ok: true; subs: PushSub[]; total: number } | { ok: false; status: number | null }> {
  const a = access(token);
  const r = await fetch(`${a.base}/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,keys`, { headers: a.headers, cache: 'no-store', signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return { ok: false, status: null };
  if (!r.ok) return { ok: false, status: r.status };
  const rows = (await r.json().catch(() => [])) as Row[];
  return { ok: true, subs: validRows(Array.isArray(rows) ? rows : []), total: Array.isArray(rows) ? rows.length : 0 };
}
const readFail = (status: number | null) => Response.json({ ok: false, error: status === 404 ? 'Could not read your devices — the push_subscriptions table is missing (run docs/PERSISTENCE_SCHEMA.sql).' : status === 401 || status === 403 ? 'Could not read your devices — the server\'s Supabase key was rejected. Check SUPABASE_SERVICE_ROLE_KEY (a legacy service_role key or an sb_secret_… key).' : 'Could not read your devices.', status }, { status: 502 });

async function session(req: NextRequest): Promise<{ err: Response } | { err?: undefined; token: string; user: { id: string; email: string } }> {
  if (!supabaseConfigured()) return { err: Response.json({ ok: false, error: 'Supabase is not configured.' }, { status: 501 }) };
  const token = bearer(req);
  if (!token) return { err: Response.json({ ok: false, error: 'Sign in first.' }, { status: 401 }) };
  const user = await whoami(token);
  return user ? { token, user } : { err: Response.json({ ok: false, error: 'Invalid or expired session.' }, { status: 401 }) };
}

/** GET /api/alerts/push → channel readiness + this account's registered devices (never throws a bare error) */
export async function GET(req: NextRequest) {
  const s = await session(req); if (s.err) return s.err;
  const d = await readDevices(s.user.id, s.token);
  if (!d.ok) return readFail(d.status);
  const vapid = Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
  const email = resendConfigured();
  return Response.json({
    ok: true, devices: d.subs.length, endpoints: d.subs.map((x) => x.endpoint.slice(-12)),
    push: { configured: vapid, note: vapid ? undefined : 'Web Push needs NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT on the server.' },
    email: { configured: email, to: s.user.email, note: email ? undefined : 'E-mail alerts are not configured: RESEND_API_KEY is not set on the server.' },
    kinds: ['price_above', 'price_below', 'pct_up', 'pct_down', 'volume_surge', 'order_imbalance_above', 'order_imbalance_below', 'circuit_proximity'],
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/** PUT /api/alerts/push { subscription: { endpoint, keys:{p256dh,auth} } } → registers / refreshes THIS browser's PushSubscription (idempotent) */
export async function PUT(req: NextRequest) {
  const s = await session(req); if (s.err) return s.err;
  let b: { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } };
  try { b = await req.json(); } catch { return Response.json({ ok: false, error: 'Bad JSON.' }, { status: 400 }); }
  const [sub] = validRows([b.subscription ?? {}]);
  if (!sub) return Response.json({ ok: false, error: 'Invalid push subscription.' }, { status: 400 });
  if (!(await allowAsync(`pushreg:${s.user.id}`, 30, 3600_000))) return Response.json({ ok: false, error: 'Too many registrations — try later.' }, { status: 429 });
  const a = access(s.token);
  const r = await fetch(`${a.base}/rest/v1/push_subscriptions?on_conflict=user_id,endpoint`, { method: 'POST', headers: { ...a.headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ user_id: s.user.id, endpoint: sub.endpoint, keys: sub.keys }]), signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r || !r.ok) return Response.json({ ok: false, error: 'Could not save this device.', status: r?.status ?? null }, { status: 502 });
  return Response.json({ ok: true, registered: true });
}

/**
 * POST /api/alerts/push  { symbol, dir, ltp, band, pct, exclude? }  +  Authorization: Bearer <Supabase access token>
 * Sends a Web Push to the signed-in user's saved devices (their own rows only — read through RLS with their token).
 * `exclude` = the endpoint of the device that raised the alert (it already shows the overlay).
 * Env: NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: URL).
 */
export async function POST(req: NextRequest) {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subject = process.env.VAPID_SUBJECT;
  if (!supabaseConfigured() || !pub || !priv || !subject) return Response.json({ ok: false, error: 'Web push is not configured (Supabase + VAPID keys).' }, { status: 501 });
  const token = bearer(req);
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
  const ltp = num(b.ltp), pct = num(b.pct), band = num(b.band);
  if (!SYMBOL.test(symbol) || (b.dir !== 'upper' && b.dir !== 'lower') || ltp === null || pct === null || band === null || ltp <= 0 || ![5, 10, 20].includes(band))
    return Response.json({ ok: false, error: 'Invalid alert.' }, { status: 400 });

  const day = new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
  const dedupe = `${user.id}:${symbol}:${b.dir}:${band}:${day}`;
  if (sentToday.get(dedupe)) return Response.json({ ok: true, deduped: true });
  if (!(await allowAsync(`push:${user.id}`, 30, 3600_000))) return Response.json({ ok: false, error: 'Too many push alerts — try later.' }, { status: 429 });

  const d = await readDevices(user.id, token);
  if (!d.ok) return readFail(d.status);
  const subs = d.subs;
  if (!subs.length) return Response.json({ ok: true, sent: 0, devices: 0 });

  webpush.setVapidDetails(subject, pub, priv);
  const res = await fanOut(subs, circuitPushPayload({ symbol, dir: b.dir, band, ltp, pct }), (s, body) => webpush.sendNotification(s, body, { TTL: 3600, urgency: 'high' }).then(() => undefined), typeof b.exclude === 'string' ? b.exclude : undefined);
  // prune subscriptions the push service says are gone (RLS lets the user delete their own rows)
  const pa = access(token);
  await Promise.all(res.gone.map((e) => fetch(`${pa.base}/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&endpoint=eq.${encodeURIComponent(e)}`, { method: 'DELETE', headers: pa.headers }).catch(() => null)));
  if (res.sent) sentToday.set(dedupe, true);
  return Response.json({ ok: true, sent: res.sent, failed: res.failed, devices: subs.length, pruned: res.gone.length });
}
