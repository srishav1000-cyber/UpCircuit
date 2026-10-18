'use client';

import { useState } from 'react';
import { PLANS, ROLES, canUse, coerceRole, planOf, validateCredentials, type PlanId, type Role } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';

const field = 'h-9 w-full rounded-md border border-line bg-bg px-3 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent';

/** Email + password login / sign-up. On sign-up the user picks a plan (Tier 1–3) and a primary role with radio buttons. */
export function AuthScreen() {
  const { signIn, signUp, backend } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState<PlanId>('full');
  const [role, setRole] = useState<Role>('retail');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickPlan = (p: PlanId) => {
    setPlan(p);
    setRole((r) => coerceRole(p, r));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = validateCredentials(email, password);
    if (bad) return setErr(bad);
    setBusy(true);
    setErr(null);
    const r = mode === 'login' ? await signIn(email, password) : await signUp({ email, password, role, plan });
    setBusy(false);
    if (!r.ok) setErr(r.error);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <form onSubmit={submit} noValidate data-testid="auth-form" className="w-full max-w-md space-y-4 rounded-xl border border-line bg-panel/90 p-5 shadow-2xl shadow-black/30 backdrop-blur">
        <div>
          <h1 className="text-lg font-bold text-ink">Up<span className="text-accent">Circuit</span></h1>
          <p className="text-[12px] text-muted">{mode === 'login' ? 'Log in to your workspace' : 'Create your account'}</p>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-md bg-bg p-1 text-[12px] font-semibold" role="tablist">
          {(['signup', 'login'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} data-testid={`auth-tab-${m}`} onClick={() => { setMode(m); setErr(null); }} className={`rounded py-1.5 ${mode === m ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
              {m === 'signup' ? 'Sign up' : 'Log in'}
            </button>
          ))}
        </div>
        <label className="block text-[12px] font-medium text-ink">Email
          <input data-testid="auth-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${field} mt-1`} placeholder="you@example.com" />
        </label>
        <label className="block text-[12px] font-medium text-ink">Password
          <input data-testid="auth-password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} className={`${field} mt-1`} placeholder="At least 8 characters" />
        </label>

        {mode === 'signup' && (
          <>
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-[12px] font-medium text-ink">Plan</legend>
              {PLANS.map((p) => (
                <label key={p.id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${plan === p.id ? 'border-accent bg-accent/10' : 'border-line hover:bg-line'}`}>
                  <input type="radio" name="plan" value={p.id} checked={plan === p.id} onChange={() => pickPlan(p.id)} data-testid={`plan-${p.id}`} className="accent-[rgb(var(--c-accent))]" />
                  <span className="flex-1"><b className="text-ink">Tier {p.tier} · {p.name}</b><span className="block text-muted">{p.blurb}</span></span>
                  <span className="num text-ink">{p.price}</span>
                </label>
              ))}
              <p className="text-[10px] text-muted">Prices are illustrative — no payment is taken.</p>
            </fieldset>
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-[12px] font-medium text-ink">Primary role</legend>
              {ROLES.map((r) => {
                const ok = canUse(plan, r.id);
                return (
                  <label key={r.id} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${!ok ? 'cursor-not-allowed border-line opacity-50' : role === r.id ? 'cursor-pointer border-accent bg-accent/10' : 'cursor-pointer border-line hover:bg-line'}`}>
                    <input type="radio" name="role" value={r.id} disabled={!ok} checked={role === r.id} onChange={() => setRole(r.id)} data-testid={`role-${r.id}`} className="accent-[rgb(var(--c-accent))]" />
                    <span aria-hidden>{r.icon}</span>
                    <span className="flex-1"><b className="text-ink">{r.label}</b><span className="block text-muted">{r.blurb}</span></span>
                    {!ok && <span aria-hidden title={`Not in ${planOf(plan).name}`}>🔒</span>}
                  </label>
                );
              })}
            </fieldset>
          </>
        )}

        {err && <p role="alert" data-testid="auth-error" className="rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{err}</p>}
        <button type="submit" disabled={busy} data-testid="auth-submit" className="h-9 w-full rounded-md bg-accent text-[13px] font-bold text-white hover:brightness-110 disabled:opacity-60">
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
        {backend === 'local' && <p className="text-[10px] text-muted">Demo mode: accounts are stored only in this browser. Set the Supabase variables for real accounts.</p>}
      </form>
    </div>
  );
}
