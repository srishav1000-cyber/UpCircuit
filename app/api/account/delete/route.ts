import { NextRequest } from 'next/server';
import { allowAsync } from '@/lib/ttlCache';
import { bearer, supabaseConfigured, whoami } from '@/lib/serverAuth';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/account/delete { confirm: "DELETE" } + Bearer — DPDP erasure.
 * 1) delete_my_data() runs AS THE USER (erases their rows, writes the retained audit entry, refuses for the last admin);
 * 2) the auth user is then removed with the service key (browser can't). Needs SUPABASE_SERVICE_ROLE_KEY.
 */
export async function POST(req: NextRequest) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseConfigured() || !key) return Response.json({ ok: false, error: 'Account deletion is not configured on this server.' }, { status: 501 });
  const token = bearer(req);
  const user = token ? await whoami(token) : null;
  if (!user || !token) return Response.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
  if (!(await allowAsync(`acct-del:${user.id}`, 3, 3600_000))) return Response.json({ ok: false, error: 'Too many attempts.' }, { status: 429 });
  const b = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (b?.confirm !== 'DELETE') return Response.json({ ok: false, error: 'Type DELETE to confirm.' }, { status: 400 });

  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL as string).replace(/\/+$/, '');
  const erase = await fetch(`${base}/rest/v1/rpc/delete_my_data`, { method: 'POST', headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!erase || !erase.ok) {
    const msg = erase ? ((await erase.json().catch(() => ({}))) as { message?: string }).message : undefined;
    return Response.json({ ok: false, error: msg ?? 'Could not erase your data.' }, { status: erase?.status === 400 || erase?.status === 403 ? 409 : 502 });
  }
  const del = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  log('info', 'account deleted', { user: user.id, authRemoved: !!del?.ok });
  return Response.json({ ok: true, authRemoved: !!del?.ok });
}
