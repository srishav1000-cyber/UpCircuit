import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { smartApiCallbackUrl } from '@/lib/appUrl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/smartapi/login — starts SmartAPI publisher login. UNVERIFIED against Angel's docs (auth-gated): confirm the login URL and that
 * the redirect URL below is registered in the SmartAPI portal for your app.
 */
export async function GET() {
  const apiKey = process.env.SMARTAPI_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: 'SMARTAPI_API_KEY not set.' }, { status: 501 });
  const state = randomBytes(16).toString('hex');
  const res = NextResponse.redirect(`https://smartapi.angelone.in/publisher-login?api_key=${encodeURIComponent(apiKey)}&state=${state}`);
  res.cookies.set('sa_state', state, { httpOnly: true, secure: smartApiCallbackUrl().startsWith('https'), sameSite: 'lax', path: '/api/smartapi', maxAge: 600 });
  return res;
}
