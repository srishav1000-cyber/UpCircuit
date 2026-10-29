// Structured (JSON-lines) server logging + optional Sentry reporting without an SDK (envelope POST). Never logs secrets.
const SECRET = /(authorization|cookie|token|secret|password|api[-_]?key|otp|service_role)/i;
export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 30).map(([k, x]) => [k, SECRET.test(k) ? '[redacted]' : redact(x, depth + 1)]));
  return v;
}
export const requestId = (req?: Request): string => req?.headers.get('x-request-id')?.slice(0, 64) || (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}, sink: (line: string) => void = (l) => (level === 'error' ? console.error(l) : console.log(l))): void {
  const min = ORDER[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;
  if (ORDER[level] < min) return;
  sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields) as object) }));
}

/** Parses https://<key>@<host>/<project> */
export function parseDsn(dsn: string | undefined): { key: string; host: string; project: string } | null {
  try {
    const u = new URL(dsn ?? '');
    const project = u.pathname.replace(/^\//, '');
    return u.username && project ? { key: u.username, host: u.origin, project } : null;
  } catch { return null; }
}

/** Fire-and-forget error report to Sentry (SENTRY_DSN) + a structured error log. Never throws. */
export async function captureException(err: unknown, ctx: Record<string, unknown> = {}, f: typeof fetch = fetch): Promise<void> {
  const e = err instanceof Error ? err : new Error(String(err));
  log('error', e.message, { stack: e.stack?.split('\n').slice(0, 6).join('\n'), ...ctx });
  const dsn = parseDsn(process.env.SENTRY_DSN);
  if (!dsn) return;
  const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`).replace(/-/g, '');
  const event = { event_id: id, timestamp: Date.now() / 1000, platform: 'javascript', level: 'error', environment: process.env.VERCEL_ENV || process.env.NODE_ENV, release: process.env.VERCEL_GIT_COMMIT_SHA, exception: { values: [{ type: e.name, value: e.message, stacktrace: undefined }] }, extra: redact(ctx), tags: { app: 'upcircuit' } };
  const body = [JSON.stringify({ event_id: id, sent_at: new Date().toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
  try {
    await f(`${dsn.host}/api/${dsn.project}/envelope/`, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=upcircuit/1.0` }, body, signal: AbortSignal.timeout(3000) });
  } catch { /* reporting must never break a request */ }
}

/** Wraps a route handler: request id, duration log, and captured 500 on a thrown error. */
export function withLog<A extends [Request, ...unknown[]]>(name: string, h: (...a: A) => Promise<Response>): (...a: A) => Promise<Response> {
  return async (...a: A) => {
    const rid = requestId(a[0]); const t0 = Date.now();
    try {
      const res = await h(...a);
      log(res.status >= 500 ? 'error' : 'info', 'request', { route: name, rid, status: res.status, ms: Date.now() - t0 });
      res.headers.set('x-request-id', rid);
      return res;
    } catch (err) {
      await captureException(err, { route: name, rid });
      return Response.json({ ok: false, error: 'Internal error', requestId: rid }, { status: 500, headers: { 'x-request-id': rid } });
    }
  };
}
