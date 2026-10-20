'use client';

import { useState } from 'react';
import { PLANS, ROLES, canUse, coerceRole, planOf, validateCredentials, type PlanId, type Role } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';

const field = 'h-9 w-full rounded-md border border-line bg-bg/70 px-3 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent';

/** Email + password login / sign-up. On sign-up the user picks a plan (Tier 1–3) and a primary role with radio buttons. */
export function AuthScreen({ onDone }: { onDone?: () => void } = {}) {
  const { signIn, signUp, backend } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState<PlanId>('full');
  const [role, setRole] = useState<Role>('retail');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const inline = touched ? validateCredentials(email, password) : null;

  const pickPlan = (p: PlanId) => {
    setPlan(p);
    setRole((r) => coerceRole(p, r));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const bad = validateCredentials(email, password);
    if (bad) return setErr(bad);
    setBusy(true);
    setErr(null);
    const r = mode === 'login' ? await signIn(email, password) : await signUp({ email, password, role, plan });
    setBusy(false);
    if (!r.ok) setErr(r.error);
    else onDone?.();
  };

  return (
    <div className="dark flex min-h-screen items-center justify-center bg-slate-950 bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.14),transparent_60%)] p-4">
      <form onSubmit={submit} noValidate data-testid="auth-form" className="scrollbar-thin max-h-[90vh] w-full max-w-md space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/70 p-5 shadow-2xl shadow-black/40 ring-1 ring-white/5 backdrop-blur-xl">
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
          <span className="relative mt-1 block"><input data-testid="auth-password" type={show ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} className={`${field} pr-14`} placeholder="At least 8 characters" /><button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} data-testid="auth-show" className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted hover:text-ink">{show ? 'Hide' : 'Show'}</button></span>
        </label>

        {mode === 'signup' && (
          <>
            <fieldset className="space-y-1">
              <legend className="mb-1 text-[12px] font-medium text-ink">Plan</legend>
              {PLANS.map((p) => (
                <label key={p.id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${plan === p.id ? 'border-blue-500/50 bg-blue-500/10 shadow-[0_0_12px_rgba(59,130,246,0.25)]' : 'border-slate-800 hover:bg-slate-800/60'}`}>
                  <input type="radio" name="plan" value={p.id} checked={plan === p.id} onChange={() => pickPlan(p.id)} data-testid={`plan-${p.id}`} className="accent-[rgb(var(--c-accent))]" />
                  <span className="flex-1"><b className="text-ink">Tier {p.tier} · {p.name}</b><span className="block text-muted">{p.blurb}</span></span>
                  <span className="num text-ink">{p.price}</span>
                </label>
              ))}
              <p className="text-[10px] text-muted">Prices are illustrative — no payment is taken.</p>
            </fieldset>
            <fieldset className="space-y-1">
              <legend className="mb-1 text-[12px] font-medium text-ink">Primary role</legend>
              {ROLES.map((r) => {
                const ok = canUse(plan, r.id);
                return (
                  <label key={r.id} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${!ok ? 'cursor-not-allowed border-slate-800 opacity-50' : role === r.id ? 'cursor-pointer border-blue-500/50 bg-blue-500/10 shadow-[0_0_12px_rgba(59,130,246,0.25)]' : 'cursor-pointer border-slate-800 hover:bg-slate-800/60'}`}>
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

        {(err ?? inline) && !err && <p data-testid="auth-inline" className="text-[11px] text-down">{inline}</p>}
        {err && <p role="alert" data-testid="auth-error" className="rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{err}</p>}
        <div className="sticky bottom-0 -mx-5 -mb-5 rounded-b-xl bg-slate-900/95 px-5 pb-5 pt-2 backdrop-blur-xl">
          <button type="submit" disabled={busy} data-testid="auth-submit" className="h-9 w-full rounded-md bg-accent text-[13px] font-bold text-white hover:brightness-110 disabled:opacity-60">
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
        </div>
        {backend === 'local' && <p className="text-[10px] text-muted">Demo mode: accounts are stored only in this browser. Set the Supabase variables for real accounts.</p>}
      </form>
    </div>
  );
}
