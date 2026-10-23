// PKCE (RFC 7636) for the Supabase Google OAuth round-trip: the browser keeps a one-time verifier in a short-lived cookie,
// sends only its SHA-256 challenge to Google/Supabase, and app/auth/callback/route.ts exchanges ?code= + verifier for a session.
export const PKCE_COOKIE = 'uc_pkce';
export const PKCE_TTL_SEC = 600;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...Array.from(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** 64 URL-safe characters (48 random bytes) */
export const newVerifier = (): string => b64url(crypto.getRandomValues(new Uint8Array(48)));
export async function challengeOf(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}
export const isVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(v);
