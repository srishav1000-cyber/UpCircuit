// HTTP surface of the alert daemon. Everything here answers from IN-MEMORY state only — no database, SmartAPI or Realtime call, and nothing is mutated —
// so an external keep-alive / uptime pinger (or the host's health check) can hit it as often as it likes without affecting alert evaluation.
//   GET|HEAD /  and  /health   liveness: always 200 while the process is serving  { ok, role, epoch, feed, uptimeSec, timestamp }
//   GET|HEAD /healthz          readiness / diagnostics: full status, 503 when the leader's feed is silent during market hours
import { createServer, type Server } from 'node:http';

export interface Liveness { ok: true; role: 'leader' | 'standby'; epoch: number; feed: string; uptimeSec: number; timestamp: string }
export interface HealthDeps {
  liveness(): Liveness;
  readiness(): { ok: boolean; body: unknown };
}
export interface HealthReply { status: number; headers: Record<string, string>; body: string }

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const;

/** pure routing: method + URL → reply. Query strings and a trailing slash are ignored. */
export function routeHealth(method: string | undefined, rawUrl: string | undefined, deps: HealthDeps): HealthReply {
  const m = (method ?? 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return { status: 405, headers: { ...JSON_HEADERS, Allow: 'GET, HEAD' }, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  let path = '/';
  try { path = new URL(rawUrl || '/', 'http://daemon.local').pathname; } catch { /* malformed → treated as "/" */ }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/' || path === '/health') return { status: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify(deps.liveness()) };
  if (path === '/healthz') { const r = deps.readiness(); return { status: r.ok ? 200 : 503, headers: { ...JSON_HEADERS }, body: JSON.stringify(r.body) }; }
  return { status: 404, headers: { ...JSON_HEADERS }, body: JSON.stringify({ ok: false, error: 'not found' }) };
}

/** binds immediately (default 0.0.0.0, what Render's port scan and external pingers need); resolves once listening, rejects on EADDRINUSE etc. */
export function startHealthServer(opts: { port: number; host?: string; deps: HealthDeps }): Promise<Server> {
  const server = createServer((req, res) => {
    let r: HealthReply;
    try { r = routeHealth(req.method, req.url, opts.deps); }
    catch { r = { status: 500, headers: { ...JSON_HEADERS }, body: JSON.stringify({ ok: false, error: 'status unavailable' }) }; }
    res.writeHead(r.status, { ...r.headers, 'Content-Length': Buffer.byteLength(r.body) });
    res.end(req.method === 'HEAD' ? undefined : r.body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => { server.off('error', reject); resolve(server); });
  });
}
