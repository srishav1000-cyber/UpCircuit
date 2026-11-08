/* Run via scripts/daemon-smoke.sh (needs the TLS env it sets up). */
import assert from 'node:assert/strict';
import { createServer as httpServer, type IncomingMessage } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createECDH, randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import webpush from 'web-push';
import { encodeTick } from '../lib/smartapi';
import { ackSecret } from '../lib/ackToken';

const listen = (s: { listen(p: number, h: string, cb: () => void): unknown; address(): unknown }) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const body = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000, what = 'condition') => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(25); } };

(async () => {
  const USER = '11111111-1111-1111-1111-111111111111';
  const rules: Record<string, unknown>[] = [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', user_id: USER, symbol: 'ABC', kind: 'price_above', threshold: 100, cooldown_min: 5, channels: { push: true, email: false }, enabled: true, last_triggered_at: null },
    { id: 'bbbbbbbb-0000-0000-0000-000000000001', user_id: USER, symbol: 'QQQ', kind: 'volume_surge', threshold: 2, cooldown_min: 5, channels: { push: true }, enabled: true, last_triggered_at: null },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', user_id: USER, symbol: 'QQQ', kind: 'order_imbalance_above', threshold: 0.5, cooldown_min: 5, channels: { push: true }, enabled: true, last_triggered_at: null },
    { id: 'bbbbbbbb-0000-0000-0000-000000000003', user_id: USER, symbol: 'SHT', kind: 'volume_surge', threshold: 2, cooldown_min: 5, channels: { push: true }, enabled: true, last_triggered_at: null }];
  const beats: Record<string, unknown>[] = []; const baselinesPosted: Record<string, unknown>[] = [];
  const deliveries: Record<string, unknown>[] = []; const claims: string[] = []; const claimed = new Set<string>(); let subscribes: string[][] = [];

  // device keys exactly as a browser would produce them
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const pushHits: { auth: string; at: number }[] = [];
  const pushSrv = httpsServer({ key: readFileSync(process.env.SMOKE_TLS_KEY!), cert: readFileSync(process.env.SMOKE_TLS_CERT!) }, async (req, res) => { await body(req); pushHits.push({ auth: String(req.headers.authorization ?? ''), at: Date.now() }); res.writeHead(201).end(); });
  const pushPort = await listen(pushSrv);

  const rtSockets: WebSocket[] = []; let joined = 0;
  const api = httpServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x'); const b = await body(req); const json = (x: unknown, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (u.pathname === '/login') return json({ status: true, data: { feedToken: 'FEED', jwtToken: 'J' } });
    if (u.pathname === '/scrip') return json([{ token: '1001', symbol: 'ABC-EQ', exch_seg: 'NSE', name: 'ABC' }, { token: '1002', symbol: 'XYZ-EQ', exch_seg: 'NSE', name: 'XYZ' }, { token: '1003', symbol: 'QQQ-EQ', exch_seg: 'NSE', name: 'QQQ' }, { token: '1004', symbol: 'SHT-EQ', exch_seg: 'NSE', name: 'SHT' }]);
    if (u.pathname === '/rest/v1/alert_rules') return json(rules.filter((r) => r.enabled));
    if (u.pathname === '/rest/v1/push_subscriptions') return json([{ endpoint: `https://localhost:${pushPort}/push/dev1`, keys: { p256dh: Buffer.from(ecdh.getPublicKey()).toString('base64url'), auth: randomBytes(16).toString('base64url') } }]);
    if (u.pathname === '/rest/v1/rpc/claim_alert_rule') { const j = JSON.parse(b); const k = `${j.p_rule}:${j.p_window_key}`; claims.push(k); const ok = !claimed.has(j.p_rule); claimed.add(j.p_rule); return json(ok); }
    if (u.pathname === '/rest/v1/rpc/audit_write') return json(null);
    if (u.pathname === '/rest/v1/rpc/daemon_beat') { beats.push(JSON.parse(b)); return json(null); }
    if (u.pathname === '/rest/v1/volume_baselines' && req.method === 'POST') { baselinesPosted.push(...JSON.parse(b)); res.writeHead(201).end(); return; }
    if (u.pathname.startsWith('/yahoo/v8/finance/chart/')) {                       // daily bars for the baseline: QQQ has 30 sessions of ~1M, SHT only 4
      const sym = u.pathname.split('/').pop()!.split('.')[0]; const n = sym === 'SHT' ? 4 : 30; const day = Math.floor(Date.now() / 86400000);
      const ts = Array.from({ length: n }, (_, i) => (day - n + i) * 86400 + 3600);
      const col = (f: (i: number) => number) => ts.map((_, i) => f(i));
      return json({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: col(() => 100), high: col(() => 102), low: col(() => 98), close: col(() => 101), volume: col((i) => 1_000_000 + i * 1000) }] } }] } });
    }
    if (u.pathname === '/rest/v1/alert_deliveries' && req.method === 'POST') { deliveries.push(...JSON.parse(b)); res.writeHead(201).end(); return; }
    if (u.pathname === '/rest/v1/alert_deliveries' && req.method === 'PATCH') { const id = u.searchParams.get('id')!.slice(3); const row = deliveries.find((d) => d.id === id && !d.sw_ack_at); if (row) Object.assign(row, JSON.parse(b)); return json(row ? [{ id }] : []); }
    if (u.pathname === '/rest/v1/alert_deliveries') { const id = u.searchParams.get('id')!.slice(3); return json(deliveries.filter((d) => d.id === id)); }
    if (u.pathname === '/__rt') { const m = JSON.parse(b); rtSockets.forEach((s) => s.send(JSON.stringify({ topic: 'realtime:daemon-alert-rules', event: 'postgres_changes', ref: null, payload: { ids: [1], data: { schema: 'public', table: 'alert_rules', commit_timestamp: new Date().toISOString(), columns: [['id','uuid'],['user_id','uuid'],['symbol','text'],['kind','text'],['threshold','numeric'],['cooldown_min','int4'],['channels','jsonb'],['enabled','bool'],['last_triggered_at','timestamptz']].map(([name, type]) => ({ name, type })), type: m.type, record: m.record ?? {}, old_record: m.old ?? {}, errors: null } } }))); return json({ sent: rtSockets.length }); }
    json({}, 404);
  });
  // Supabase Realtime (Phoenix protocol v1) — join / heartbeat only
  const rt = new WebSocketServer({ noServer: true });
  api.on('upgrade', (req, sock, head) => { if (req.url?.startsWith('/realtime/v1/websocket')) rt.handleUpgrade(req, sock, head, (ws) => {
    rtSockets.push(ws);
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.event === 'phx_join') { joined++; ws.send(JSON.stringify({ topic: m.topic, event: 'phx_reply', ref: m.ref, payload: { status: 'ok', response: { postgres_changes: [{ id: 1, event: '*', schema: 'public', table: 'alert_rules' }] } } })); } else if (m.topic === 'phoenix') ws.send(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', ref: m.ref, payload: { status: 'ok', response: {} } })); });
  }); else sock.destroy(); });
  const apiPort = await listen(api);

  // SmartAPI feed
  const feed = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise((r) => feed.on('listening', r));
  const feedPort = (feed.address() as { port: number }).port; let feedWs: WebSocket | null = null;
  feed.on('connection', (ws) => { feedWs = ws; ws.on('message', (raw) => { const s = String(raw); if (s === 'ping') return ws.send('pong'); try { const m = JSON.parse(s); subscribes.push(m.params.tokenList.flatMap((x: { tokens: string[] }) => x.tokens)); } catch { /* ignore */ } }); });
  const tick = (token: string, ltp: number, ts = Date.now()) => feedWs!.send(encodeTick({ mode: 3, exchangeType: 1, token, seq: 1, exchangeTs: ts, ltp, close: 100, volume: 1000, open: 100, high: ltp, low: ltp }));

  const keys = webpush.generateVAPIDKeys();
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${apiPort}`, SUPABASE_SERVICE_ROLE_KEY: 'svc-key', SMARTAPI_API_KEY: 'k', SMARTAPI_CLIENT_CODE: 'C1', SMARTAPI_PASSWORD: 'pw', SMARTAPI_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    SMARTAPI_LOGIN_URL: `http://127.0.0.1:${apiPort}/login`, SMARTAPI_SCRIP_MASTER_URL: `http://127.0.0.1:${apiPort}/scrip`, SMARTAPI_STREAM_URL: `ws://127.0.0.1:${feedPort}`,
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:ops@example.test', PUSH_ENDPOINT_ALLOW: 'localhost', YAHOO_BASE: `http://127.0.0.1:${apiPort}/yahoo`, PORT: '0', DAEMON_RESYNC_MS: '3600000',
  });
  const { main, loadConfig } = await import('../daemon/index');
  const daemon = await main({ ...loadConfig(), port: 0 });
  let ok = 0; const pass = (m: string) => { ok++; console.log('  ✓', m); };

  await until(() => joined > 0, 8000, 'realtime join'); pass('Realtime channel joined');
  await until(() => feedWs !== null && subscribes.flat().includes('1001'), 8000, 'feed subscribe ABC'); pass('daemon logged in, connected the feed and subscribed to the rule symbol (token 1001)');

  tick('1001', 99); await sleep(150); assert.equal(deliveries.length, 0); pass('first tick only seeds state — no alert');
  const exch = Date.now() - 400; tick('1001', 101, exch);
  await until(() => deliveries.length === 1, 8000, 'delivery row'); const row = deliveries[0];
  assert.equal(row.channel, 'push'); assert.equal(row.status, 'sent'); assert.equal(row.symbol, 'ABC');
  assert.ok(pushHits.length === 1 && /^vapid /i.test(pushHits[0].auth), 'push service received one VAPID-authenticated, encrypted POST'); pass('crossing 99 → 101: claimed, encrypted VAPID push accepted (HTTP 201), delivery row written');
  const t = (k: string) => Date.parse(row[k] as string);
  assert.ok(t('daemon_matched_at') >= t('tick_time') && t('push_sent_at') >= t('daemon_matched_at')); pass(`stamps ordered: tick→match ${t('daemon_matched_at') - t('tick_time')} ms (includes my injected 400 ms), match→push ${t('push_sent_at') - t('daemon_matched_at')} ms (local mock — not a real-world figure)`);
  tick('1001', 99); tick('1001', 102); await sleep(300); assert.equal(deliveries.length, 1); pass('re-cross inside the cooldown does not send again');

  // dynamic rule sync: new rule on a NEW symbol arrives over Realtime → daemon subscribes it → fires
  const r2 = { id: 'aaaaaaaa-0000-0000-0000-000000000002', user_id: USER, symbol: 'xyz', kind: 'price_below', threshold: 50, cooldown_min: 5, channels: { push: true }, enabled: true, last_triggered_at: null };
  await fetch(`http://127.0.0.1:${apiPort}/__rt`, { method: 'POST', body: JSON.stringify({ type: 'INSERT', record: r2 }) });
  await until(() => subscribes.flat().includes('1002'), 6000, 'subscribe XYZ after INSERT'); pass('Realtime INSERT → rule indexed and new symbol subscribed without a restart');
  tick('1002', 60); await sleep(100); tick('1002', 49); await until(() => deliveries.length === 2, 6000, 'second delivery'); pass('rule created via Realtime fired on its first crossing');
  // delete + update via Realtime
  const r3 = { ...r2, id: 'aaaaaaaa-0000-0000-0000-000000000003', cooldown_min: 5 };
  await fetch(`http://127.0.0.1:${apiPort}/__rt`, { method: 'POST', body: JSON.stringify({ type: 'INSERT', record: r3 }) }); await sleep(100);
  await fetch(`http://127.0.0.1:${apiPort}/__rt`, { method: 'POST', body: JSON.stringify({ type: 'DELETE', old: { id: r3.id } }) }); await sleep(100);
  tick('1002', 60); await sleep(100); tick('1002', 49); await sleep(400); assert.equal(claims.filter((c) => c.startsWith(r3.id)).length, 0); pass('Realtime DELETE removes the rule (it never reaches the claim step)');


  // ───── Turn 43: volume surge + top-5 imbalance + baselines + heartbeat ─────
  await until(() => feedWs !== null && subscribes.flat().includes('1003'), 8000, 'subscribe QQQ'); pass('volume / imbalance rules subscribed their symbols at startup');
  await until(() => baselinesPosted.some((x) => x.symbol === 'QQQ') && baselinesPosted.some((x) => x.symbol === 'SHT'), 10000, 'baselines published');
  const bq = baselinesPosted.find((x) => x.symbol === 'QQQ')!, bs = baselinesPosted.find((x) => x.symbol === 'SHT')!;
  assert.equal(bq.status, 'ok'); assert.ok(Number(bq.median_volume) > 1_000_000 && Number(bq.median_volume) < 1_040_000, String(bq.median_volume)); assert.equal(bs.status, 'insufficient'); assert.equal(bs.median_volume, null); pass(`baselines computed from daily bars and published (QQQ median ≈ ${Math.round(Number(bq.median_volume)).toLocaleString('en-IN')}, SHT = insufficient with ${bs.sessions} sessions)`);
  const lvl = (p: number, q: number) => ({ price: p, qty: q, orders: 1 });
  const bookOf = (bid: number, ask: number) => ({ bids: [lvl(99, bid), lvl(98, 100), lvl(97, 100), lvl(96, 100), lvl(95, 100)], asks: [lvl(101, ask), lvl(102, 100), lvl(103, 100), lvl(104, 100), lvl(105, 100)] });
  const qtick = (token: string, vol: number, b: ReturnType<typeof bookOf>) => feedWs!.send(encodeTick({ mode: 3, exchangeType: 1, token, seq: 1, exchangeTs: Date.now(), ltp: 100, close: 99, volume: vol, open: 99, high: 101, low: 98, bids: b.bids, asks: b.asks }));
  qtick('1003', 1_100_000, bookOf(1000, 1000)); await sleep(200); assert.equal(deliveries.filter((d) => d.symbol === 'QQQ').length, 0); pass('balanced book + below-threshold volume seeds both rules without firing');
  qtick('1003', 2_300_000, bookOf(9000, 500)); await until(() => deliveries.filter((d) => d.symbol === 'QQQ').length === 2, 8000, 'QQQ alerts');
  const kinds = deliveries.filter((d) => d.symbol === 'QQQ').map((d) => d.kind).sort(); assert.deepEqual(kinds, ['order_imbalance_above', 'volume_surge']); pass('one tick crossing 2.2× typical volume AND +0.8 top-5 imbalance sent both alerts');
  qtick('1004', 9_000_000_000, bookOf(1000, 1000)); await sleep(300); assert.equal(deliveries.filter((d) => d.symbol === 'SHT').length, 0); pass('volume rule with insufficient history stays N/A and never fires');
  await until(() => beats.some((x) => x.p_feed_status === 'open' && Number(x.p_ticks) > 0), 12000, 'heartbeat with the feed open'); const hb = beats.filter((x) => x.p_feed_status === 'open').pop()!; assert.equal(hb.p_id, 'alert-daemon'); assert.equal(hb.p_feed_status, 'open'); assert.ok(Number(hb.p_rules) >= 5 && Number(hb.p_ticks) > 0); pass(`heartbeat reaches daemon_beat() (feed ${hb.p_feed_status}, ${hb.p_rules} rules, ${hb.p_ticks} ticks)`);

  // ACK route with the delivery's token (handler called directly against the mock REST)
  const { POST } = await import('../app/api/alerts/ack/route');
  const { ackToken } = await import('../lib/ackToken');
  const secret = ackSecret()!; const id = row.id as string;
  const call = (b: unknown) => POST(new Request('http://x/api/alerts/ack', { method: 'POST', body: JSON.stringify(b) }) as never);
  assert.equal((await call({ delivery_id: id, ack: 'forged', displayed_at: Date.now() })).status, 401); pass('ACK with a forged token → 401');
  const good = await call({ delivery_id: id, ack: ackToken(id, secret), displayed_at: Date.now() }); assert.equal(good.status, 200); assert.ok(deliveries[0].sw_ack_at && deliveries[0].displayed_at); pass('valid ACK stamps sw_ack_at + displayed_at');
  const again = await (await call({ delivery_id: id, ack: ackToken(id, secret), displayed_at: Date.now() })).json(); assert.equal(again.duplicate, true); pass('second ACK (another device) is accepted as a duplicate, first stamp kept');
  const ghost = '99999999-9999-9999-9999-999999999999'; assert.equal((await call({ delivery_id: ghost, ack: ackToken(ghost, secret), displayed_at: Date.now() })).status, 404); pass('ACK for a row that does not exist (yet) → 404 so the service worker retries');

  await daemon.stop(); feed.close(); rt.close(); api.close(); pushSrv.close();
  console.log(`\n${ok} smoke checks passed`); process.exit(0);
})().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
