import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeHealth, startHealthServer, type HealthDeps } from '../daemon/health';
import { nextRefreshAt, lastOpenAt, sessionDeadline } from '../daemon/session';
import { createLease, type LeaseRow } from '../daemon/lease';

const mk = (over: Partial<HealthDeps> = {}): { deps: HealthDeps; calls: { live: number; ready: number } } => {
  const calls = { live: 0, ready: 0 };
  return { calls, deps: {
    liveness: () => { calls.live++; return { ok: true, role: 'leader', epoch: 7, feed: 'open', uptimeSec: 42, timestamp: new Date().toISOString() }; },
    readiness: () => { calls.ready++; return { ok: true, body: { ok: true, detail: 'full' } }; },
    ...over,
  } };
};

test('GET / and /health → 200 application/json with { ok, role, epoch, feed, uptimeSec, timestamp }; ?query and trailing slash tolerated', () => {
  for (const url of ['/', '/health', '/health/', '/health?ping=1', '/?x=1']) {
    const { deps } = mk(); const r = routeHealth('GET', url, deps);
    assert.equal(r.status, 200, url); assert.match(r.headers['Content-Type'], /^application\/json/); assert.equal(r.headers['Cache-Control'], 'no-store');
    const j = JSON.parse(r.body); assert.deepEqual(Object.keys(j).sort(), ['epoch', 'feed', 'ok', 'role', 'timestamp', 'uptimeSec']);
    assert.equal(j.ok, true); assert.equal(j.role, 'leader'); assert.equal(j.epoch, 7); assert.equal(j.feed, 'open'); assert.equal(j.uptimeSec, 42); assert.ok(!Number.isNaN(Date.parse(j.timestamp)));
  }
});

test('keep-alive pings only read the liveness snapshot (never the readiness / heavy path); HEAD and unknown paths / methods behave', () => {
  const { deps, calls } = mk();
  for (let i = 0; i < 50; i++) routeHealth('GET', '/health', deps);
  assert.deepEqual(calls, { live: 50, ready: 0 });
  assert.equal(routeHealth('HEAD', '/health', deps).status, 200);
  assert.equal(routeHealth('GET', '/nope', deps).status, 404);
  const post = routeHealth('POST', '/health', deps); assert.equal(post.status, 405); assert.equal(post.headers.Allow, 'GET, HEAD');
});

test('/healthz is the readiness probe: 503 when not ok, and a failing snapshot never crashes the server', async () => {
  assert.equal(routeHealth('GET', '/healthz', mk({ readiness: () => ({ ok: false, body: { ok: false } }) }).deps).status, 503);
  const { deps } = mk({ liveness: () => { throw new Error('boom'); } });
  const server = await startHealthServer({ port: 0, deps });
  try { const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/health`); assert.equal(r.status, 500); assert.equal((await r.json()).ok, false); }
  finally { await new Promise((r) => server.close(r)); }
});

test('real server: binds 0.0.0.0, GET / and /health return 200 JSON, HEAD has no body, state is untouched', async () => {
  const { deps, calls } = mk();
  const server = await startHealthServer({ port: 0, deps });
  const addr = server.address() as { address: string; port: number };
  try {
    assert.equal(addr.address, '0.0.0.0');
    for (const path of ['/', '/health']) {
      const r = await fetch(`http://127.0.0.1:${addr.port}${path}`); assert.equal(r.status, 200); assert.match(r.headers.get('content-type')!, /application\/json/);
      const j = await r.json(); for (const k of ['ok', 'role', 'epoch', 'feed', 'uptimeSec', 'timestamp']) assert.ok(k in j, k);
    }
    const h = await fetch(`http://127.0.0.1:${addr.port}/health`, { method: 'HEAD' }); assert.equal(h.status, 200); assert.equal(await h.text(), '');
    assert.equal(calls.ready, 0);
  } finally { await new Promise((r) => server.close(r)); }
});

test('EADDRINUSE rejects instead of crashing the process with an unhandled error', async () => {
  const a = await startHealthServer({ port: 0, deps: mk().deps });
  try { await assert.rejects(startHealthServer({ port: (a.address() as { port: number }).port, host: '0.0.0.0', deps: mk().deps })); }
  finally { await new Promise((r) => a.close(r)); }
});

/* ───── unattended session lifecycle ───── */
const ist = (s: string) => Date.parse(s + '+05:30');

test('daily refresh is 08:45 IST (03:15 UTC); the open is 09:15 IST (03:45 UTC)', () => {
  assert.equal(new Date(nextRefreshAt(ist('2026-11-17T20:00:00'))).toISOString(), '2026-11-18T03:15:00.000Z');
  assert.equal(new Date(nextRefreshAt(ist('2026-11-18T08:00:00'))).toISOString(), '2026-11-18T03:15:00.000Z');
  assert.equal(new Date(nextRefreshAt(ist('2026-11-18T08:45:00'))).toISOString(), '2026-11-19T03:15:00.000Z');       // strictly after
  assert.equal(new Date(lastOpenAt(ist('2026-11-18T09:15:00'))).toISOString(), '2026-11-18T03:45:00.000Z');
  assert.equal(new Date(lastOpenAt(ist('2026-11-18T09:14:59'))).toISOString(), '2026-11-17T03:45:00.000Z');
});

test('whatever time the chain of logins started, the session alive at the 09:15 IST open was issued 08:35–09:15 IST (≤ 40 min old)', () => {
  const open = ist('2026-11-18T09:15:00'), TTL = 6 * 3600_000;
  for (let m = 0; m < 24 * 60; m += 7) {                                       // first login at every 7th minute of the preceding day
    let t = ist('2026-11-17T00:00:00') + m * 60_000, issued = t;
    while (true) { const d = sessionDeadline(t + TTL, t); if (d > open) break; t = d; issued = t; }
    assert.ok(open - issued <= 40 * 60_000, `chain from minute ${m}: session issued ${new Date(issued).toISOString()}`);
    assert.ok(issued >= ist('2026-11-18T08:35:00'), `chain from minute ${m}`);
  }
});

test('refresh cap and the 10-minute lead rule', () => {
  const night = ist('2026-11-18T05:00:00');
  assert.equal(new Date(sessionDeadline(night + 6 * 3600_000, night)).toISOString(), '2026-11-18T03:15:00.000Z');    // 05:00 + 6 h = 11:00 → capped at 08:45 IST
  const evening = ist('2026-11-17T21:00:00');
  assert.equal(sessionDeadline(evening + 6 * 3600_000, evening), evening + 6 * 3600_000);                              // TTL ends first
  const at0840 = ist('2026-11-18T08:40:00');                                                                           // 5 min before the refresh: already fresh, no pointless second login
  assert.equal(sessionDeadline(at0840 + 6 * 3600_000, at0840), at0840 + 6 * 3600_000);
});

test('a restarted instance takes the lease as soon as the old one expires or releases it, and resumes as leader', async () => {
  let clock = 0; let holder: string | null = 'old:1', expires = 30_000, epoch = 4;
  const acquire = async (_n: string, me: string, ttl: number): Promise<LeaseRow> => {
    if (holder === null || expires <= clock || holder === me) { if (holder !== me) epoch++; holder = me; expires = clock + ttl * 1000; return { acquired: true, holder_id: me, expires_at: String(expires), epoch }; }
    return { acquired: false, holder_id: holder, expires_at: String(expires), epoch };
  };
  const l = createLease({ name: 'alert-daemon', holderId: 'new:2', ttlSeconds: 30, renewMs: 10_000, acquire, now: () => clock });
  await l.tick(); assert.equal(l.isLeader(), false);                       // old (crashed) instance still inside its TTL
  clock = 20_000; await l.tick(); assert.equal(l.isLeader(), false);
  clock = 30_000; await l.tick(); assert.equal(l.isLeader(), true); assert.equal(l.info().epoch, 5);    // TTL elapsed → new instance leads, fencing epoch bumped
  holder = null; clock = 40_000;                                            // graceful release by a previous leader: next poll acquires at once
  const l2 = createLease({ name: 'alert-daemon', holderId: 'third:3', acquire, now: () => clock }); await l2.tick(); assert.equal(l2.isLeader(), true);
});
