import { NextRequest, NextResponse } from 'next/server';
import { appUrl } from '@/lib/appUrl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/smartapi/callback?auth_token=…&feed_token=…&refresh_token=…&state=…
 * Register `${NEXT_PUBLIC_APP_URL || 'https://upcircuit.vercel.app'}/api/smartapi/callback` as the redirect URL in the SmartAPI portal.
 * Validates the CSRF `state`, then hands the tokens to the relay (server→server, shared secret) — they never reach the browser.
 * Param names follow Angel's publisher-login redirect as recalled (UNVERIFIED — docs are auth-gated).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const done = (s: string) => NextResponse.redirect(appUrl(`/?smartapi=${s}`));
  const expect = req.cookies.get('sa_state')?.value;
  if (!expect || q.get('state') !== expect) return done('bad_state');
  const jwt = q.get('auth_token'), feed = q.get('feed_token');
  const relay = process.env.RELAY_HTTP_URL, secret = process.env.RELAY_ADMIN_SECRET;
  if (!jwt || !feed) return done('no_tokens');
  if (!relay || !secret) return done('relay_unconfigured');
  try {
    const r = await fetch(`${relay.replace(/\/+$/, '')}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-secret': secret },
      body: JSON.stringify({ jwt, feed, refresh: q.get('refresh_token') ?? undefined }),
      signal: AbortSignal.timeout(8000),
    });
    const res = done(r.ok ? 'ok' : 'relay_rejected');
    res.cookies.delete('sa_state');
    return res;
  } catch {
    return done('relay_unreachable');
  }
}
