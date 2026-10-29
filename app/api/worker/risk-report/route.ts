import { NextRequest } from 'next/server';
import { buildRiskReport } from '@/lib/riskReport';
import { ENTITLEMENTS, coercePlan } from '@/lib/entitlements';
import { fetchQuoteRows } from '@/lib/yahooQuotes';
import { sendEmail } from '@/lib/email';
import { withLog, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** GET|POST /api/worker/risk-report — e-mails the daily risk report to users who switched it on (Full Access plan). Same auth as /api/worker/alerts (CRON_SECRET). */
const handle = withLog('worker/risk-report', async (req: Request) => {
  const secret = process.env.CRON_SECRET, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !url || !key) return Response.json({ ok: false, error: 'Worker is not configured.' }, { status: 501 });
  const given = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  let d = given.length ^ secret.length; for (let i = 0; i < Math.min(given.length, secret.length); i++) d |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  if (d !== 0) return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  const base = url.replace(/\/+$/, ''), h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const rest = (p: string, init: RequestInit = {}) => fetch(`${base}/rest/v1/${p}`, { ...init, headers: { ...h, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(8000) });

  const prefs = (await (await rest('preferences?risk_report=eq.true&select=user_id,risk_limits&limit=500')).json().catch(() => [])) as { user_id: string; risk_limits: unknown }[];
  const out = { users: prefs.length, sent: 0, skipped: 0, failed: 0 };
  for (const p of prefs) {
    try {
      const prof = ((await (await rest(`profiles?id=eq.${encodeURIComponent(p.user_id)}&select=plan,email`)).json()) as { plan?: string; email?: string }[])[0];
      if (!prof?.email || !ENTITLEMENTS[coercePlan(prof.plan)].riskReport) { out.skipped++; continue; }
      const hold = (await (await rest(`portfolios?user_id=eq.${encodeURIComponent(p.user_id)}&select=symbol,quantity,sector`)).json()) as { symbol: string; quantity: number; sector?: string }[];
      if (!hold.length) { out.skipped++; continue; }
      const { rows } = await fetchQuoteRows(hold.slice(0, 60).map((x) => ({ symbol: x.symbol })));
      const rep = buildRiskReport(hold.map((x) => ({ symbol: x.symbol, qty: Number(x.quantity), sector: x.sector })), new Map(rows.map((r) => [r.symbol.toUpperCase(), r.ltp])), p.risk_limits);
      if (!rep) { out.skipped++; continue; }
      const res = await sendEmail({ to: prof.email, subject: rep.subject, html: rep.html, text: rep.text });
      if (res.ok) {
        out.sent++;
        await rest('rpc/audit_write', { method: 'POST', body: JSON.stringify({ p_action: 'risk.report', p_entity: 'user', p_entity_id: p.user_id, p_meta: { breaches: rep.breaches.length } }) }).catch(() => null);
      } else out.failed++;
    } catch (e) { out.failed++; log('warn', 'risk report failed', { user: p.user_id, err: e instanceof Error ? e.message : String(e) }); }
  }
  return Response.json({ ok: true, ...out });
});
export const GET = handle;
export const POST = handle;
