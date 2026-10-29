// Server-side alert worker core (called by /api/worker/alerts on a schedule). All I/O is injected so it can be tested without network.
import { evaluateAll, type AlertRule, type RuleHit, type RuleQuote } from './alertRules';
import { appUrl, terminalUrl } from './appUrl';

export interface WorkerDeps {
  loadRules(): Promise<AlertRule[]>;
  quotes(symbols: string[]): Promise<Map<string, RuleQuote>>;
  /** atomic cooldown claim (RPC claim_alert_rule): true only for ONE caller per cooldown window */
  claim(ruleId: string): Promise<boolean>;
  push(userId: string, hit: RuleHit): Promise<{ sent: number; devices: number } | 'unconfigured'>;
  email(userId: string, hit: RuleHit): Promise<'sent' | 'no_address' | 'unconfigured' | 'failed'>;
  record(d: { rule_id: string; user_id: string; symbol: string; kind: string; price: number; channel: 'push' | 'email' | 'inapp'; status: 'sent' | 'failed' | 'skipped'; detail?: string }): Promise<void>;
  audit(action: string, entityId: string, meta: Record<string, unknown>): Promise<void>;
  now?: () => number;
}
export interface WorkerSummary { rules: number; symbols: number; due: number; claimed: number; pushed: number; emailed: number; skipped: number; errors: number }

export async function runAlertWorker(d: WorkerDeps): Promise<WorkerSummary> {
  const s: WorkerSummary = { rules: 0, symbols: 0, due: 0, claimed: 0, pushed: 0, emailed: 0, skipped: 0, errors: 0 };
  const rules = (await d.loadRules()).filter((r) => r.enabled);
  s.rules = rules.length;
  if (!rules.length) return s;
  const symbols = [...new Set(rules.map((r) => r.symbol.toUpperCase()))];
  s.symbols = symbols.length;
  const quotes = await d.quotes(symbols);
  const hits = evaluateAll(rules, quotes, d.now?.());
  s.due = hits.length;
  for (const h of hits) {
    try {
      if (!(await d.claim(h.rule.id))) { s.skipped++; continue; } // another worker run already fired it inside the cooldown
      s.claimed++;
      const base = { rule_id: h.rule.id, user_id: h.rule.user_id, symbol: h.rule.symbol, kind: h.rule.kind, price: h.price };
      // the in-app record is always written, so the user sees the trigger in "Recent deliveries" even with push/e-mail off
      await d.record({ ...base, channel: 'inapp', status: 'sent', detail: h.message });
      if (h.rule.channels.push) {
        const r = await d.push(h.rule.user_id, h);
        if (r === 'unconfigured') await d.record({ ...base, channel: 'push', status: 'skipped', detail: 'web push is not configured' });
        else if (r.sent > 0) { s.pushed++; await d.record({ ...base, channel: 'push', status: 'sent', detail: `${r.sent}/${r.devices} devices` }); }
        else await d.record({ ...base, channel: 'push', status: r.devices ? 'failed' : 'skipped', detail: r.devices ? 'no device accepted the push' : 'no registered devices' });
      }
      if (h.rule.channels.email) {
        const r = await d.email(h.rule.user_id, h);
        if (r === 'sent') s.emailed++;
        await d.record({ ...base, channel: 'email', status: r === 'sent' ? 'sent' : r === 'failed' ? 'failed' : 'skipped', detail: r === 'sent' ? undefined : r });
      }
      await d.audit('alert_rule.fire', h.rule.id, { symbol: h.rule.symbol, kind: h.rule.kind, price: h.price });
    } catch {
      s.errors++;
    }
  }
  return s;
}

export function ruleEmail(h: RuleHit): { subject: string; html: string; text: string } {
  const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
  const link = terminalUrl(h.rule.symbol);
  return {
    subject: `UpCircuit alert · ${h.rule.symbol}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px"><h2 style="margin:0 0 8px">${esc(h.rule.symbol)} alert</h2><p>${esc(h.message)}</p><p><a href="${link}">Open in the terminal</a></p><p style="color:#888;font-size:12px">You set this rule in UpCircuit → Compliance → Alert rules. Delayed market data; not investment advice. Manage rules: ${appUrl('/')}</p></div>`,
    text: `${h.message}\nOpen in the terminal: ${link}\n\nYou set this rule in UpCircuit. Delayed market data; not investment advice.`,
  };
}
