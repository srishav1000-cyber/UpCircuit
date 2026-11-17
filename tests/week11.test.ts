// Week 11: cross-device UI prefs, labelled push devices (list / remove), PWA manifest, fan-out to every device + e-mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_UI, pickNewer, sanitizeUi } from '../lib/uiPrefs';
import { getUi, hydrateUi, onUiChange, patchUi, resetUi } from '../lib/uiStore';
import { describeDevice } from '../lib/deviceLabel';
import { createDispatcher } from '../daemon/dispatcher';
import { ackSecret } from '../lib/ackToken';
import { DELETE, GET, PUT } from '../app/api/alerts/push/route';
import manifest from '../app/manifest';
import { reportSync, setSyncAvailable, getSync } from '../lib/syncStatus';

/* ───────── synced UI preferences ───────── */
test('ui prefs: sanitised, defaults never beat a saved choice, newer copy wins', () => {
  assert.equal(DEFAULT_UI.tf, '1D'); assert.equal(DEFAULT_UI.updatedAt, 0);
  assert.equal(sanitizeUi('{"tf":"7m"}'), null); assert.equal(sanitizeUi(null), null); assert.equal(sanitizeUi('nope'), null);
  const a = sanitizeUi({ tf: '5m', ind: { ema20: true, rsi: 'yes', junk: 1 }, updatedAt: 50 })!;
  assert.deepEqual(a, { tf: '5m', ind: { ema20: true, ema50: false, vwap: false, rsi: false }, updatedAt: 50 });
  const cloud = sanitizeUi({ tf: '15m', ind: { vwap: true }, updatedAt: 100 })!, local = sanitizeUi({ tf: '1m', updatedAt: 200 })!, fresh = sanitizeUi({ tf: '1D', ind: {} })!;
  assert.equal(pickNewer(local, cloud).source, 'local'); assert.ok(pickNewer(local, cloud).pushLocal);          // newer local edit → uploaded
  assert.equal(pickNewer(cloud, local).source, 'cloud');                                                       // newer cloud → hydrated, not overwritten
  const d = pickNewer(fresh, cloud); assert.equal(d.source, 'cloud'); assert.equal(d.value.tf, '15m');          // a fresh device (default, updatedAt 0) never overwrites the account
  assert.equal(pickNewer(null, cloud).value.tf, '15m'); assert.equal(pickNewer(fresh, null).pushLocal, false); assert.equal(pickNewer(null, null).source, 'default');
});

test('ui store: user edits stamp updatedAt and notify the saver; hydration does not', () => {
  resetUi(); const seen: number[] = []; const off = onUiChange((s) => seen.push(s.updatedAt));
  hydrateUi({ tf: '1W', ind: DEFAULT_UI.ind, updatedAt: 10 }); assert.equal(seen.length, 0); assert.equal(getUi().tf, '1W');
  patchUi({ tf: '5m' }, 500); assert.equal(getUi().tf, '5m'); assert.equal(seen.length, 1); assert.equal(getUi().updatedAt, 500);
  patchUi({ tf: '5m' }, 600); assert.equal(seen.length, 1);                                                    // no-op edit → no save
  patchUi({ ind: { ...getUi().ind, rsi: true } }, 700); assert.equal(getUi().ind.rsi, true); assert.equal(seen.length, 2);
  off(); resetUi(); assert.equal(getUi().tf, '1D');
});

/* ───────── device labels ───────── */
test('device labels: Windows · Chrome, Android · Chrome, iPhone · Home Screen PWA', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const and = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  assert.equal(describeDevice(win).label, 'Windows · Chrome'); assert.equal(describeDevice(and).label, 'Android · Chrome'); assert.ok(describeDevice(and).mobile);
  assert.equal(describeDevice(ios, true).label, 'iPhone · Home Screen PWA'); assert.equal(describeDevice(ios, false).label, 'iPhone · Safari');
  assert.equal(describeDevice(win.replace('Chrome/130.0', 'Edg/130.0 Chrome/130.0')).label, 'Windows · Edge');
  assert.equal(describeDevice('', false).label, 'Device · Browser'); assert.equal(describeDevice(null).mobile, false);
});

/* ───────── device list / remove / register with label ───────── */
const B = (n: number) => 'A'.repeat(n);
const UID = '11111111-2222-3333-4444-555555555555';
const mkSub = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: B(87), auth: B(22) } });
const req = (method: string, body?: unknown) => new Request('http://x/api/alerts/push', { method, headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }) as never;
const realFetch = globalThis.fetch;
const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' };
async function withEnv(fn: () => Promise<void>) { const old = { ...process.env }; Object.assign(process.env, env); try { await fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } }

test('devices API: lists every device with its label, removes exactly one, registers with a label (and still works before the label columns exist)', async () => {
  const dev = [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', ...mkSub('win1'), label: 'Windows · Chrome', platform: 'Windows', created_at: '2026-11-01T10:00:00Z' }, { id: 'aaaaaaaa-0000-0000-0000-000000000002', ...mkSub('and2'), label: 'Android · Chrome', platform: 'Android', created_at: '2026-11-02T10:00:00Z' }, { id: 'aaaaaaaa-0000-0000-0000-000000000003', ...mkSub('ios3'), label: 'iPhone · Home Screen PWA', platform: 'iPhone', created_at: '2026-11-03T10:00:00Z' }];
  const calls: { url: string; method: string; body?: string }[] = []; let labelColumns = true;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url), m = init?.method ?? 'GET'; calls.push({ url: u, method: m, body: init?.body as string });
    if (u.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: UID, email: 'a@b.co' }));
    if (m === 'GET') return labelColumns || !u.includes('label') ? new Response(JSON.stringify(labelColumns ? dev : dev.map(({ id, endpoint, keys }) => ({ id, endpoint, keys })))) : new Response(JSON.stringify({ code: '42703', message: 'column push_subscriptions.label does not exist' }), { status: 400 });
    if (m === 'POST' && !labelColumns && (init?.body as string).includes('"label"')) return new Response(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'label' column" }), { status: 400 });
    return new Response(null, { status: 204 });
  }) as never;
  try {
    await withEnv(async () => {
      let j = await (await GET(req('GET'))).json();
      assert.equal(j.devices, 3); assert.deepEqual(j.deviceList.map((d: { label: string }) => d.label), ['Windows · Chrome', 'Android · Chrome', 'iPhone · Home Screen PWA']);
      assert.ok(j.deviceList.every((d: { id: string; usable: boolean }) => d.id && d.usable));
      // remove ONE
      let r = await DELETE(req('DELETE', { id: dev[1].id })); assert.equal(r.status, 200);
      const del = calls.filter((c) => c.method === 'DELETE').at(-1)!; assert.match(del.url, new RegExp(`user_id=eq\\.${UID}&id=eq\\.${dev[1].id}`));
      assert.equal((await DELETE(req('DELETE', { id: 'not-a-uuid' }))).status, 400); assert.equal((await DELETE(req('DELETE', {}))).status, 400);
      // register with a label
      r = await PUT(req('PUT', { subscription: mkSub('new4'), label: 'Android · Chrome', platform: 'Android' })); j = await r.json();
      assert.equal(r.status, 200); assert.equal(j.label, 'Android · Chrome'); assert.equal(JSON.parse(calls.filter((c) => c.method === 'POST').at(-1)!.body!)[0].label, 'Android · Chrome');
      // label columns not migrated yet: reads fall back to a generic label, registration still succeeds
      labelColumns = false;
      j = await (await GET(req('GET'))).json(); assert.equal(j.devices, 3); assert.match(j.deviceList[0].label, /Google push/);
      r = await PUT(req('PUT', { subscription: mkSub('new5'), label: 'Android · Chrome' })); j = await r.json(); assert.equal(r.status, 200); assert.equal(j.label, null);
    });
  } finally { globalThis.fetch = realFetch; }
});

/* ───────── fan-out to ALL devices + e-mail ───────── */
test('dispatcher fans every alert out to all of the user’s devices (desktop + Android + iPhone) at once, and records the e-mail channel', async () => {
  const rows: Record<string, unknown>[] = []; const pushed: string[] = []; const queries: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const u = String(url); const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (u.includes('rpc/claim_alert_rule')) return j(true);
    if (u.includes('rpc/audit_write')) return j(null);
    if (u.includes('/auth/v1/admin/users/')) return j({});                                    // no e-mail address on this fake user → recorded as skipped
    if (u.includes('push_subscriptions')) { queries.push(u); return j(['win', 'and', 'ios'].map((n) => mkSub(n))); }
    if (u.includes('/alert_deliveries')) { rows.push(...(JSON.parse(String(init?.body)) as Record<string, unknown>[])); return j(null, 201); }
    return j({}, 404);
  }) as unknown as typeof fetch;
  const secret = ackSecret({ VAPID_PRIVATE_KEY: 'k'.repeat(40) })!;
  const mk = (emailEnabled: boolean) => createDispatcher({ supabaseUrl: 'http://sb.test', serviceKey: 'svc', ackSecret: secret, fetchImpl: fakeFetch, emailEnabled, send: async (s) => { pushed.push(s.endpoint.split('/').pop()!); } });
  const match = { rule: { id: '11111111-1111-1111-1111-111111111111', user_id: UID, symbol: 'ABC', kind: 'volume_surge' as const, threshold: 2, cooldown_min: 10, channels: { push: true, email: true }, enabled: true, last_triggered_at: null }, price: 101, pct: 1, message: 'm', matchedAt: 1_000_000, tickTime: 999_900 } as never;
  const r = await mk(true).dispatch(match);
  assert.equal(r.outcome, 'delivered'); assert.equal(r.devices, 3); assert.equal(r.sent, 3); assert.deepEqual(pushed.sort(), ['and', 'ios', 'win']);
  assert.match(queries[0], new RegExp(`user_id=eq\\.${UID}`)); assert.ok(!/limit=/.test(queries[0]), 'no row limit on the device query');
  await new Promise((x) => setTimeout(x, 20));
  assert.ok(rows.some((x) => x.channel === 'push' && x.status === 'sent' && x.detail === '3/3 devices'));
  assert.ok(rows.some((x) => x.channel === 'email'), 'e-mail channel is recorded alongside push');
  rows.length = 0; await mk(false).dispatch({ ...(match as object), rule: { ...(match as { rule: object }).rule } } as never); await new Promise((x) => setTimeout(x, 20));
  assert.ok(rows.some((x) => x.channel === 'email' && x.status === 'skipped' && x.detail === 'unconfigured'));
  rows.length = 0; pushed.length = 0;
  const t = await mk(false).sendTest(UID); assert.equal(t.ok, true); assert.equal(t.devices, 3); assert.equal(t.sent, 3); assert.equal(pushed.length, 3);   // the Settings test hits every device too
});

/* ───────── PWA manifest ───────── */
test('PWA manifest: standalone, start_url "/", theme colour, real 192 / 512 icons; static copy matches the Next metadata route', () => {
  const m = manifest(); const s = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
  for (const x of [m, s]) { assert.equal(x.display, 'standalone'); assert.equal(x.start_url, '/'); assert.match(String(x.theme_color), /^#[0-9a-f]{6}$/i); assert.ok(x.name && x.short_name); }
  for (const x of [m, s]) { const icons = x.icons as { src: string; sizes: string; type: string }[]; assert.ok(icons.some((i) => i.src === '/icon-192.png' && i.sizes === '192x192' && i.type === 'image/png')); assert.ok(icons.some((i) => i.src === '/icon-512.png' && i.sizes === '512x512')); assert.ok(icons.some((i) => (i as { purpose?: string }).purpose === 'maskable')); }
  for (const f of ['public/icon-192.png', 'public/icon-512.png', 'public/icons/icon-maskable-512.png', 'public/icons/apple-touch-icon.png']) assert.ok(existsSync(f), f);
  const png = (f: string) => { const b = readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), sig: b.subarray(0, 4).toString('hex') }; };
  assert.deepEqual(png('public/icon-192.png'), { w: 192, h: 192, sig: '89504e47' }); assert.deepEqual(png('public/icon-512.png'), { w: 512, h: 512, sig: '89504e47' });
  assert.deepEqual(s.icons.map((i: { src: string }) => i.src), (m.icons as { src: string }[]).map((i) => i.src));
  assert.ok(/appleWebApp/.test(readFileSync('app/layout.tsx', 'utf8')));
});

/* ───────── sync status ───────── */
test('sync status: "last saved" moves only on successful writes', () => {
  setSyncAvailable(true); const base = getSync().lastSaveAt ?? null;
  reportSync(true, 1000, false); assert.equal(getSync().lastSaveAt ?? null, base); assert.equal(getSync().state, 'synced');
  reportSync(true, 2000, true); assert.equal(getSync().lastSaveAt, 2000);
  reportSync(false, 3000, true); assert.equal(getSync().lastSaveAt, 2000); assert.equal(getSync().state, 'offline');
  reportSync(true, 4000, false); assert.equal(getSync().state, 'synced'); assert.equal(getSync().lastSaveAt, 2000);
  setSyncAvailable(false);
});

test('settings wiring: Cloud & Data shows "Synced to cloud · last saved", Alert Channels lists devices with Remove and a mobile guide, chart prefs use the synced store', () => {
  const st = readFileSync('components/SettingsModal.tsx', 'utf8'), ch = readFileSync('components/settings/AlertChannelsStatus.tsx', 'utf8');
  assert.ok(/Synced to cloud/.test(st) && /last saved/.test(st) && /cloud-last-saved/.test(st));
  assert.ok(/device-remove/.test(ch) && /Add to Home Screen/.test(ch) && /Android · Chrome/.test(ch) && /iPhone · Safari/.test(ch));
  assert.ok(/useUi\(\)/.test(readFileSync('components/PriceChart.tsx', 'utf8')) && /useUiSync\(\)/.test(readFileSync('app/page.tsx', 'utf8')));
});
