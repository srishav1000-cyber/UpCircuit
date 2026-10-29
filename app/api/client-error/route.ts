import { NextRequest } from 'next/server';
import { allowAsync } from '@/lib/ttlCache';
import { captureException } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/client-error { message, stack?, where? } — browser error boundary → structured log (+ Sentry when SENTRY_DSN is set). Rate-limited, size-capped, no identity attached. */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!(await allowAsync(`cerr:${ip}`, 10, 60_000))) return Response.json({ ok: false }, { status: 429 });
  const b = (await req.json().catch(() => null)) as { message?: unknown; stack?: unknown; where?: unknown } | null;
  if (!b || typeof b.message !== 'string') return Response.json({ ok: false }, { status: 400 });
  const err = new Error(b.message.slice(0, 300)); err.stack = typeof b.stack === 'string' ? b.stack.slice(0, 1500) : undefined;
  await captureException(err, { source: 'browser', where: typeof b.where === 'string' ? b.where.slice(0, 80) : undefined });
  return Response.json({ ok: true });
}
