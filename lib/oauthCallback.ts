// Server helpers for /auth/callback (Google OAuth, PKCE): exchange ?code= + the one-time verifier for a session, then hand the tokens to the
// browser through a tiny same-origin page that writes them where the Supabase auth backend reads them (never through a URL).
import { isVerifier } from './pkce';

export const NEXT_COOKIE = 'uc_next';
export const SESSION_STORAGE_KEY = 'upcircuit:auth:sb'; // same key lib/authBackends.ts uses

/** Only same-site relative paths are honoured for ?next= (no open redirect). */
export const safeNext = (n: string | null | undefined): string => (n && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : '/');

export type Exchange = { ok: true; access: string; refresh: string } | { ok: false; error: string };

export async function exchangeCode(supabaseUrl: string, anonKey: string, code: string | null, verifier: string | undefined, f: typeof fetch = fetch): Promise<Exchange> {
  if (!code || !/^[\w-]{8,200}$/.test(code)) return { ok: false, error: 'Google sign-in did not return a valid code — try again.' };
  if (!isVerifier(verifier)) return { ok: false, error: 'Your sign-in session expired — start Google sign-in again.' };
  try {
    const r = await f(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error_description?: string; msg?: string };
    if (!r.ok || !j.access_token) return { ok: false, error: j.error_description ?? j.msg ?? 'Google sign-in could not be completed.' };
    return { ok: true, access: j.access_token, refresh: j.refresh_token ?? '' };
  } catch {
    return { ok: false, error: 'Network error while finishing Google sign-in — try again.' };
  }
}

/** JSON that is safe inside an inline <script> */
export const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** HTML page that stores the session in localStorage and continues to `next`. */
export function bridgeHtml(tokens: { access: string; refresh: string }, next: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Signing in…</title></head>
<body style="margin:0;background:#020617;color:#cbd5e1;font:14px system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center">Signing you in…
<script>try{localStorage.setItem(${scriptJson(SESSION_STORAGE_KEY)},${scriptJson(JSON.stringify({ access: tokens.access, refresh: tokens.refresh }))})}catch(e){}location.replace(${scriptJson(next)});</script>
<noscript>JavaScript is required to finish signing in.</noscript></body></html>`;
}
