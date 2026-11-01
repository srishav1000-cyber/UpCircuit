'use client';

import { useEffect, useState } from 'react';
import { MIN_PASSWORD } from '@/lib/auth';
import { createSupabaseBackend } from '@/lib/authBackends';
import { appUrl } from '@/lib/appUrl';
import { UpCircuitLogo } from '@/components/UpCircuitLogo';

/** Landing page of the password-recovery e-mail: Supabase appends #access_token=…&type=recovery. The token lives only in memory; the hash is cleared at once. */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState('');
  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.replace(/^#/, '')), q = new URLSearchParams(window.location.search);
    const bad = h.get('error_description') ?? q.get('error_description');
    if (bad) setLinkErr(bad.replace(/\+/g, ' ').slice(0, 200));
    else if (h.get('type') === 'recovery' && h.get('access_token')) setToken(h.get('access_token'));
    else setLinkErr('This page opens from the link in your password-reset e-mail. Request a new link from the Log In tab.');
    history.replaceState(null, '', window.location.pathname); // don't leave the token in the URL / history
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw.length < MIN_PASSWORD) return setErr(`Password must be at least ${MIN_PASSWORD} characters.`);
    if (pw !== pw2) return setErr('The two passwords do not match.');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !token) return setErr('Password reset needs Supabase accounts.');
    setState('busy');
    const r = await createSupabaseBackend(url, key, localStorage).updatePassword!(token, pw);
    if (r.ok) { setState('done'); setToken(null); setTimeout(() => window.location.assign(appUrl('/login')), 2500); } else { setState('idle'); setErr(r.error); }
  };
  const field = 'w-full rounded-lg border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 outline-none focus:border-blue-500 focus:shadow-[0_0_12px_rgba(59,130,246,0.25)]';
  return (
    <main className="dark flex min-h-screen items-center justify-center bg-slate-950 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-950/40 via-slate-950 to-slate-950 p-4">
      <div data-testid="reset-card" className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl">
        <UpCircuitLogo size="sm" />
        <h1 className="mt-4 text-xl font-bold text-slate-100">Set a new password</h1>
        {state === 'done' ? <p role="status" data-testid="reset-done" className="mt-4 rounded-md bg-up/10 px-3 py-2 text-[13px] text-up">Password updated. Taking you to the log-in page…</p>
          : linkErr ? <><p role="alert" data-testid="reset-linkerr" className="mt-4 rounded-md bg-down/10 px-3 py-2 text-[13px] text-down">{linkErr}</p><a href={appUrl('/login')} className="mt-4 inline-block text-[13px] font-semibold text-blue-400 hover:text-blue-300">Back to log in</a></>
          : token ? (
            <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-3">
              <label className="text-[12px] text-slate-400">New password (min {MIN_PASSWORD} characters)<input data-testid="reset-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className={`${field} mt-1`} /></label>
              <label className="text-[12px] text-slate-400">Confirm new password<input data-testid="reset-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={`${field} mt-1`} /></label>
              {err && <p role="alert" data-testid="reset-error" className="rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{err}</p>}
              <button type="submit" disabled={state === 'busy'} data-testid="reset-submit" className="mt-1 rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-3 text-sm font-bold text-white disabled:opacity-60">{state === 'busy' ? 'Please wait…' : 'Update password'}</button>
            </form>
          ) : <p className="mt-4 text-[13px] text-slate-400">Checking your link…</p>}
      </div>
    </main>
  );
}
