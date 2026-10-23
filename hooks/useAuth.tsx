'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { type AuthBackend, type AuthResult, type PlanId, type Role, type User } from '@/lib/auth';
import { pickBackend } from '@/lib/authBackends';
import { appUrl } from '@/lib/appUrl';
import { PKCE_COOKIE, PKCE_TTL_SEC } from '@/lib/pkce';
import { NEXT_COOKIE } from '@/lib/oauthCallback';
import { setScope } from '@/lib/scope';

interface Ctx {
  user: User | null;
  /** session restore finished */
  ready: boolean;
  /** false → NEXT_PUBLIC_AUTH_REQUIRED=false: the app opens without login (full access, shared storage) */
  required: boolean;
  backend: 'local' | 'supabase';
  signUp: (i: { email: string; password: string; role: Role; plan: PlanId }) => Promise<AuthResult>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  /** fresh Supabase access token for server calls (null on demo accounts) */
  getToken: () => Promise<string | null>;
  /** Supabase: redirect to Google (PKCE). Resolves only with an error — on success the page navigates away. */
  signInWithGoogle: (next?: string) => Promise<{ ok: false; error: string }>;
  /** Supabase: text a 6-digit code to an E.164 number (`data` seeds role/plan for a brand-new account) */
  sendOtp: (phone: string, data?: { role: Role; plan: PlanId }) => Promise<{ ok: true } | { ok: false; error: string }>;
  verifyOtp: (phone: string, code: string) => Promise<AuthResult>;
  /** Settings → bind a mobile number to the signed-in account: send the code … */
  sendPhoneLink: (phone: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** … then confirm it (updates `user.phone` / `user.phoneVerified`) */
  confirmPhoneLink: (phone: string, code: string) => Promise<AuthResult>;
  /** Settings → link a Google identity to this account (redirects; resolves only with an error) */
  linkGoogle: (next?: string) => Promise<{ ok: false; error: string }>;
  /** change primary role and/or plan; resolves with the outcome so the UI can show a refusal */
  update: (patch: { role?: Role; plan?: PlanId }) => Promise<AuthResult>;
}

const AuthCtx = createContext<Ctx | null>(null);
const REQUIRED = process.env.NEXT_PUBLIC_AUTH_REQUIRED !== 'false';
const GUEST: User = { id: 'guest', email: 'guest@local', role: 'retail', plan: 'full' };

export function AuthProvider({ children }: { children: ReactNode }) {
  const be = useRef<AuthBackend | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const put = useCallback((u: User | null) => {
    setScope(u && u.id !== 'guest' ? u.id : null); // before state commits → hooks of the remounted terminal see the right namespace
    setUser(u);
  }, []);

  useEffect(() => {
    let alive = true;
    try {
      be.current = pickBackend();
    } catch {
      be.current = null; // storage blocked
    }
    (async () => {
      const u = (await be.current?.restore().catch(() => null)) ?? null;
      if (!alive) return;
      put(u ?? (REQUIRED ? null : GUEST));
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [put]);

  const need = (): AuthBackend => {
    if (!be.current) throw new Error('storage unavailable');
    return be.current;
  };
  const wrap = useCallback(
    async (fn: () => Promise<AuthResult>): Promise<AuthResult> => {
      try {
        const r = await fn();
        if (r.ok) put(r.user);
        return r;
      } catch {
        return { ok: false, error: 'Browser storage is unavailable — enable cookies / site data and retry.' };
      }
    },
    [put],
  );

  const value = useMemo<Ctx>(
    () => ({
      user,
      ready,
      required: REQUIRED,
      backend: process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'supabase' : 'local',
      signUp: (i) => wrap(() => need().signUp(i)),
      signIn: (e, p) => wrap(() => need().signIn(e, p)),
      signInWithGoogle: async (next) => {
        const b = be.current;
        if (!b?.startOAuth) return { ok: false as const, error: 'Google sign-in needs Supabase accounts — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.' };
        const r = await b.startOAuth('google', appUrl('/auth/callback'));
        if (!r.ok) return r;
        const secure = location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = `${PKCE_COOKIE}=${r.verifier}; Path=/auth; Max-Age=${PKCE_TTL_SEC}; SameSite=Lax${secure}`;
        document.cookie = `${NEXT_COOKIE}=${encodeURIComponent(next ?? '/')}; Path=/auth; Max-Age=${PKCE_TTL_SEC}; SameSite=Lax${secure}`;
        window.location.assign(r.url);
        return { ok: false as const, error: 'Redirecting to Google…' };
      },
      sendOtp: async (phone, data) => (be.current?.sendOtp ? be.current.sendOtp(phone, data) : { ok: false as const, error: 'Phone OTP login needs Supabase accounts — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.' }),
      sendPhoneLink: async (phone) => (be.current?.startPhoneLink ? be.current.startPhoneLink(phone) : { ok: false as const, error: 'Linking a mobile number needs a Supabase account.' }),
      confirmPhoneLink: (phone, code) => wrap(async () => (be.current?.confirmPhoneLink ? be.current.confirmPhoneLink(phone, code) : { ok: false as const, error: 'Linking a mobile number needs a Supabase account.' })),
      linkGoogle: async (next) => {
        const b = be.current;
        if (!b?.startGoogleLink) return { ok: false as const, error: 'Linking Google needs a Supabase account.' };
        const r = await b.startGoogleLink(appUrl('/auth/callback'));
        if (!r.ok) return r;
        const secure = location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = `${PKCE_COOKIE}=${r.verifier}; Path=/auth; Max-Age=${PKCE_TTL_SEC}; SameSite=Lax${secure}`;
        document.cookie = `${NEXT_COOKIE}=${encodeURIComponent(next ?? '/')}; Path=/auth; Max-Age=${PKCE_TTL_SEC}; SameSite=Lax${secure}`;
        window.location.assign(r.url);
        return { ok: false as const, error: 'Redirecting to Google…' };
      },
      verifyOtp: (phone, code) => wrap(async () => (be.current?.verifyOtp ? be.current.verifyOtp(phone, code) : { ok: false as const, error: 'Phone OTP login needs Supabase accounts.' })),
      getToken: async () => (await be.current?.accessToken().catch(() => null)) ?? null,
      signOut: async () => {
        await be.current?.signOut().catch(() => undefined);
        put(REQUIRED ? null : GUEST);
      },
      update: (patch) => (user && user.id !== 'guest' ? wrap(() => need().update(user, patch)) : Promise.resolve({ ok: true, user: { ...(user ?? GUEST), ...patch } as User })),
    }),
    [user, ready, wrap, put],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
