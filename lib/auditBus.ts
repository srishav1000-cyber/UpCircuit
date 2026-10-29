// Module-level handle to the signed-in user's auditor, so any component can record an action without prop drilling. No-op until a Supabase session installs one.
import type { Auditor, AuditEvent } from './audit';
let current: Auditor | null = null;
export const installAuditor = (a: Auditor | null) => { current = a; };
export const audit = (e: AuditEvent): void => { try { current?.log(e); } catch { /* auditing must never break the UI */ } };
