import { NextRequest } from 'next/server';
import { allowAsync } from '@/lib/ttlCache';
import { ackSecret, verifyAckToken } from '@/lib/ackToken';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/alerts/ack  { delivery_id, ack, displayed_at (epoch ms, device clock), received_at? }
 * Called by public/sw.js right after it shows a notification that carried { delivery_id, ack }. No session exists in a service worker, so `ack` is an
 * HMAC the daemon put inside the (end-to-end encrypted) push payload — only a device that really received the push can present it.
 * Writes sw_ack_at (server clock, first ACK wins) and displayed_at (device clock) on that alert_deliveries row. 404 = row not inserted yet (the SW retries).
 */
export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, secret = ackSecret();
  if (!url || !key || !secret) return Response.json({ ok: false, error: 'Delivery ACKs are not configured.' }, { status: 501 });
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  if (!(await allowAsync(`ack:${ip}`, 240, 60_000))) return Response.json({ ok: false, error: 'Too many requests.' }, { status: 429 });
  if (Number(req.headers.get('content-length') ?? 0) > 2048) return Response.json({ ok: false, error: 'Too large.' }, { status: 413 });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return Response.json({ ok: false, error: 'Bad JSON.' }, { status: 400 }); }
  if (!verifyAckToken(b.delivery_id, b.ack, secret)) return Response.json({ ok: false, error: 'Invalid ACK.' }, { status: 401 });
  const id = b.delivery_id as string;

  // device clock: accept only a plausible value (within a day of the server), otherwise leave displayed_at empty
  const t = typeof b.displayed_at === 'number' ? b.displayed_at : NaN;
  const displayedAt = Number.isFinite(t) && Math.abs(t - Date.now()) < 86_400_000 ? new Date(t).toISOString() : null;

  const base = url.replace(/\/+$/, '');
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const sig = AbortSignal.timeout(6000);
  const r = await fetch(`${base}/rest/v1/alert_deliveries?id=eq.${id}&sw_ack_at=is.null&select=id`, {
    method: 'PATCH', headers: { ...h, Prefer: 'return=representation' }, signal: sig,
    body: JSON.stringify({ sw_ack_at: new Date().toISOString(), displayed_at: displayedAt }),
  }).catch(() => null);
  if (!r || !r.ok) return Response.json({ ok: false, error: 'Could not record the ACK.' }, { status: 502 });
  if (((await r.json().catch(() => [])) as unknown[]).length) return Response.json({ ok: true });

  // nothing updated: either already ACKed by another device (fine) or the row is not there yet (the SW retries)
  const e = await fetch(`${base}/rest/v1/alert_deliveries?id=eq.${id}&select=id`, { headers: h, signal: AbortSignal.timeout(6000) }).catch(() => null);
  const exists = e?.ok ? ((await e.json().catch(() => [])) as unknown[]).length > 0 : false;
  return exists ? Response.json({ ok: true, duplicate: true }) : Response.json({ ok: false, error: 'Unknown delivery (yet).' }, { status: 404 });
}
