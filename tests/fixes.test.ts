// Production-fix tests: Supabase key headers, disclosure acknowledgement, push route GET/PUT, defaults, footer wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminHeaders, isOpaqueKey } from '../lib/supabaseAdmin';
import { DISCLOSURE_POINTS, disclosureKey, readAck, writeAck } from '../lib/disclosure';
import { GET, PUT } from '../app/api/alerts/push/route';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

test('sb_secret_ keys are sent as apikey only; legacy JWT service keys also as Bearer', () => {
  assert.ok(isOpaqueKey('sb_secret_abc')); assert.ok(!isOpaqueKey('eyJhbGciOi.x.y'));
  assert.deepEqual(adminHeaders('sb_secret_abc'), { apikey: 'sb_secret_abc' });
  assert.deepEqual(adminHeaders('eyJ.a.b', true), { apikey: 'eyJ.a.b', Authorization: 'Bearer eyJ.a.b', 'Content-Type': 'application/json' });
});

test('disclosure: per user + version, persisted, covers the three required statements', () => {
  const st = mem();
  assert.equal(readAck('u1', st), false); writeAck('u1', st); assert.equal(readAck('u1', st), true); assert.equal(readAck('u2', st), false);
  assert.match(disclosureKey('u1'), /^upcircuit:disclosure:.+:u1$/);
  const t = DISCLOSURE_POINTS.join(' ');
  assert.match(t, /NOT a SEBI-registered Investment Adviser or Research Analyst/); assert.match(t, /heuristic depth flags/); assert.match(t, /backtests/);
  assert.match(t, /not investment advice|is investment advice/i); assert.match(t, /own discretion and risk/); assert.match(t, /full financial responsibility/);
  const m = readFileSync('components/RegulatoryDisclosureModal.tsx', 'utf8');
  assert.ok(/I Understand &amp; Accept/.test(m) && /role="alertdialog"/.test(m) && !/onClick=\{[^}]*setOpen\(false\)\}[^>]*backdrop/.test(m));
  assert.ok(/RegulatoryDisclosureModal/.test(readFileSync('app/page.tsx', 'utf8')));
});

test('defaults + wording: chart opens on 1D, footer says Platform Specs, no hard-coded week numbers in the UI', () => {
  const page = readFileSync('app/page.tsx', 'utf8');
  assert.match(page, /useState<Timeframe>\('1D'\)/); assert.ok(/>Platform Specs</.test(page) && !/Week 7 Specs/.test(page));
  for (const f of ['app/page.tsx', 'components/Week7MilestoneModal.tsx']) assert.ok(!/\bWeek ?\d+\b/i.test(readFileSync(f, 'utf8').replace(/data-testid=("[^"]*"|{`[^`]*`})/g, '')), f);
});

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const old = { ...process.env }; Object.assign(process.env, env); for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  try { await fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};
const realFetch = globalThis.fetch;
const req = (method: string, body?: unknown) => new Request('http://x/api/alerts/push', { method, headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }) as never;
const B64 = (n: number) => 'A'.repeat(n);

test('GET /api/alerts/push with an sb_secret_ key: reads devices without a Bearer of the secret, reports channel readiness (RESEND missing → clear note)', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>; seen.push({ url: String(url), headers: h });
    if (String(url).includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'a@b.co' }));
    return new Response(JSON.stringify([{ endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: B64(87), auth: B64(22) } }]));
  }) as never;
  try {
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_x', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_zzz', RESEND_API_KEY: undefined, NEXT_PUBLIC_VAPID_PUBLIC_KEY: undefined }, async () => {
      const r = await GET(req('GET')); const j = await r.json();
      assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.devices, 1);
      assert.equal(j.email.configured, false); assert.match(j.email.note, /RESEND_API_KEY/); assert.equal(j.push.configured, false);
      assert.ok(j.kinds.includes('volume_surge') && j.kinds.includes('circuit_proximity') && j.kinds.includes('order_imbalance_above'));
      const rest = seen.find((s) => s.url.includes('/rest/v1/push_subscriptions'))!;
      assert.equal(rest.headers.apikey, 'sb_secret_zzz'); assert.equal(rest.headers.Authorization, undefined);
      assert.match(rest.url, /user_id=eq\.u1/);
    });
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: undefined, RESEND_API_KEY: 're_1' }, async () => {
      const j = await (await GET(req('GET'))).json(); assert.equal(j.email.configured, true); assert.equal(j.email.to, 'a@b.co');
      const rest = seen.filter((s) => s.url.includes('/rest/v1/')).at(-1)!; assert.equal(rest.headers.Authorization, 'Bearer tok');   // no service key → user token through RLS
    });
  } finally { globalThis.fetch = realFetch; }
});

test('GET reports a specific reason when the key is rejected or the table is missing; PUT registers a valid subscription and refuses junk', async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  let restStatus = 401;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body as string });
    if (String(url).includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'a@b.co' }));
    return new Response(restStatus === 200 ? '[]' : '{}', { status: restStatus });
  }) as never;
  try {
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_q' }, async () => {
      let r = await GET(req('GET')); let j = await r.json(); assert.equal(r.status, 502); assert.match(j.error, /key was rejected/);
      restStatus = 404; j = await (await GET(req('GET'))).json(); assert.match(j.error, /table is missing/);
      restStatus = 200;
      const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: { p256dh: B64(87), auth: B64(22) } };
      r = await PUT(req('PUT', { subscription: good })); j = await r.json(); assert.equal(r.status, 200); assert.equal(j.registered, true);
      const post = calls.filter((c) => c.method === 'POST').at(-1)!; assert.match(post.url, /on_conflict=user_id,endpoint/); assert.equal(JSON.parse(post.body!)[0].user_id, 'u1');
      assert.equal((await PUT(req('PUT', { subscription: { endpoint: 'http://evil.example/x', keys: good.keys } }))).status, 400);
      assert.equal((await PUT(req('PUT', {}))).status, 400);
    });
  } finally { globalThis.fetch = realFetch; }
});
