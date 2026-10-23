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
  /** empty for phone-only accounts */
  email: string;
  role: Role;
  plan: PlanId;
  /** E.164, e.g. +919876543210 (phone / OTP accounts) */
  phone?: string;
  /** the phone number was confirmed by an SMS code (auth.users.phone_confirmed_at, mirrored to profiles.phone_verified) */
  phoneVerified?: boolean;
  /** sign-in providers linked to the account: 'email' | 'google' | 'phone' */
  providers?: string[];
  name?: string;
  avatar?: string;
}

export type AuthResult = { ok: true; user: User } | { ok: false; error: string };

export interface AuthBackend {
  kind: 'local' | 'supabase';
  /** the signed-in user from a stored session, or null */
  restore(): Promise<User | null>;
  signUp(i: { email: string; password: string; role: Role; plan: PlanId }): Promise<AuthResult>;
  signIn(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  /** a valid access token for server calls (refreshed if needed); null for backends without server-verifiable sessions */
  accessToken(): Promise<string | null>;
  /** persist a new primary role and/or plan (a backend may refuse a plan change — billing owns it) */
  update(user: User, patch: { role?: Role; plan?: PlanId }): Promise<AuthResult>;
  /** Supabase only: PKCE URL for "Continue with Google" (the caller stores `verifier` in a cookie, then navigates to `url`) */
  startOAuth?(provider: 'google', redirectTo: string): Promise<{ ok: true; url: string; verifier: string } | { ok: false; error: string }>;
  /** Supabase only: adopt tokens handed over by app/auth/callback after the code exchange */
  adoptSession?(t: { access: string; refresh: string }): Promise<AuthResult>;
  /** Supabase only: text a 6-digit code to an E.164 number (`data` = role/plan for a brand-new account) */
  sendOtp?(phone: string, data?: { role: Role; plan: PlanId }): Promise<{ ok: true } | { ok: false; error: string }>;
  verifyOtp?(phone: string, token: string): Promise<AuthResult>;
  /** Supabase only, signed in: text a code to bind a mobile number to this account (GoTrue phone_change) */
  startPhoneLink?(phone: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Supabase only: confirm the code; resolves with the refreshed user (phone + phoneVerified) */
  confirmPhoneLink?(phone: string, token: string): Promise<AuthResult>;
  /** Supabase only, signed in: PKCE URL that links a Google identity to THIS account (the callback exchanges the code as usual) */
  startGoogleLink?(redirectTo: string): Promise<{ ok: true; url: string; verifier: string } | { ok: false; error: string }>;
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

/** 10-digit Indian mobile (starts 6–9) → E.164 `+91XXXXXXXXXX`; accepts spaces / dashes and an optional +91 / 91 / 0 prefix. null when invalid. */
export function normalizeIndianMobile(input: string): string | null {
  let d = input.replace(/[\s\-().]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.startsWith('91') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}
export const OTP_RE = /^\d{6}$/;

/** `+919876543210` → `+91 XXXXX X3210` (last four digits only) */
export function maskPhone(e164: string): string {
  const m = /^\+91(\d{6})(\d{4})$/.exec(e164);
  return m ? `+91 XXXXX X${m[2]}` : e164.replace(/\d(?=\d{4})/g, 'X');
}
