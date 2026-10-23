import { NextRequest, NextResponse } from 'next/server';
import { appUrl } from '@/lib/appUrl';
import { PKCE_COOKIE } from '@/lib/pkce';
import { NEXT_COOKIE, bridgeHtml, exchangeCode, safeNext } from '@/lib/oauthCallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const back = (msg: string) => NextResponse.redirect(appUrl(`/login?error=${encodeURIComponent(msg)}`), { status: 303 });

/** GET /auth/callback?code=… — Supabase redirects here after Google. Exchanges the code (PKCE) for a session and hands it to the browser. */
export async function GET(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return back('Google sign-in needs Supabase accounts to be configured.');
  const q = req.nextUrl.searchParams;
  const err = q.get('error_description') ?? q.get('error');
  const verifier = req.cookies.get(PKCE_COOKIE)?.value;
  const res = err ? null : await exchangeCode(url, key, q.get('code'), verifier);
  const clear = (r: NextResponse) => {
    r.cookies.set(PKCE_COOKIE, '', { path: '/auth', maxAge: 0 });
    r.cookies.set(NEXT_COOKIE, '', { path: '/auth', maxAge: 0 });
    return r;
  };
  if (err) return clear(back(err.slice(0, 200)));
  if (!res || !res.ok) return clear(back(res?.error ?? 'Google sign-in failed.'));
  const html = bridgeHtml({ access: res.access, refresh: res.refresh }, appUrl(safeNext(req.cookies.get(NEXT_COOKIE)?.value)));
  return clear(new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }));
}
