'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { type AuthBackend, type AuthResult, type PlanId, type Role, type User } from '@/lib/auth';
import { pickBackend } from '@/lib/authBackends';
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
