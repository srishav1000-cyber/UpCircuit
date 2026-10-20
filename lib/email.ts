// Circuit-alert e-mail: Resend (REST — no SDK) + an HTML/text template. Links resolve through NEXT_PUBLIC_APP_URL (lib/appUrl.ts).
import { terminalUrl, appUrl } from './appUrl';

export interface CircuitMail {
  symbol: string;
  dir: 'upper' | 'lower';
  ltp: number;
  /** the circuit limit price that was reached */
  limit: number;
  band: number;
  pct: number;
  /** the band came from the exchange rather than being inferred from the 5/10/20 % limits */
  exact?: boolean;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildCircuitEmail(m: CircuitMail): { subject: string; html: string; text: string; link: string } {
  const upper = m.dir === 'upper';
  const event = upper ? 'Upper Circuit Hit' : 'Lower Circuit Hit';
  const colour = upper ? '#10b981' : '#ef4444';
  const link = terminalUrl(m.symbol);
  const sym = esc(m.symbol);
  const limitLabel = m.exact ? 'Circuit limit' : `${m.band}% circuit limit`;
  const subject = `${upper ? '▲' : '▼'} ${m.symbol} ${event} at ${inr(m.ltp)}`;
  const pct = `${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(2)}%`;
  const row = (k: string, v: string) => `<tr><td style="padding:6px 0;color:#94a3b8">${k}</td><td style="padding:6px 0;text-align:right;color:#e2e8f0;font-weight:600">${v}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#020617;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px">
<tr><td style="font-size:12px;letter-spacing:.08em;color:#94a3b8">UPCIRCUIT · CIRCUIT ALERT</td></tr>
<tr><td style="padding:8px 0 4px;font-size:22px;font-weight:700;color:${colour}">${upper ? '▲' : '▼'} ${esc(event)}</td></tr>
<tr><td style="font-size:18px;font-weight:700;color:#e2e8f0;padding-bottom:12px">${sym}</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1e293b">
${row('Last traded price', esc(inr(m.ltp)))}${row('Change vs previous close', esc(pct))}${row(esc(limitLabel), esc(inr(m.limit)))}
</table></td></tr>
<tr><td style="padding-top:16px"><a href="${esc(link)}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px">Open ${sym} in the terminal</a></td></tr>
<tr><td style="padding-top:16px;font-size:11px;color:#64748b">Prices are real NSE session data (exchange ticks when the live SmartAPI feed is connected). Not investment advice. <a href="${esc(appUrl('/'))}" style="color:#64748b">UpCircuit</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${event}: ${m.symbol}\nLTP ${inr(m.ltp)} (${pct})\n${limitLabel}: ${inr(m.limit)}\nOpen in the terminal: ${link}\n`;
  return { subject, html, text, link };
}

export type SendResult = { ok: true; id?: string } | { ok: false; error: string; status?: number };

/** Send through Resend. RESEND_API_KEY + EMAIL_FROM (a verified sender, e.g. "UpCircuit <alerts@yourdomain>") are server-side only. */
export async function sendEmail(
  i: { to: string; subject: string; html: string; text: string },
  env: { apiKey?: string; from?: string; base?: string } = { apiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM, base: process.env.RESEND_BASE },
  f: typeof fetch = fetch,
): Promise<SendResult> {
  if (!env.apiKey) return { ok: false, error: 'E-mail is not configured (RESEND_API_KEY).', status: 503 };
  try {
    const res = await f(`${env.base || 'https://api.resend.com'}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.from || 'UpCircuit <onboarding@resend.dev>', to: [i.to], subject: i.subject, html: i.html, text: i.text }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    return res.ok ? { ok: true, id: j.id } : { ok: false, error: j.message ?? `Resend error ${res.status}`, status: res.status };
  } catch {
    return { ok: false, error: 'Could not reach the e-mail provider.', status: 502 };
  }
}
