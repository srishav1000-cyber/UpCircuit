// Server-side Supabase REST headers for a privileged key.
//  • legacy service_role keys are JWTs → sent as `apikey` AND `Authorization: Bearer`
//  • new-style secret keys (`sb_secret_…`) are NOT JWTs → sent as `apikey` only (a Bearer of one is rejected with 401/403 → "Could not read your devices.")
export const isOpaqueKey = (key: string): boolean => /^sb_(secret|publishable)_/.test(key);
export function adminHeaders(key: string, json = false): Record<string, string> {
  const h: Record<string, string> = { apikey: key };
  if (!isOpaqueKey(key)) h.Authorization = `Bearer ${key}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
/** headers for acting as a signed-in user (RLS applies): anon/publishable key + the user's access token */
export const userHeaders = (anonKey: string, token: string): Record<string, string> => ({ apikey: anonKey, Authorization: `Bearer ${token}` });
export const resendConfigured = (): boolean => Boolean(process.env.RESEND_API_KEY);
