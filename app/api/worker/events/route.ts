import { withLog } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** GET|POST /api/worker/events — drains the event log into derived tables (consume_circuit_stats) and reports consumer lag. CRON_SECRET-protected like the other workers. */
const handle = withLog('worker/events', async (req: Request) => {
  const secret = process.env.CRON_SECRET, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !url || !key) return Response.json({ ok: false, error: 'Worker is not configured.' }, { status: 501 });
  const given = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  let d = given.length ^ secret.length; for (let i = 0; i < Math.min(given.length, secret.length); i++) d |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  if (d !== 0) return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  const base = url.replace(/\/+$/, ''), h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const rpc = async (fn: string, body: object) => { const r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`${fn} ${r.status}`); return r.json(); };
  let consumed = 0, rounds = 0;
  for (; rounds < 20; rounds++) { const n = Number(await rpc('consume_circuit_stats', { p_consumer: 'circuit-stats', p_batch: 500 })); consumed += n; if (n < 500) break; }
  const lag = Number(await rpc('event_lag', { p_consumer: 'circuit-stats', p_topic: 'circuit.detected' }));
  return Response.json({ ok: true, consumed, lag });
});
export const GET = handle;
export const POST = handle;
