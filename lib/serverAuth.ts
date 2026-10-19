// Server-side: resolve the caller from a Supabase access token (never trust a client-supplied identity).
export async function whoami(token: string): Promise<{ id: string; email: string } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const u = (await r.json()) as { id?: string; email?: string };
    return u.id && u.email ? { id: u.id, email: u.email } : null;
  } catch {
    return null;
  }
}
export const bearer = (req: Request): string | undefined => /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
export const supabaseConfigured = (): boolean => Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
