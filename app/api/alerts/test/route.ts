import { NextRequest } from 'next/server';
import { allowAsync } from '@/lib/ttlCache';
import { bearer, supabaseConfigured, whoami } from '@/lib/serverAuth';
import { ackSecret } from '@/lib/ackToken';
import { createDispatcher } from '@/daemon/dispatcher';
import { cleanEnv, cleanUrl, privilegedKeyProblem } from '@/lib/supabaseAdmin';
import { esc, sendEmail } from '@/lib/email';
import { terminalUrl } from '@/lib/appUrl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/alerts/test  +  Authorization: Bearer <Supabase access token>
 * Sends a real VAPID Web Push to every device the signed-in user has registered and records it in alert_deliveries (kind "test"), so the
 * Settings button verifies the whole chain: VAPID keys → push service → service worker → ACK. Returns { deliveryId } to poll for the ACK.
 * Env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (+ optional ALERT_ACK_SECRET).
 */
export async function POST(req: NextRequest) {
  const url = cleanUrl(process.env.NEXT_PUBLIC_SUPABASE_URL), key = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subject = process.env.VAPID_SUBJECT;
  if (!supabaseConfigured() || !url || !key || !pub || !priv || !subject) return Response.json({ ok: false, error: 'Web push is not configured on the server (Supabase service key + VAPID keys).' }, { status: 501 });
  const keyProblem = privilegedKeyProblem(key);
  if (keyProblem) return Response.json({ ok: false, error: keyProblem + '.' }, { status: 501 });
  const token = bearer(req);
  if (!token) return Response.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
  const user = await whoami(token);
  if (!user) return Response.json({ ok: false, error: 'Invalid or expired session.' }, { status: 401 });
  if (!(await allowAsync(`pushtest:${user.id}`, 6, 60_000))) return Response.json({ ok: false, error: 'Too many test pushes — wait a minute.' }, { status: 429 });

  const d = createDispatcher({ supabaseUrl: url, serviceKey: key, vapid: { publicKey: pub, privateKey: priv, subject }, ackSecret: ackSecret(), pushEndpointAllow: process.env.PUSH_ENDPOINT_ALLOW });
  // the same test goes to EVERY registered device (desktop + phones) and, when Resend is configured, to the account's e-mail — in parallel
  const [r, email] = await Promise.all([d.sendTest(user.id), testEmail(user.email)]);
  return Response.json({ ...r, email }, { status: r.ok || email.sent ? 200 : r.devices === 0 && !r.error?.startsWith('Could not') ? 409 : 502, headers: { 'Cache-Control': 'no-store' } });
}

export interface EmailTestResult { configured: boolean; sent: boolean; to?: string; error?: string }
async function testEmail(to: string | undefined): Promise<EmailTestResult> {
  const apiKey = cleanEnv(process.env.RESEND_API_KEY);
  if (!apiKey) return { configured: false, sent: false, error: 'E-mail alerts are not configured: RESEND_API_KEY is not set on the server.' };
  if (!to) return { configured: true, sent: false, error: 'Your account has no e-mail address.' };
  const link = terminalUrl('NIFTY');
  const r = await sendEmail({ to, subject: 'UpCircuit · test alert', text: `If you can read this, e-mail alerts reach ${to}.\n${link}`, html: `<p style="font-family:system-ui,sans-serif">If you can read this, UpCircuit e-mail alerts reach <b>${esc(to)}</b>.</p><p><a href="${esc(link)}">Open the terminal</a></p>` }, { apiKey, from: cleanEnv(process.env.EMAIL_FROM) || undefined, base: cleanEnv(process.env.RESEND_BASE) || undefined });
  return r.ok ? { configured: true, sent: true, to } : { configured: true, sent: false, to, error: r.error };
}
