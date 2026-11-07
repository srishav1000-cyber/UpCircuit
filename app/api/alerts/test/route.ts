import { NextRequest } from 'next/server';
import { allowAsync } from '@/lib/ttlCache';
import { bearer, supabaseConfigured, whoami } from '@/lib/serverAuth';
import { ackSecret } from '@/lib/ackToken';
import { createDispatcher } from '@/daemon/dispatcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/alerts/test  +  Authorization: Bearer <Supabase access token>
 * Sends a real VAPID Web Push to every device the signed-in user has registered and records it in alert_deliveries (kind "test"), so the
 * Settings button verifies the whole chain: VAPID keys → push service → service worker → ACK. Returns { deliveryId } to poll for the ACK.
 * Env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (+ optional ALERT_ACK_SECRET).
 */
export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subject = process.env.VAPID_SUBJECT;
  if (!supabaseConfigured() || !url || !key || !pub || !priv || !subject) return Response.json({ ok: false, error: 'Web push is not configured on the server (Supabase service key + VAPID keys).' }, { status: 501 });
  const token = bearer(req);
  if (!token) return Response.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
  const user = await whoami(token);
  if (!user) return Response.json({ ok: false, error: 'Invalid or expired session.' }, { status: 401 });
  if (!(await allowAsync(`pushtest:${user.id}`, 6, 60_000))) return Response.json({ ok: false, error: 'Too many test pushes — wait a minute.' }, { status: 429 });

  const d = createDispatcher({ supabaseUrl: url, serviceKey: key, vapid: { publicKey: pub, privateKey: priv, subject }, ackSecret: ackSecret(), pushEndpointAllow: process.env.PUSH_ENDPOINT_ALLOW });
  const r = await d.sendTest(user.id);
  return Response.json(r, { status: r.ok ? 200 : r.devices === 0 && !r.error?.startsWith('Could not') ? 409 : 502, headers: { 'Cache-Control': 'no-store' } });
}
