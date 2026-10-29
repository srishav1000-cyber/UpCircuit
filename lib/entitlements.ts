// Server-side plan entitlements. The plan lives in profiles.plan (billing-owned: the browser cannot change it — docs/PERSISTENCE_SCHEMA.sql).
import { allowAsync, TtlCache } from './ttlCache';
import { bearer, supabaseConfigured, whoami } from './serverAuth';

import { ANON_AI_PER_HOUR, ENTITLEMENTS, coercePlan, type PlanId } from './entitlements-shared';
export { ANON_AI_PER_HOUR, ENTITLEMENTS, coercePlan };
export type { PlanId };

const cache = new TtlCache<PlanId>(5 * 60_000, 2000);
/** Reads the caller's plan through RLS with THEIR token (they can only ever see their own profile row). */
export async function fetchPlan(token: string, userId: string, f: typeof fetch = fetch): Promise<PlanId> {
  const hit = cache.get(userId);
  if (hit) return hit.value;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
  try {
    const r = await f(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=plan`, { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
    const plan = coercePlan(((await r.json()) as { plan?: string }[])?.[0]?.plan);
    cache.set(userId, plan);
    return plan;
  } catch { return 'retail'; }
}

/** Per-plan hourly AI quota (Ask / Copilot / report notes). Returns a 429 Response when exceeded, otherwise null. */
export async function enforceAiQuota(req: Request): Promise<Response | null> {
  const token = bearer(req);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
  if (!supabaseConfigured()) return null; // demo / self-hosted without accounts: the per-IP limiter still applies
  const user = token ? await whoami(token) : null;
  if (!user) return (await allowAsync(`ai-anon:${ip}`, ANON_AI_PER_HOUR, 3600_000)) ? null : Response.json({ error: 'Sign in for a higher AI quota.', code: 'quota_anon' }, { status: 429 });
  const plan = await fetchPlan(token as string, user.id);
  const lim = ENTITLEMENTS[plan].aiPerHour;
  return (await allowAsync(`ai:${user.id}`, lim, 3600_000)) ? null : Response.json({ error: `Your ${plan === 'day' ? 'Day Trader' : plan === 'retail' ? 'Retail' : 'Full Access'} plan allows ${lim} AI answers per hour. Try later or upgrade.`, code: 'quota_plan', limit: lim }, { status: 429 });
}
