// Application roles (permissions). NOT the same as the four persona lenses in lib/personas.ts / lib/auth.ts (those only change what the dashboard shows).
// The database is the authority (docs/ENTERPRISE_SCHEMA.sql: RLS + RPC checks); this map only decides what the UI offers.
export const APP_ROLES = ['viewer', 'analyst', 'risk', 'compliance', 'admin'] as const;
export type AppRole = (typeof APP_ROLES)[number];
export const DEFAULT_ROLE: AppRole = 'analyst';

export const ROLE_INFO: Record<AppRole, { label: string; blurb: string }> = {
  viewer: { label: 'Viewer', blurb: 'Market data only — no surveillance register.' },
  analyst: { label: 'Analyst', blurb: 'Reads the surveillance register; manages own alert rules.' },
  risk: { label: 'Risk officer', blurb: 'Acknowledges and escalates circuit events.' },
  compliance: { label: 'Compliance', blurb: 'Reviews the audit trail, closes escalated events, verifies the chain.' },
  admin: { label: 'Admin', blurb: 'Everything above, plus user roles.' },
};

export type Perm = 'register.view' | 'register.review' | 'register.close_escalated' | 'audit.view_all' | 'audit.verify' | 'audit.export' | 'users.manage' | 'rules.manage';
const P: Record<Perm, AppRole[]> = {
  'register.view': ['analyst', 'risk', 'compliance', 'admin'],
  'register.review': ['risk', 'compliance', 'admin'],
  'register.close_escalated': ['compliance', 'admin'],
  'audit.view_all': ['compliance', 'admin'],
  'audit.verify': ['compliance', 'admin'],
  'audit.export': ['compliance', 'admin'],
  'users.manage': ['admin'],
  'rules.manage': ['viewer', 'analyst', 'risk', 'compliance', 'admin'],
};
export const can = (role: AppRole | null | undefined, perm: Perm): boolean => !!role && P[perm].includes(role);
export const coerceAppRole = (x: unknown): AppRole => (typeof x === 'string' && (APP_ROLES as readonly string[]).includes(x) ? (x as AppRole) : DEFAULT_ROLE);

/** Governance workspace tabs a role can open (empty → hide the entry point). */
export type OpsTab = 'register' | 'rules' | 'audit' | 'ai' | 'users';
export function opsTabs(role: AppRole | null | undefined): OpsTab[] {
  const t: OpsTab[] = ['rules'];
  if (can(role, 'register.view')) t.unshift('register');
  if (can(role, 'audit.view_all')) t.push('audit', 'ai');
  if (can(role, 'users.manage')) t.push('users');
  return t;
}
