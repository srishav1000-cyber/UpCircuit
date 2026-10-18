// Accounts, roles and plans. Backend-agnostic: the UI talks to an `AuthBackend`; `lib/authBackends.ts` provides
//   • local     – browser-only demo accounts (PBKDF2-hashed, localStorage). Works with zero setup. NOT a security boundary.
//   • supabase  – real accounts via Supabase Auth (GoTrue) + a `profiles` table (see docs/AUTH_SCHEMA.sql).
import type { Persona } from './personas';

export type Role = Persona; // 'day' | 'retail' | 'institutional' | 'executive'
export type PlanId = 'day' | 'retail' | 'full';

export const ROLES: { id: Role; icon: string; label: string; blurb: string }[] = [
  { id: 'day', icon: '⚡', label: 'Day Trader', blurb: 'Intraday momentum, VWAP bands, tick volume' },
  { id: 'retail', icon: '📊', label: 'Retail Investor', blurb: 'Portfolio P&L, dividends, simple ratios' },
  { id: 'institutional', icon: '🏛️', label: 'Institutional Analyst', blurb: 'Concentration, HHI, sector allocation' },
  { id: 'executive', icon: '🛡️', label: 'Executive / Risk Manager', blurb: 'Macro sentiment, circuit & anomaly desk' },
];
export const ALL_ROLES: Role[] = ROLES.map((r) => r.id);
export const roleDef = (id: Role) => ROLES.find((r) => r.id === id) ?? ROLES[1];

export interface Plan {
  id: PlanId;
  tier: 1 | 2 | 3;
  name: string;
  /** illustrative price — no payment gateway is wired */
  price: string;
  roles: Role[];
  blurb: string;
}
export const PLANS: Plan[] = [
  { id: 'day', tier: 1, name: 'Day Trader', price: '₹299 / mo', roles: ['day'], blurb: 'Day Trader workspace only' },
  { id: 'retail', tier: 2, name: 'Retail Investor', price: '₹199 / mo', roles: ['retail'], blurb: 'Retail Investor workspace only' },
  { id: 'full', tier: 3, name: 'Full Access', price: '₹799 / mo', roles: ALL_ROLES, blurb: 'All four roles' },
];
export const planOf = (id: PlanId | undefined): Plan => PLANS.find((p) => p.id === id) ?? PLANS[2];
export const canUse = (plan: PlanId | undefined, role: Role) => planOf(plan).roles.includes(role);
export const allowedRoles = (plan: PlanId | undefined): Role[] => planOf(plan).roles;
/** the lowest plan that unlocks a role (for "Upgrade to …" hints) */
export const planFor = (role: Role): Plan => PLANS.slice().sort((a, b) => a.tier - b.tier).find((p) => p.roles.includes(role)) ?? PLANS[2];
/** keep a preferred role if the plan allows it, otherwise the plan's first role */
export const coerceRole = (plan: PlanId | undefined, role: Role | undefined): Role => (role && canUse(plan, role) ? role : allowedRoles(plan)[0]);

export interface User {
  id: string;
  email: string;
  role: Role;
  plan: PlanId;
}

export type AuthResult = { ok: true; user: User } | { ok: false; error: string };

export interface AuthBackend {
  kind: 'local' | 'supabase';
  /** the signed-in user from a stored session, or null */
  restore(): Promise<User | null>;
  signUp(i: { email: string; password: string; role: Role; plan: PlanId }): Promise<AuthResult>;
  signIn(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  /** persist a new primary role and/or plan (a backend may refuse a plan change — billing owns it) */
  update(user: User, patch: { role?: Role; plan?: PlanId }): Promise<AuthResult>;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD = 8;
export function validateCredentials(email: string, password: string): string | null {
  if (!EMAIL_RE.test(email.trim())) return 'Enter a valid email address.';
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  return null;
}

/** Namespace a localStorage key per user so accounts sharing a browser never see each other's watchlists, portfolio or chats. */
export const userKey = (base: string, userId?: string | null) => (userId ? `${base}:${userId}` : base);
