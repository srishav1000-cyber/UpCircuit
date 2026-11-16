// Production-fix tests: Supabase key headers, disclosure acknowledgement, push route GET/PUT, defaults, footer wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminHeaders, cleanEnv, cleanUrl, isOpaqueKey, keyKind, privilegedKeyProblem, sbFailure, sbFailureText } from '../lib/supabaseAdmin';
import { loadConfig } from '../daemon/index';
import { DISCLOSURE_POINTS, clearAck, disclosureKey, readAck, sessionStamp, writeAck } from '../lib/disclosure';
import { GET, PUT } from '../app/api/alerts/push/route';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
const tok = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('sb_secret_ keys are sent as apikey only; legacy JWT service keys also as Bearer', () => {
  assert.ok(isOpaqueKey('sb_secret_abc')); assert.ok(!isOpaqueKey('eyJhbGciOi.x.y'));
  assert.deepEqual(adminHeaders('sb_secret_abc'), { apikey: 'sb_secret_abc' });
  assert.deepEqual(adminHeaders('eyJ.a.b', true), { apikey: 'eyJ.a.b', Authorization: 'Bearer eyJ.a.b', 'Content-Type': 'application/json' });
});

test('disclosure: per user + version, persisted, covers the three required statements', () => {
  const st = mem();
  assert.equal(readAck('u1', 's1', st), false); writeAck('u1', 's1', st); assert.equal(readAck('u1', 's1', st), true); assert.equal(readAck('u2', 's1', st), false);
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
      let r = await GET(req('GET')); let j = await r.json(); assert.equal(r.status, 502); assert.match(j.error, /Supabase rejected the server key \(401/); assert.deepEqual(j.supabase.map((x: { via: string }) => x.via), ['service', 'user']); assert.equal(j.supabase[0].status, 401);
      restStatus = 404; j = await (await GET(req('GET'))).json(); assert.match(j.error, /Supabase rejected|table is missing/);
      restStatus = 200;
      const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: { p256dh: B64(87), auth: B64(22) } };
      r = await PUT(req('PUT', { subscription: good })); j = await r.json(); assert.equal(r.status, 200); assert.equal(j.registered, true);
      const post = calls.filter((c) => c.method === 'POST').at(-1)!; assert.match(post.url, /on_conflict=user_id,endpoint/); assert.equal(JSON.parse(post.body!)[0].user_id, 'u1');
      assert.equal((await PUT(req('PUT', { subscription: { endpoint: 'http://evil.example/x', keys: good.keys } }))).status, 400);
      assert.equal((await PUT(req('PUT', {}))).status, 400);
    });
  } finally { globalThis.fetch = realFetch; }
});

const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`;

test('env cleaning: newline, spaces and wrapping quotes are removed; URL loses slashes and /rest/v1', () => {
  assert.equal(cleanEnv('  sb_secret_abc\n'), 'sb_secret_abc'); assert.equal(cleanEnv('"sb_secret_abc"'), 'sb_secret_abc'); assert.equal(cleanEnv("'ey J.a.b '"), 'eyJ.a.b'); assert.equal(cleanEnv(undefined), '');
  assert.equal(cleanUrl('https://p.supabase.co/\n'), 'https://p.supabase.co'); assert.equal(cleanUrl('"https://p.supabase.co/rest/v1/"'), 'https://p.supabase.co');
  assert.deepEqual(adminHeaders('sb_secret_abc\n'), { apikey: 'sb_secret_abc' });
  assert.equal(adminHeaders(` ${jwt('service_role')}\n`).Authorization, `Bearer ${jwt('service_role')}`);
});

test('key kind detection: a publishable / anon key in the server slot is named, not blamed on Supabase', () => {
  assert.equal(keyKind('sb_secret_x'), 'sb_secret'); assert.equal(keyKind('sb_publishable_x'), 'sb_publishable'); assert.equal(keyKind(jwt('service_role')), 'jwt_service_role'); assert.equal(keyKind(jwt('anon')), 'jwt_anon'); assert.equal(keyKind(''), 'empty'); assert.equal(keyKind('garbage'), 'unrecognised');
  assert.equal(privilegedKeyProblem('sb_secret_x'), null); assert.equal(privilegedKeyProblem(jwt('service_role')), null);
  assert.match(privilegedKeyProblem(jwt('anon'))!, /anon key/); assert.match(privilegedKeyProblem('sb_publishable_x')!, /publishable/); assert.match(privilegedKeyProblem(undefined)!, /not set/); assert.equal(privilegedKeyProblem('svc-self-hosted'), null);
});

test('sbFailure keeps the exact PostgREST status, code and message', async () => {
  const f = await sbFailure(new Response(JSON.stringify({ code: '42501', message: 'permission denied for table push_subscriptions', hint: 'grant it' }), { status: 403 }));
  assert.deepEqual([f.status, f.code, f.message, f.hint], [403, '42501', 'permission denied for table push_subscriptions', 'grant it']);
  assert.equal(sbFailureText(f), '403 42501: permission denied for table push_subscriptions (grant it)');
  assert.equal((await sbFailure(new Response('Invalid API key', { status: 401 }))).message, 'Invalid API key');
  assert.deepEqual(await sbFailure(null, new Error('ECONNREFUSED')), { status: null, message: 'ECONNREFUSED' });
});

test('push route: a rejected server key falls back to the user token (RLS) and still lists devices; the exact Supabase message is surfaced when both fail', async () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: B64(87), auth: B64(22) } };
  const seen: Record<string, string>[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    if (String(url).includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'a@b.co' }));
    seen.push(h);
    return h.apikey === 'sb_secret_bad' ? new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }) : new Response(JSON.stringify([sub]));
  }) as never;
  try {
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: ' https://p.supabase.co/\n', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anonk\n', SUPABASE_SERVICE_ROLE_KEY: '"sb_secret_bad"\n' }, async () => {
      const j = await (await GET(req('GET'))).json();
      assert.equal(j.ok, true); assert.equal(j.devices, 1); assert.equal(j.readVia, 'user');
      assert.equal(seen[0].apikey, 'sb_secret_bad'); assert.equal(seen[0].Authorization, undefined);          // trimmed + no Bearer of the opaque key
      assert.equal(seen[1].apikey, 'anonk'); assert.equal(seen[1].Authorization, 'Bearer tok');
    });
    globalThis.fetch = (async (url: string) => String(url).includes('/auth/v1/user') ? new Response(JSON.stringify({ id: 'u1', email: 'a@b.co' })) : new Response(JSON.stringify({ code: '42501', message: 'permission denied for table push_subscriptions' }), { status: 403 })) as never;
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' }, async () => {
      const r = await GET(req('GET')); const j = await r.json(); assert.equal(r.status, 502);
      assert.match(j.error, /Supabase rejected the server key \(403 42501: permission denied for table push_subscriptions\)/);
      assert.equal(j.supabase.length, 2); assert.equal(j.keyKind, 'sb_secret'); assert.ok(!JSON.stringify(j).includes('sb_secret_x'));
    });
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: jwt('anon') }, async () => {
      const j = await (await GET(req('GET'))).json(); assert.match(j.error, /holds the anon key/); assert.equal(j.supabase.length, 1); assert.equal(j.supabase[0].via, 'user');   // never even tries the wrong key
    });
  } finally { globalThis.fetch = realFetch; }
});

test('daemon config: same helper — trims the key/URL, accepts sb_secret_ and legacy JWTs, refuses an anon key at startup', () => {
  const base = { NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co/\n', SMARTAPI_API_KEY: 'a', SMARTAPI_CLIENT_CODE: 'c', SMARTAPI_PASSWORD: 'p', SMARTAPI_TOTP_SECRET: 't' };
  const c = loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: ' sb_secret_k\n' }); assert.equal(c.serviceKey, 'sb_secret_k'); assert.equal(c.supabaseUrl, 'https://p.supabase.co');
  assert.equal(loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') }).serviceKey, jwt('service_role'));
  assert.throws(() => loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: jwt('anon') }), /anon key/);
});

test('disclosure is per browser session: stored in sessionStorage, tied to the login session, cleared on sign-out', () => {
  // the stamp is the JWT's session_id: stable across refreshes (new iat), different on every sign-in
  const a1 = tok({ session_id: 'sess-A', iat: 1 }), a2 = tok({ session_id: 'sess-A', iat: 999 }), b = tok({ session_id: 'sess-B' });
  assert.equal(sessionStamp(a1), 'sess-A'); assert.equal(sessionStamp(a1), sessionStamp(a2)); assert.notEqual(sessionStamp(a1), sessionStamp(b));
  assert.equal(sessionStamp(null), ''); assert.equal(sessionStamp('garbage'), ''); assert.equal(sessionStamp(tok({})), '');

  const ss = mem();                                                   // one browser tab session
  assert.equal(readAck('u1', sessionStamp(a1), ss), false);           // fresh session → modal
  writeAck('u1', sessionStamp(a1), ss);
  assert.equal(readAck('u1', sessionStamp(a2), ss), true);            // reload / token refresh inside the same login → no modal
  assert.equal(readAck('u1', sessionStamp(b), ss), false);            // a NEW login (new session_id) for the same user → modal again
  assert.equal(readAck('u2', sessionStamp(a1), ss), false);           // another account in the same tab → modal

  const closed = mem();                                               // closing the tab / browser empties sessionStorage
  assert.equal(readAck('u1', sessionStamp(a1), closed), false);

  writeAck('u1', 'x', ss); writeAck('u2', 'y', ss); ss.setItem('unrelated', '1');
  clearAck(ss);                                                       // sign-out
  assert.equal(readAck('u1', 'x', ss), false); assert.equal(readAck('u2', 'y', ss), false); assert.equal(ss.getItem('unrelated'), '1');
  assert.equal(readAck('u1', sessionStamp(a1), ss), false);           // sign back in → modal immediately

  // demo / local accounts have no token: still per session
  const d = mem(); writeAck('local1', '', d); assert.equal(readAck('local1', '', d), true); clearAck(d); assert.equal(readAck('local1', '', d), false);
});

test('disclosure wiring: no localStorage / metadata suppression, sign-out clears it, accept records an audit timestamp', () => {
  const m = readFileSync('components/RegulatoryDisclosureModal.tsx', 'utf8'), d = readFileSync('lib/disclosure.ts', 'utf8'), a = readFileSync('hooks/useAuth.tsx', 'utf8');
  assert.ok(!/localStorage/.test(m + d.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')) && !/metadataAcked/.test(m + d), 'metadata/localStorage must not suppress the modal');
  assert.ok(/sessionStorage/.test(d) && /sessionStamp\(t\)/.test(m) && /saveMetadataAck/.test(m) && /disclosure_ack_at/.test(d));
  assert.ok(/signOut: async \(\) => \{\s*clearAck\(\)/.test(a), 'signOut clears the acknowledgement');
});
