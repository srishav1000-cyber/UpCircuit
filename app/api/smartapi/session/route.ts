import { NextRequest } from 'next/server';
import { allow } from '@/lib/ttlCache';
import { bearer, supabaseConfigured, whoami } from '@/lib/serverAuth';
import { smartApiLogin, type FeedSession } from '@/lib/smartapiLogin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let cached: FeedSession | null = null; // per server instance (serverless instances each log in at most once per TTL)
let inflight: Promise<unknown> | null = null;
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { 'cache-control': 'no-store' } });

/**
 * GET /api/smartapi/session[?refresh=1]
 * Logs in to SmartAPI with the server-side secrets (SMARTAPI_API_KEY, _CLIENT_CODE, _PASSWORD, _TOTP_SECRET) and returns ONLY
 * { clientCode, feedToken } — enough for the browser to open the market-data socket. The JWT, password and TOTP secret never leave the server.
 * Auth: a verified Supabase session. With no Supabase configured (demo accounts) it is refused unless SMARTAPI_SESSION_PUBLIC=1,
 * because the feed token is the owner's credential and this endpoint would otherwise hand it to anyone.
 */
export async function GET(req: NextRequest) {
  if (supabaseConfigured()) {
    const t = bearer(req);
    const user = t ? await whoami(t) : null;
    if (!user) return json({ ok: false, reason: 'unauthorized', message: 'Sign in with a Supabase account to use the live feed.' }, 401);
    if (!allow(`sa-sess:${user.id}`, 20, 60_000)) return json({ ok: false, reason: 'rate_limited', message: 'Too many requests.' }, 429);
  } else if (process.env.SMARTAPI_SESSION_PUBLIC !== '1') {
    return json({ ok: false, reason: 'unauthorized', message: 'Live feed sessions need Supabase accounts (or SMARTAPI_SESSION_PUBLIC=1 for a private deployment).' }, 401);
  } else if (!allow('sa-sess:public', 30, 60_000)) return json({ ok: false, reason: 'rate_limited', message: 'Too many requests.' }, 429);

  const refresh = req.nextUrl.searchParams.get('refresh') === '1';
  if (cached && cached.expiresAt > Date.now() && !(refresh && allow('sa-refresh', 1, 60_000))) return json({ ok: true, clientCode: cached.clientCode, feedToken: cached.feedToken, expiresAt: cached.expiresAt });

  if (!allow('sa-login', 3, 60_000)) return json({ ok: false, reason: 'rate_limited', message: 'SmartAPI login throttled — retry shortly.' }, 429);
  inflight ??= smartApiLogin().finally(() => (inflight = null));
  const r = (await inflight) as Awaited<ReturnType<typeof smartApiLogin>>;
  if (!r.ok) return json({ ok: false, reason: r.reason, message: r.message }, r.reason === 'not_configured' ? 501 : 502);
  cached = r.session;
  return json({ ok: true, clientCode: r.session.clientCode, feedToken: r.session.feedToken, expiresAt: r.session.expiresAt });
}
