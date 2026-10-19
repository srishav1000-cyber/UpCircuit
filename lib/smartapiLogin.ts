// Server-only: SmartAPI password + TOTP login. Only the FEED token and client code ever leave the server — never the JWT, password or TOTP secret.
import { totp } from './smartapi';

export const LOGIN_URL = 'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword';

export interface FeedSession {
  clientCode: string;
  feedToken: string;
  /** epoch ms until which this server instance reuses the session */
  expiresAt: number;
}
export type LoginResult = { ok: true; session: FeedSession } | { ok: false; reason: 'not_configured' | 'login_failed' | 'unreachable'; message: string };

export const SESSION_TTL_MS = 6 * 3600_000;

export async function smartApiLogin(env: Record<string, string | undefined> = process.env, f: typeof fetch = fetch, now = Date.now()): Promise<LoginResult> {
  const apiKey = env.SMARTAPI_API_KEY ?? env.NEXT_PUBLIC_SMARTAPI_API_KEY;
  const clientCode = env.SMARTAPI_CLIENT_CODE;
  const password = env.SMARTAPI_PASSWORD;
  const secret = env.SMARTAPI_TOTP_SECRET;
  if (!apiKey || !clientCode || !password || !secret) return { ok: false, reason: 'not_configured', message: 'SMARTAPI_API_KEY, SMARTAPI_CLIENT_CODE, SMARTAPI_PASSWORD and SMARTAPI_TOTP_SECRET must be set on the server.' };
  try {
    const res = await f(env.SMARTAPI_LOGIN_URL || LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': apiKey,
      },
      body: JSON.stringify({ clientcode: clientCode, password, totp: await totp(secret, now) }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: { feedToken?: string } };
    if (!j.status || !j.data?.feedToken) return { ok: false, reason: 'login_failed', message: j.message ?? `SmartAPI login failed (${res.status})` };
    return { ok: true, session: { clientCode, feedToken: j.data.feedToken, expiresAt: now + SESSION_TTL_MS } };
  } catch {
    return { ok: false, reason: 'unreachable', message: 'Could not reach SmartAPI.' };
  }
}
