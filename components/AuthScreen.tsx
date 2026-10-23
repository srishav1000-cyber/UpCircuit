'use client';

import { useEffect, useRef, useState } from 'react';
import { OTP_RE, PLANS, ROLES, canUse, coerceRole, normalizeIndianMobile, planOf, validateCredentials, type PlanId, type Role } from '@/lib/auth';
import { safeNext } from '@/lib/oauthCallback';
import { useAuth } from '@/hooks/useAuth';
import { UpCircuitLogo } from './UpCircuitLogo';

const field = 'w-full rounded-lg border border-slate-700 bg-slate-950/60 px-4 py-3.5 text-sm lg:text-[15px] text-slate-100 outline-none placeholder:text-transparent focus:border-blue-500 focus:shadow-[0_0_12px_rgba(59,130,246,0.25)]';
const SHORT: Record<string, string> = { institutional: 'Institutional', executive: 'Executive / Risk' };

/** Email + password login / sign-up. On sign-up the user picks a plan (Tier 1–3) and a primary role with radio buttons. */
export function AuthScreen({ onDone }: { onDone?: () => void } = {}) {
  const { signIn, signUp, signInWithGoogle, sendOtp, verifyOtp, backend } = useAuth();
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
  const [method, setMethod] = useState<'email' | 'phone'>('email');
  const [phone, setPhone] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [wait, setWait] = useState(0);
  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get('error'); // set by /auth/callback when Google sign-in fails
    if (e) setErr(e.slice(0, 200));
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const e164 = normalizeIndianMobile(phone);

  const pickPlan = (p: PlanId) => {
    setPlan(p);
    setRole((r) => coerceRole(p, r));
  };
  const google = async () => {
    setErr(null);
    const r = await signInWithGoogle(safeNext(new URLSearchParams(window.location.search).get('next')));
    if (r.error !== 'Redirecting to Google…') setErr(r.error);
  };
  const sendCode = async () => {
    if (!e164) return setErr('Enter a valid 10-digit Indian mobile number (starts with 6–9).');
    setBusy(true);
    setErr(null);
    const r = await sendOtp(e164, mode === 'signup' ? { role, plan } : undefined);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setOtpSent(true);
    setOtp('');
    setWait(30);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (method === 'phone') {
      if (!otpSent) return sendCode();
      if (!OTP_RE.test(otp) || !e164) return setErr('Enter the 6-digit code we texted you.');
      setBusy(true);
      setErr(null);
      const r = await verifyOtp(e164, otp);
      setBusy(false);
      if (!r.ok) setErr(r.error);
      else onDone?.();
      return;
    }
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

  const tile = (active: boolean, disabled = false) =>
    `flex min-w-0 flex-col items-center justify-center rounded-lg border px-4 py-3 text-center text-[11px] leading-tight lg:text-[13px] transition ${disabled ? 'cursor-not-allowed border-slate-800 text-slate-600 opacity-50' : active ? 'cursor-pointer border-blue-500 bg-blue-500/15 text-white shadow-[0_0_15px_rgba(59,130,246,0.3)]' : 'cursor-pointer border-slate-800 bg-slate-900/40 text-slate-300 hover:border-slate-700 hover:bg-slate-800/60'}`;
  const FEATURES = ['Real-Time SmartAPI Feeds', 'Circuit Breaker Chimes', 'Portfolio Risk HHI Engine', 'Gemini AI Copilot'];
  const lbl = 'peer-placeholder-shown:bg-transparent peer-placeholder-shown:top-4 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-[10px]';

  return (
    <div className="dark flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-950/40 via-slate-950 to-slate-950 p-3 sm:p-6">
      <div data-testid="auth-card" className="grid max-h-[96vh] w-full max-w-5xl grid-cols-1 gap-4 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl sm:p-6 md:grid-cols-2 md:gap-8 md:p-8 lg:max-w-6xl lg:gap-14 lg:p-12 xl:max-w-7xl xl:gap-20 xl:p-16">
        {/* LEFT · brand hero */}
        <section className="hidden flex-col justify-center gap-5 md:flex lg:gap-7" data-testid="auth-hero">
          <UpCircuitLogo size="hero" showText={false} className="[&_svg]:h-20 [&_svg]:w-20 lg:[&_svg]:h-24 lg:[&_svg]:w-24" />
          <h1 className="bg-gradient-to-r from-blue-400 via-indigo-300 to-emerald-400 bg-clip-text text-3xl font-black leading-tight tracking-tight text-transparent lg:text-5xl">UpCircuit Terminal</h1>
          <p className="max-w-md text-base leading-relaxed text-slate-400 lg:text-lg">Real-Time Decision-Support Financial Analytics for Indian Equity Markets</p>
          <ul className="flex flex-wrap gap-2">
            {FEATURES.map((f) => (
              <li key={f} className="rounded-full border border-slate-700/80 bg-slate-900/70 px-4 py-2 text-xs font-medium lg:text-sm text-slate-200 shadow-[0_0_12px_rgba(59,130,246,0.15)]"><span className="mr-1 text-emerald-400">●</span>{f}</li>
            ))}
          </ul>
        </section>

        {/* RIGHT · form */}
        <form onSubmit={submit} noValidate data-testid="auth-form" className="flex min-w-0 flex-col gap-3 overflow-y-auto lg:gap-4">
          <div className="md:hidden"><UpCircuitLogo size="sm" /></div>
          <button type="button" onClick={google} data-testid="auth-google" className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-700 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-100 lg:text-[15px]">
            <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
            Continue with Google
          </button>
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-slate-500"><span className="h-px flex-1 bg-slate-800" />or<span className="h-px flex-1 bg-slate-800" /></div>
          <div className="grid grid-cols-2 gap-1 rounded-full border border-slate-800 bg-slate-950/70 p-1 text-[12px] font-semibold" role="tablist">
            {(['signup', 'login'] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} data-testid={`auth-tab-${m}`} onClick={() => { setMode(m); setErr(null); }} className={`rounded-full py-2.5 transition ${mode === m ? 'bg-blue-500/20 text-white shadow-[0_0_12px_rgba(59,130,246,0.3)]' : 'text-slate-400 hover:text-slate-200'}`}>
                {m === 'signup' ? 'Sign Up' : 'Log In'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-800 bg-slate-950/70 p-1 text-[12px] font-semibold" role="tablist" aria-label="Sign-in method">
            {([['email', 'Email'], ['phone', 'Phone OTP']] as const).map(([m, label]) => (
              <button key={m} type="button" role="tab" aria-selected={method === m} data-testid={`auth-method-${m}`} onClick={() => { setMethod(m); setErr(null); }} className={`rounded-md py-2 transition ${method === m ? 'bg-slate-700/70 text-white' : 'text-slate-400 hover:text-slate-200'}`}>{label}</button>
            ))}
          </div>
          {method === 'email' && (
            <>
          <div className="relative mt-1.5">
            <input id="auth-email" data-testid="auth-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder=" " className={`${field} peer`} />
            <label htmlFor="auth-email" className={`pointer-events-none absolute left-3 top-4 bg-slate-900 px-1 text-slate-400 transition-all ${lbl}`}>Email</label>
          </div>
          <div className="relative mt-1.5">
            <input id="auth-password" data-testid="auth-password" type={show ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder=" " className={`${field} peer pr-14`} />
            <label htmlFor="auth-password" className={`pointer-events-none absolute left-3 top-4 bg-slate-900 px-1 text-slate-400 transition-all ${lbl}`}>Password (min 8 characters)</label>
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} data-testid="auth-show" className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400 hover:text-white">{show ? 'Hide' : 'Show'}</button>
          </div>

            </>
          )}
          {method === 'phone' && (
            <div className="flex flex-col gap-3" data-testid="auth-phone-form">
              <div className="flex gap-2">
                <span className="flex items-center rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-sm font-semibold text-slate-300" aria-label="Country code">🇮🇳 +91</span>
                <input data-testid="auth-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={14} value={phone} disabled={otpSent} onChange={(e) => setPhone(e.target.value.replace(/[^\d\s-]/g, ''))} placeholder="10-digit mobile number" aria-label="Mobile number" className={`${field} placeholder:text-slate-500 disabled:opacity-60`} />
              </div>
              {otpSent && (
                <div data-testid="auth-otp-block">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400"><span>Enter the 6-digit code sent to {e164 ?? phone}</span><button type="button" onClick={() => { setOtpSent(false); setOtp(''); setErr(null); }} className="font-semibold text-blue-400 hover:text-blue-300" data-testid="auth-change-phone">Change number</button></div>
                  <OtpInput value={otp} onChange={setOtp} />
                  <button type="button" disabled={wait > 0 || busy} onClick={sendCode} data-testid="auth-resend" className="mt-2 text-[11px] font-semibold text-blue-400 hover:text-blue-300 disabled:text-slate-600">{wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}</button>
                </div>
              )}
              <p className="text-[10px] text-slate-500">We text a one-time code (standard SMS rates may apply). New numbers create an account.</p>
            </div>
          )}
          {mode === 'signup' && (
            <>
              <fieldset>
                <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Plan</legend>
                <div className="grid grid-cols-3 gap-2">
                  {PLANS.map((p) => (
                    <label key={p.id} className={tile(plan === p.id)}>
                      <input type="radio" name="plan" value={p.id} checked={plan === p.id} onChange={() => pickPlan(p.id)} data-testid={`plan-${p.id}`} className="sr-only" />
                      <b className="font-semibold">Tier {p.tier}: {p.name}</b>
                      <span className="num mt-0.5 text-[10px] opacity-80">{p.price.replace(' / mo', '/mo').replace('₹ ', '₹')}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-slate-500">Prices are illustrative — no payment is taken.</p>
              </fieldset>
              <fieldset>
                <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Primary role</legend>
                <div className="grid grid-cols-2 gap-2">
                  {ROLES.map((r) => {
                    const ok = canUse(plan, r.id);
                    return (
                      <label key={r.id} title={ok ? r.blurb : `Not in ${planOf(plan).name}`} className={tile(role === r.id, !ok)}>
                        <input type="radio" name="role" value={r.id} disabled={!ok} checked={role === r.id} onChange={() => setRole(r.id)} data-testid={`role-${r.id}`} className="sr-only" />
                        <span className="font-semibold"><span aria-hidden>{r.icon}</span> {SHORT[r.id] ?? r.label}{!ok && ' 🔒'}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </>
          )}

          {method === 'email' && (err ?? inline) && !err && <p data-testid="auth-inline" className="text-[11px] text-down">{inline}</p>}
          {err && <p role="alert" data-testid="auth-error" className="rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{err}</p>}
          <button type="submit" disabled={busy} data-testid="auth-submit" className="mt-1 w-full rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-4 text-base font-bold lg:text-lg text-white shadow-[0_0_18px_rgba(59,130,246,0.35)] hover:brightness-110 disabled:opacity-60">
            {busy ? 'Please wait…' : method === 'phone' ? (otpSent ? 'Verify & continue' : 'Send code') : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
          {backend === 'local' && <p className="text-[10px] text-slate-500">Demo mode: accounts are stored only in this browser. Set the Supabase variables for real accounts.</p>}
        </form>
      </div>
    </div>
  );
}

/** Six single-digit boxes: auto-advance, backspace goes back, paste fills all six. `value` is the digits typed so far. */
export function OtpInput({ value, onChange, testid = 'auth-otp' }: { value: string; onChange: (v: string) => void; testid?: string }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(6, ' ').split('');
  const set = (i: number, d: string) => {
    const next = (value.slice(0, i) + d + value.slice(i + 1)).replace(/\D/g, '').slice(0, 6);
    onChange(next);
  };
  return (
    <div className="flex gap-2" data-testid={testid} onPaste={(e) => { const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6); if (t) { e.preventDefault(); onChange(t); refs.current[Math.min(t.length, 5)]?.focus(); } }}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          data-testid={`${testid}-${i}`}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          aria-label={`Digit ${i + 1}`}
          value={d.trim()}
          onChange={(e) => { const c = e.target.value.replace(/\D/g, '').slice(-1); if (!c) return; set(i, c); refs.current[i + 1]?.focus(); }}
          onKeyDown={(e) => { if (e.key === 'Backspace') { e.preventDefault(); if (d.trim()) onChange(value.slice(0, i) + value.slice(i + 1)); else if (i > 0) { onChange(value.slice(0, i - 1) + value.slice(i)); refs.current[i - 1]?.focus(); } } }}
          className="h-12 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950/60 text-center text-lg font-bold text-slate-100 outline-none focus:border-blue-500 focus:shadow-[0_0_12px_rgba(59,130,246,0.25)]"
        />
      ))}
    </div>
  );
}
