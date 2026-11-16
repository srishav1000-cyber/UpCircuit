import { NextRequest } from 'next/server';
import webpush from 'web-push';
import { TtlCache, allowAsync } from '@/lib/ttlCache';
import { bearer, supabaseConfigured, whoami } from '@/lib/serverAuth';
import { circuitPushPayload, fanOut, isB64Url, isPushEndpoint } from '@/lib/pushSender';
import type { PushSub } from '@/lib/cloud';
import { adminHeaders, cleanEnv, cleanUrl, keyKind, privilegedKeyProblem, resendConfigured, sbFailure, sbFailureText, userHeaders, type SbFailure } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYMBOL = /^[A-Za-z0-9&._-]{1,24}$/;
const sentToday = new TtlCache<true>(24 * 3600_000, 5000);
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);


/** REST access for one verified user. `service`: the privileged key (rows are always filtered by the verified user id); `user`: the user's own token through RLS. */
function access(token: string, mode: 'service' | 'user') {
  const base = cleanUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const headers = mode === 'service' ? adminHeaders(cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY), true) : { ...userHeaders(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, token), 'Content-Type': 'application/json' };
  return { base, headers };
}
const hasServiceKey = () => !privilegedKeyProblem(process.env.SUPABASE_SERVICE_ROLE_KEY);
type Row = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
const validRows = (rows: Row[]): PushSub[] => rows.flatMap((x) => (isPushEndpoint(x.endpoint, process.env.PUSH_ENDPOINT_ALLOW) && isB64Url(x.keys?.p256dh, 40) && isB64Url(x.keys?.auth, 10, 40) ? [{ endpoint: x.endpoint as string, keys: { p256dh: x.keys!.p256dh as string, auth: x.keys!.auth as string } }] : []));

type Attempt = { via: 'service' | 'user'; failure: SbFailure };
/** reads this user's devices. Tries the service key first (when it looks valid) and, if Supabase rejects it, falls back to the user's own token — every failure is kept verbatim. */
async function readDevices(userId: string, token: string): Promise<{ ok: true; subs: PushSub[]; via: 'service' | 'user'; attempts: Attempt[] } | { ok: false; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  const order: ('service' | 'user')[] = hasServiceKey() ? ['service', 'user'] : ['user'];
  for (const via of order) {
    const a = access(token, via);
    let r: Response | null = null, err: unknown;
    try { r = await fetch(`${a.base}/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,keys`, { headers: a.headers, cache: 'no-store', signal: AbortSignal.timeout(8000) }); } catch (e) { err = e; }
    if (r?.ok) {
      const rows = (await r.json().catch(() => [])) as Row[];
      return { ok: true, subs: validRows(Array.isArray(rows) ? rows : []), via, attempts };
    }
    attempts.push({ via, failure: await sbFailure(r, err) });
  }
  return { ok: false, attempts };
}
/** 502 carrying the real Supabase status + message of every attempt (no secrets) and a plain-English diagnosis */
function readFail(attempts: Attempt[]) {
  const keyProblem = privilegedKeyProblem(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const svc = attempts.find((x) => x.via === 'service')?.failure, usr = attempts.find((x) => x.via === 'user')?.failure;
  const last = usr ?? svc;
  const diagnosis = keyProblem ? keyProblem
    : svc && (svc.status === 401 || svc.status === 403) ? `Supabase rejected the server key (${sbFailureText(svc)}). Check SUPABASE_SERVICE_ROLE_KEY belongs to THIS project (${cleanUrl(process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/^https?:\/\//, '')}).`
    : last?.status === 404 || last?.code === 'PGRST205' || last?.code === '42P01' ? 'The push_subscriptions table is missing — run docs/PERSISTENCE_SCHEMA.sql in the Supabase SQL editor.'
    : last?.code === '42501' ? 'Permission denied on push_subscriptions — re-run docs/PERSISTENCE_SCHEMA.sql (RLS policies / grants).'
    : last?.status === null ? `The server could not reach Supabase (${last.message}).`
    : last ? sbFailureText(last) : 'Unknown error.';
  return Response.json({
    ok: false, error: `Could not read your devices — ${diagnosis}`,
    supabase: attempts.map((x) => ({ via: x.via, status: x.failure.status, code: x.failure.code ?? null, message: x.failure.message, hint: x.failure.hint ?? null })),
    keyKind: keyKind(process.env.SUPABASE_SERVICE_ROLE_KEY),
  }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
}

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
  if (!d.ok) return readFail(d.attempts);
  const vapid = Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
  const email = resendConfigured();
  return Response.json({
    ok: true, devices: d.subs.length, readVia: d.via, endpoints: d.subs.map((x) => x.endpoint.slice(-12)),
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
  const attempts: Attempt[] = [];
  for (const via of (hasServiceKey() ? ['service', 'user'] : ['user']) as ('service' | 'user')[]) {
    const a = access(s.token, via);
    let r: Response | null = null, err: unknown;
    try { r = await fetch(`${a.base}/rest/v1/push_subscriptions?on_conflict=user_id,endpoint`, { method: 'POST', headers: { ...a.headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ user_id: s.user.id, endpoint: sub.endpoint, keys: sub.keys }]), signal: AbortSignal.timeout(8000) }); } catch (e) { err = e; }
    if (r?.ok) return Response.json({ ok: true, registered: true, via });
    attempts.push({ via, failure: await sbFailure(r, err) });
  }
  const f = attempts[attempts.length - 1].failure;
  return Response.json({ ok: false, error: `Could not save this device — ${sbFailureText(f)}`, supabase: attempts.map((x) => ({ via: x.via, status: x.failure.status, code: x.failure.code ?? null, message: x.failure.message })) }, { status: 502 });
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
  if (!d.ok) return readFail(d.attempts);
  const subs = d.subs;
  if (!subs.length) return Response.json({ ok: true, sent: 0, devices: 0 });

  webpush.setVapidDetails(subject, pub, priv);
  const res = await fanOut(subs, circuitPushPayload({ symbol, dir: b.dir, band, ltp, pct }), (s, body) => webpush.sendNotification(s, body, { TTL: 3600, urgency: 'high' }).then(() => undefined), typeof b.exclude === 'string' ? b.exclude : undefined);
  // prune subscriptions the push service says are gone (RLS lets the user delete their own rows)
  const pa = access(token, d.via);
  await Promise.all(res.gone.map((e) => fetch(`${pa.base}/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&endpoint=eq.${encodeURIComponent(e)}`, { method: 'DELETE', headers: pa.headers }).catch(() => null)));
  if (res.sent) sentToday.set(dedupe, true);
  return Response.json({ ok: true, sent: res.sent, failed: res.failed, devices: subs.length, pruned: res.gone.length });
}
