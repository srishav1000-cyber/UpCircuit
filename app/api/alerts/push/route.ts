import { NextRequest } from 'next/server';
import webpush from 'web-push';
import { TtlCache, allow } from '@/lib/ttlCache';
import { bearer, supabaseConfigured, whoami } from '@/lib/serverAuth';
import { circuitPushPayload, fanOut, isB64Url, isPushEndpoint } from '@/lib/pushSender';
import type { PushSub } from '@/lib/cloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYMBOL = /^[A-Za-z0-9&._-]{1,24}$/;
const sentToday = new TtlCache<true>(24 * 3600_000, 5000);
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

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
  if (!allow(`push:${user.id}`, 30, 3600_000)) return Response.json({ ok: false, error: 'Too many push alerts — try later.' }, { status: 429 });

  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL as string).replace(/\/+$/, '');
  const headers = { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, Authorization: `Bearer ${token}` };
  const r = await fetch(`${base}/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=endpoint,keys`, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r || !r.ok) return Response.json({ ok: false, error: 'Could not read your devices.' }, { status: 502 });
  const rows = (await r.json().catch(() => [])) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }[];
  const subs: PushSub[] = rows.flatMap((x) => (isPushEndpoint(x.endpoint, process.env.PUSH_ENDPOINT_ALLOW) && isB64Url(x.keys?.p256dh, 40) && isB64Url(x.keys?.auth, 10, 40) ? [{ endpoint: x.endpoint, keys: { p256dh: x.keys.p256dh, auth: x.keys.auth } }] : []));
  if (!subs.length) return Response.json({ ok: true, sent: 0, devices: 0 });

  webpush.setVapidDetails(subject, pub, priv);
  const res = await fanOut(subs, circuitPushPayload({ symbol, dir: b.dir, band, ltp, pct }), (s, body) => webpush.sendNotification(s, body, { TTL: 3600, urgency: 'high' }).then(() => undefined), typeof b.exclude === 'string' ? b.exclude : undefined);
  // prune subscriptions the push service says are gone (RLS lets the user delete their own rows)
  await Promise.all(res.gone.map((e) => fetch(`${base}/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&endpoint=eq.${encodeURIComponent(e)}`, { method: 'DELETE', headers }).catch(() => null)));
  if (res.sent) sentToday.set(dedupe, true);
  return Response.json({ ok: true, sent: res.sent, failed: res.failed, devices: subs.length, pruned: res.gone.length });
}
