// Client-side audit writer: fire-and-forget with a small retry queue (the server stamps user, role, time and the hash chain — see docs/ENTERPRISE_SCHEMA.sql).
import type { CloudClient } from './cloud';

export interface AuditEvent { action: string; entity?: string; entity_id?: string; meta?: Record<string, unknown> }
export const ACTION_RE = /^[a-z_]+(\.[a-z_]+)*$/;
/** Names used across the app (kept in one place so the Compliance filter and the tests agree). */
export const AUDIT_ACTIONS = ['auth.login', 'auth.logout', 'export.csv', 'export.pdf', 'alert_rule.create', 'alert_rule.delete', 'alert_rule.toggle', 'register.export', 'audit.export', 'audit.verify', 'role.change', 'circuit.detected', 'circuit.acknowledge', 'circuit.escalate', 'circuit.close'] as const;

/** Drops anything that could carry secrets or bulk data: only short scalar values survive in `meta`. */
export function cleanMeta(m: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m ?? {}).slice(0, 12)) {
    if (/pass|token|secret|key|otp/i.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 120);
  }
  return out;
}

export interface Auditor { log(e: AuditEvent): void; pending(): number; flush(): Promise<void> }
export function createAuditor(cloud: CloudClient | null, opts: { max?: number } = {}): Auditor {
  const q: AuditEvent[] = [];
  const max = opts.max ?? 50;
  let busy = false;
  async function flush(): Promise<void> {
    if (!cloud || busy) return;
    busy = true;
    try {
      while (q.length) {
        try { await cloud.logAudit(q[0]); q.shift(); } catch { break; } // keep it queued; the next log()/flush() retries
      }
    } finally { busy = false; }
  }
  return {
    log(e) {
      if (!cloud || !ACTION_RE.test(e.action) || e.action.length > 48) return;
      q.push({ ...e, meta: cleanMeta(e.meta) });
      while (q.length > max) q.shift();
      void flush();
    },
    pending: () => q.length,
    flush,
  };
}
