import { NextRequest } from 'next/server';
import webpush from 'web-push';
import { runAlertWorker, ruleEmail, type WorkerDeps } from '@/lib/alertWorker';
import type { AlertRule, RuleQuote } from '@/lib/alertRules';
import { fetchQuoteRows } from '@/lib/yahooQuotes';
import { circuitPushPayload, fanOut, isB64Url, isPushEndpoint } from '@/lib/pushSender';
import { sendEmail } from '@/lib/email';
import type { PushSub } from '@/lib/cloud';
import { terminalUrl } from '@/lib/appUrl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET|POST /api/worker/alerts — evaluates every enabled alert rule against current quotes and delivers (push / e-mail / in-app).
 * Triggered by Vercel Cron (vercel.json) — which sends `Authorization: Bearer $CRON_SECRET` — or by any external scheduler.
 * Env: CRON_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-only), optional VAPID_* and RESEND_API_KEY.
 * Quotes come from the same server-side delayed source as /api/quotes (the SmartAPI stream is browser-side, so a server worker has no socket).
 */
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !url || !key) return Response.json({ ok: false, error: 'Worker is not configured (CRON_SECRET, SUPABASE_SERVICE_ROLE_KEY).' }, { status: 501 });
  const given = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  if (given.length !== secret.length || !timingSafe(given, secret)) return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });

  const base = url.replace(/\/+$/, '');
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const rest = (path: string, init: RequestInit = {}) => fetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...h, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(8000) });
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subject = process.env.VAPID_SUBJECT;
  if (pub && priv && subject) webpush.setVapidDetails(subject, pub, priv);

  const deps: WorkerDeps = {
    async loadRules() {
      const r = await rest('alert_rules?enabled=eq.true&select=id,user_id,symbol,kind,threshold,cooldown_min,channels,enabled,last_triggered_at&limit=2000');
      if (!r.ok) throw new Error(`rules ${r.status}`);
      return (await r.json()) as AlertRule[];
    },
    async quotes(symbols) {
      const out = new Map<string, RuleQuote>();
      for (let i = 0; i < symbols.length; i += 50) {
        const { rows } = await fetchQuoteRows(symbols.slice(i, i + 50).map((symbol) => ({ symbol })));
        for (const q of rows) out.set(q.symbol.toUpperCase(), { symbol: q.symbol, ltp: q.ltp, prevClose: q.prevClose });
      }
      return out;
    },
    async claim(id) {
      const r = await rest('rpc/claim_alert_rule', { method: 'POST', body: JSON.stringify({ p_rule: id }) });
      return r.ok && (await r.json()) === true;
    },
    async push(userId, hit) {
      if (!pub || !priv || !subject) return 'unconfigured';
      const r = await rest(`push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,keys`);
      const rows = r.ok ? ((await r.json()) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }[]) : [];
      const subs: PushSub[] = rows.flatMap((x) => (isPushEndpoint(x.endpoint, process.env.PUSH_ENDPOINT_ALLOW) && isB64Url(x.keys?.p256dh, 40) && isB64Url(x.keys?.auth, 10, 40) ? [{ endpoint: x.endpoint, keys: { p256dh: x.keys.p256dh, auth: x.keys.auth } }] : []));
      if (!subs.length) return { sent: 0, devices: 0 };
      const payload = { ...circuitPushPayload({ symbol: hit.rule.symbol, dir: hit.pct >= 0 ? 'upper' : 'lower', band: 5, ltp: hit.price, pct: hit.pct }), title: `UpCircuit · ${hit.rule.symbol}`, body: hit.message, url: terminalUrl(hit.rule.symbol), tag: `rule-${hit.rule.id}` };
      const res = await fanOut(subs, payload, (s, body) => webpush.sendNotification(s, body, { TTL: 3600, urgency: 'high' }).then(() => undefined));
      await Promise.all(res.gone.map((e) => rest(`push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&endpoint=eq.${encodeURIComponent(e)}`, { method: 'DELETE' }).catch(() => null)));
      return { sent: res.sent, devices: subs.length };
    },
    async email(userId, hit) {
      if (!process.env.RESEND_API_KEY) return 'unconfigured';
      const u = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: h, signal: AbortSignal.timeout(6000) }).catch(() => null);
      const to = u?.ok ? ((await u.json()) as { email?: string }).email : undefined;
      if (!to) return 'no_address';
      const m = ruleEmail(hit);
      return (await sendEmail({ to, ...m })).ok ? 'sent' : 'failed';
    },
    async record(d) {
      await rest('alert_deliveries', { method: 'POST', body: JSON.stringify([{ ...d, detail: d.detail?.slice(0, 200) ?? null }]), headers: { Prefer: 'return=minimal' } });
    },
    async audit(action, entityId, meta) {
      await rest('rpc/audit_write', { method: 'POST', body: JSON.stringify({ p_action: action, p_entity: 'alert_rule', p_entity_id: entityId, p_meta: meta }) });
    },
  };
  try {
    return Response.json({ ok: true, ...(await runAlertWorker(deps)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'worker failed' }, { status: 502 });
  }
}

function timingSafe(a: string, b: string): boolean {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export const GET = handle;
export const POST = handle;
