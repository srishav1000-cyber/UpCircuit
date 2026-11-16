// Server-side Supabase REST helpers for a privileged key (shared by the Next.js routes and the alert daemon).
//  • legacy service_role keys are JWTs (`eyJ…`) → sent as `apikey` AND `Authorization: Bearer`
//  • new-style secret keys (`sb_secret_…`) are NOT JWTs → sent as `apikey` only (the API gateway swaps in a short-lived service_role JWT;
//    a Bearer of the opaque key is rejected)
//  • env values pasted into a dashboard often carry a trailing newline, spaces or wrapping quotes — those make an otherwise valid key fail with 401/403

/** trims whitespace/newlines, strips one pair of wrapping quotes and removes any inner whitespace (keys and URLs never contain any) */
export function cleanEnv(v: string | undefined | null): string {
  if (!v) return '';
  let s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  return s.replace(/\s+/g, '');
}
/** project URL without trailing slashes or an accidental `/rest/v1` suffix */
export const cleanUrl = (v: string | undefined | null): string => cleanEnv(v).replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');

export const isOpaqueKey = (key: string): boolean => /^sb_(secret|publishable)_/.test(key);
export type KeyKind = 'sb_secret' | 'sb_publishable' | 'jwt_service_role' | 'jwt_anon' | 'jwt_other' | 'empty' | 'unrecognised';
/** what kind of key is this? (reads only the public JWT payload; never returns the key) */
export function keyKind(raw: string | undefined | null): KeyKind {
  const k = cleanEnv(raw);
  if (!k) return 'empty';
  if (k.startsWith('sb_secret_')) return 'sb_secret';
  if (k.startsWith('sb_publishable_')) return 'sb_publishable';
  const parts = k.split('.');
  if (parts.length === 3) {
    try {
      const role = (JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { role?: unknown }).role;
      return role === 'service_role' ? 'jwt_service_role' : role === 'anon' ? 'jwt_anon' : 'jwt_other';
    } catch { return 'unrecognised'; }
  }
  return 'unrecognised';
}
/** a human reason when a key is definitely NOT a privileged server key (null = plausible; unknown formats such as self-hosted keys are let through and Supabase decides) */
export function privilegedKeyProblem(raw: string | undefined | null): string | null {
  switch (keyKind(raw)) {
    case 'empty': return 'SUPABASE_SERVICE_ROLE_KEY is not set';
    case 'sb_publishable': return 'SUPABASE_SERVICE_ROLE_KEY holds a publishable (public) key — use the secret key (sb_secret_…) or the legacy service_role key';
    case 'jwt_anon': return 'SUPABASE_SERVICE_ROLE_KEY holds the anon key — use the service_role key (or an sb_secret_… key)';
    default: return null;
  }
}

export function adminHeaders(rawKey: string, json = false): Record<string, string> {
  const key = cleanEnv(rawKey);
  const h: Record<string, string> = { apikey: key };
  if (!isOpaqueKey(key)) h.Authorization = `Bearer ${key}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
/** headers for acting as a signed-in user (RLS applies): anon/publishable key + the user's access token */
export const userHeaders = (anonKey: string, token: string): Record<string, string> => ({ apikey: cleanEnv(anonKey), Authorization: `Bearer ${token}` });
export const resendConfigured = (): boolean => Boolean(cleanEnv(process.env.RESEND_API_KEY));

/** the exact failure PostgREST / the gateway returned */
export interface SbFailure { status: number | null; code?: string; message: string; hint?: string }
export async function sbFailure(r: Response | null, err?: unknown): Promise<SbFailure> {
  if (!r) return { status: null, message: err instanceof Error ? err.message : 'network error' };
  const text = await r.text().catch(() => '');
  let j: { code?: unknown; message?: unknown; msg?: unknown; error?: unknown; error_description?: unknown; hint?: unknown; details?: unknown } = {};
  try { j = JSON.parse(text); } catch { /* plain text body */ }
  const pick = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
  const message = pick(j.message) ?? pick(j.msg) ?? pick(j.error_description) ?? pick(j.error) ?? (text.trim().slice(0, 300) || r.statusText || 'no response body');
  return { status: r.status, code: pick(j.code), message: message.slice(0, 300), hint: pick(j.hint) ?? pick(j.details) };
}
export const sbFailureText = (f: SbFailure): string => `${f.status ?? 'network'}${f.code ? ` ${f.code}` : ''}: ${f.message}${f.hint ? ` (${f.hint})` : ''}`;
