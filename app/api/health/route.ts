export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/health — liveness + dependency reachability (Supabase auth health, SmartAPI socket DNS-free check is skipped: it is browser-side). Public, values-free. */
export async function GET() {
  const t0 = Date.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let database: 'ok' | 'down' | 'not_configured' = 'not_configured';
  let dbMs: number | null = null;
  if (url) {
    const s = Date.now();
    database = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/health`, { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '' }, signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? 'ok' : 'down')).catch(() => 'down' as const);
    dbMs = Date.now() - s;
  }
  const body = {
    ok: database !== 'down',
    time: new Date().toISOString(),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
    database, dbMs,
    worker: { configured: Boolean(process.env.CRON_SECRET && process.env.SUPABASE_SERVICE_ROLE_KEY) },
    redis: { configured: Boolean(process.env.UPSTASH_REDIS_REST_URL) },
    errorReporting: { configured: Boolean(process.env.SENTRY_DSN) },
    ms: Date.now() - t0,
  };
  return Response.json(body, { status: body.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
