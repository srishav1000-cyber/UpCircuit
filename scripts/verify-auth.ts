/* Auth, plan gating, per-user scope and focus-basket checks — part of `npm test`. */
import assert from 'node:assert/strict';
import { ALL_ROLES, PLANS, allowedRoles, canUse, coerceRole, planFor, userKey, validateCredentials } from '../lib/auth';
import { createLocalBackend, createSupabaseBackend } from '../lib/authBackends';
import { MAX_FOCUS, normalizeFocus, parseFocus, pruneFocus, toggleFocus } from '../lib/focus';
import { scoped, setScope } from '../lib/scope';

let passed = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${(e as Error).message}`);
    process.exitCode = 1;
  }
};
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m };
};

(async () => {
  await t('plans: Tier1 day only, Tier2 retail only, Tier3 all four', () => {
    assert.deepEqual(allowedRoles('day'), ['day']);
    assert.deepEqual(allowedRoles('retail'), ['retail']);
    assert.deepEqual(allowedRoles('full'), ALL_ROLES);
    assert.equal(canUse('day', 'retail'), false);
    assert.equal(canUse('retail', 'executive'), false);
    assert.ok(ALL_ROLES.every((r) => canUse('full', r)));
    assert.equal(planFor('institutional').id, 'full');
    assert.equal(planFor('day').id, 'day');
    assert.equal(coerceRole('retail', 'executive'), 'retail');
    assert.equal(coerceRole('full', 'executive'), 'executive');
    assert.deepEqual(PLANS.map((p) => p.tier), [1, 2, 3]);
  });
  await t('validation + key scope', () => {
    assert.ok(validateCredentials('bad', 'password1'));
    assert.ok(validateCredentials('a@b.co', 'short'));
    assert.equal(validateCredentials('a@b.co', 'longenough'), null);
    assert.equal(userKey('k', 'u1'), 'k:u1');
    assert.equal(userKey('k', null), 'k');
    setScope('u9');
    assert.equal(scoped('upcircuit:alerts'), 'upcircuit:alerts:u9');
    setScope(null);
    assert.equal(scoped('upcircuit:alerts'), 'upcircuit:alerts');
  });
  await t('local backend: signup, login, hashing, plan rules', async () => {
    const s = mem();
    const be = createLocalBackend(s);
    assert.equal(await be.restore(), null);
    const bad = await be.signUp({ email: 'a@b.co', password: 'password1', role: 'retail', plan: 'day' });
    assert.ok(!bad.ok, 'role outside plan refused');
    const ok = await be.signUp({ email: 'A@B.co', password: 'password1', role: 'day', plan: 'day' });
    assert.ok(ok.ok && ok.user.email === 'a@b.co' && ok.user.plan === 'day');
    assert.ok(!s.raw.get('upcircuit:auth:users')!.includes('password1'), 'password never stored in clear');
    assert.ok(!(await be.signUp({ email: 'a@b.co', password: 'password1', role: 'day', plan: 'day' })).ok, 'duplicate refused');
    assert.equal((await be.restore())?.email, 'a@b.co');
    await be.signOut();
    assert.equal(await be.restore(), null);
    assert.ok(!(await be.signIn('a@b.co', 'wrongpass1')).ok);
    assert.ok(!(await be.signIn('nobody@b.co', 'password1')).ok);
    const li = await be.signIn('a@b.co', 'password1');
    assert.ok(li.ok);
    if (!li.ok) return;
    const up = await be.update(li.user, { plan: 'full', role: 'executive' });
    assert.ok(up.ok && up.user.plan === 'full' && up.user.role === 'executive');
    const down = await be.update(up.ok ? up.user : li.user, { plan: 'retail' });
    assert.ok(down.ok && down.user.role === 'retail', 'downgrade coerces role into the plan');
  });
  await t('supabase backend (mock fetch): signup/login/role patch/plan is read-only', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (url.includes('/auth/v1/signup') || url.includes('grant_type=password')) {
        const b = JSON.parse(init!.body as string);
        if (b.password === 'wrongpass1') return json({ error_description: 'Invalid login credentials' }, 400);
        return json({ access_token: 'AT', refresh_token: 'RT', user: { id: 'uid-1', email: b.email } });
      }
      if (url.includes('/rest/v1/profiles') && (init?.method ?? 'GET') === 'GET') return json([{ primary_role: 'retail', plan: 'retail' }]);
      if (url.includes('/rest/v1/profiles')) return new Response(null, { status: 204 });
      if (url.includes('/auth/v1/user')) return json({ id: 'uid-1', email: 'x@y.co' });
      return json({});
    }) as unknown as typeof fetch;
    const be = createSupabaseBackend('https://p.supabase.co/', 'anon', mem(), f);
    const su = await be.signUp({ email: 'x@y.co', password: 'password1', role: 'retail', plan: 'retail' });
    assert.ok(su.ok && su.user.plan === 'retail' && su.user.id === 'uid-1');
    assert.ok(calls.some((c) => c.url.startsWith('https://p.supabase.co/auth/v1/signup') && JSON.parse(c.body!).data.plan === 'retail'));
    assert.equal((await be.restore())?.id, 'uid-1');
    assert.ok(!(await be.signIn('x@y.co', 'wrongpass1')).ok);
    const li = await be.signIn('x@y.co', 'password1');
    assert.ok(li.ok);
    if (!li.ok) return;
    const noPlan = await be.update(li.user, { plan: 'full' });
    assert.ok(!noPlan.ok, 'client cannot grant itself a plan');
    assert.ok(!(await be.update(li.user, { role: 'executive' })).ok, 'role outside plan refused client-side');
    const patched = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patched.length, 0);
    await be.signOut();
    assert.equal(await be.restore(), null);
  });
  await t('focus basket: cap 6, dedupe, toggle, prune, parse', () => {
    assert.deepEqual(normalizeFocus([' tcs', 'TCS', 'infy']), ['TCS', 'INFY']);
    assert.equal(normalizeFocus(['A', 'B', 'C', 'D', 'E', 'F', 'G']).length, MAX_FOCUS);
    let l: string[] = [];
    for (const s of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const r = toggleFocus(l, s);
      assert.ok(r.ok);
      if (r.ok) l = r.list;
    }
    assert.ok(!toggleFocus(l, 'G').ok, 'seventh refused');
    const rm = toggleFocus(l, 'c');
    assert.ok(rm.ok && rm.list.length === 5 && !rm.list.includes('C'));
    assert.deepEqual(pruneFocus(['A', 'Z'], new Set(['A'])), ['A']);
    assert.deepEqual(parseFocus('["x","x","y"]'), ['X', 'Y']);
    assert.deepEqual(parseFocus('garbage'), []);
    assert.deepEqual(parseFocus(null), []);
  });
  console.log(`${passed} auth/plan/focus checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
})();
