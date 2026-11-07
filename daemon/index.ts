// UpCircuit alert daemon — a long-running process (NOT a Vercel function) that holds the SmartAPI socket, keeps every enabled alert rule in memory,
// evaluates each live tick against the rules for its symbol, and sends Web Push through the dispatcher the moment a rule crosses.
// Run:  npm run daemon      (Node ≥ 20, e.g. Fly.io / Railway / Render / a VM — see docs/WEEK9_DAEMON.md)
import { createServer } from 'node:http';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { WebSocket as NodeWebSocket } from 'ws';
import { DirectSmartApiStream, type Listing as StreamListing, type MarketTick } from '../lib/smartapiDirect';
import { smartApiLogin, type FeedSession } from '../lib/smartapiLogin';
import { loadListings, type Listing } from '../lib/scripMaster';
import { isStreamWindow } from '../lib/market';
import { ackSecret } from '../lib/ackToken';
import { RuleIndex, toRule } from './engine';
import { createDispatcher } from './dispatcher';

/* ───────────── config ───────────── */
type Env = Record<string, string | undefined>;
export interface DaemonConfig {
  supabaseUrl: string; serviceKey: string; apiKey: string;
  vapid?: { publicKey: string; privateKey: string; subject: string };
  port: number; resyncMs: number; stallMs: number; maxBackoffMs: number;
}
export function loadConfig(env: Env = process.env): DaemonConfig {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = env.SMARTAPI_API_KEY ?? env.NEXT_PUBLIC_SMARTAPI_API_KEY;
  const missing = [!supabaseUrl && 'NEXT_PUBLIC_SUPABASE_URL', !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY', !apiKey && 'SMARTAPI_API_KEY',
    ...['SMARTAPI_CLIENT_CODE', 'SMARTAPI_PASSWORD', 'SMARTAPI_TOTP_SECRET'].filter((k) => !env[k])].filter(Boolean);
  if (missing.length) throw new Error(`Missing environment: ${missing.join(', ')}`);
  const pub = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = env.VAPID_PRIVATE_KEY, subject = env.VAPID_SUBJECT;
  return {
    supabaseUrl: supabaseUrl!, serviceKey: serviceKey!, apiKey: apiKey!,
    vapid: pub && priv && subject ? { publicKey: pub, privateKey: priv, subject } : undefined,
    port: Number(env.PORT ?? 8080), resyncMs: Number(env.DAEMON_RESYNC_MS ?? 300_000), stallMs: Number(env.DAEMON_STALL_MS ?? 20_000), maxBackoffMs: Number(env.DAEMON_MAX_BACKOFF_MS ?? 60_000),
  };
}

const log = (level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown> = {}) =>
  console[level === 'info' ? 'log' : level](JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta }));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The SmartAPI stream class with an overridable socket URL (staging / mock feed): SMARTAPI_STREAM_URL. */
class DaemonStream extends DirectSmartApiStream {
  override get url(): string {
    const o = process.env.SMARTAPI_STREAM_URL;
    return o ? `${o}?${super.url.split('?')[1]}` : super.url;
  }
}

/* ───────────── main ───────────── */
export async function main(cfg = loadConfig(), env: Env = process.env): Promise<{ stop: () => Promise<void> }> {
  const index = new RuleIndex();
  const dispatcher = createDispatcher({
    supabaseUrl: cfg.supabaseUrl, serviceKey: cfg.serviceKey, vapid: cfg.vapid, ackSecret: ackSecret(env), pushEndpointAllow: env.PUSH_ENDPOINT_ALLOW, emailEnabled: !!env.RESEND_API_KEY, log,
  });
  if (!dispatcher.configured) log('warn', 'web push is NOT configured (VAPID_* / ACK secret) — rules will be evaluated but nothing can be sent');

  const health = { startedAt: Date.now(), ticks: 0, lastTickAt: 0, lastTickLagMs: null as number | null, feed: 'idle' as string, reconnects: 0, logins: 0, resyncs: 0, lastResyncAt: 0, realtime: 'init' as string, unresolved: [] as string[] };
  let stopping = false;
  let stream: DaemonStream | null = null;
  let listings = new Map<string, Listing>();
  let subscribed = new Set<string>();

  /* ───── rules: initial load + resync + Realtime ───── */
  const restHeaders = { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` };
  async function fetchAllRules() {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, '')}/rest/v1/alert_rules?enabled=eq.true&select=id,user_id,symbol,kind,threshold,cooldown_min,channels,enabled,last_triggered_at&order=id&limit=1000&offset=${offset}`, { headers: restHeaders, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`alert_rules ${r.status}`);
      const rows = (await r.json()) as unknown[];
      for (const x of rows) { const rule = toRule(x); if (rule) out.push(rule); }
      if (rows.length < 1000) return out;
    }
  }
  async function resync(reason: string): Promise<void> {
    try {
      const d = index.replaceAll(await fetchAllRules());
      health.resyncs++; health.lastResyncAt = Date.now();
      log('info', 'rules synced', { reason, rules: index.size, symbols: index.symbols().length, ...d });
      subscribeNew();
    } catch (e) {
      log('error', 'rule resync failed', { reason, error: e instanceof Error ? e.message : String(e) });
    }
  }
  function applyChange(p: { eventType: string; new: unknown; old: unknown }): void {
    if (p.eventType === 'DELETE') {
      const id = (p.old as { id?: unknown } | null)?.id;
      if (typeof id === 'string') index.remove(id);
    } else {
      const rule = toRule(p.new);
      if (rule) index.upsert(rule);
      else log('warn', 'ignored unusable rule row from Realtime');
    }
    subscribeNew();
  }
  const sb = createClient(cfg.supabaseUrl, cfg.serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 50 } } });
  const channel: RealtimeChannel = sb
    .channel('daemon-alert-rules')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'alert_rules' }, (p) => applyChange(p as never))
    .subscribe((status, err) => {
      health.realtime = status;
      log(status === 'SUBSCRIBED' ? 'info' : 'warn', 'realtime status', { status, error: err?.message });
      if (status === 'SUBSCRIBED') void resync('realtime (re)subscribed');      // anything missed while the channel was down
    });
  await resync('startup');
  const resyncTimer = setInterval(() => void resync('periodic safety net'), cfg.resyncMs);

  /* ───── feed ───── */
  function subscribeNew(): void {
    if (!stream) return;
    const fresh: StreamListing[] = [];
    const unresolved: string[] = [];
    for (const sym of index.symbols()) {
      if (subscribed.has(sym)) continue;
      const l = listings.get(sym);
      if (l) { fresh.push({ symbol: sym, token: l.token, exchangeType: l.exchangeType }); subscribed.add(sym); } else unresolved.push(sym);
    }
    if (fresh.length) stream.subscribe(fresh);
    health.unresolved = unresolved;
    if (unresolved.length) log('warn', 'symbols not found in the scrip master (rules on them cannot fire)', { symbols: unresolved.slice(0, 20), count: unresolved.length });
  }
  function onTick(m: MarketTick): void {
    const now = Date.now();
    health.ticks++; health.lastTickAt = now;
    health.lastTickLagMs = m.timestamp > 0 ? Math.max(0, now - m.timestamp) : null;
    for (const hit of index.onTick({ symbol: m.symbol, ltp: m.lastPrice, prevClose: m.prevClose, ts: m.timestamp }, now)) {
      log('info', 'rule matched', { symbol: hit.rule.symbol, kind: hit.rule.kind, rule: hit.rule.id, price: hit.price, tickToMatchMs: hit.matchedAt - hit.tickTime });
      dispatcher.enqueue(hit);
    }
  }

  async function runFeed(): Promise<void> {
    let failures = 0;
    while (!stopping) {
      let session: FeedSession;
      const login = await smartApiLogin(env);
      if (!login.ok) {
        failures++;
        log('error', 'SmartAPI login failed', { reason: login.reason, message: login.message });
        await sleep(Math.min(cfg.maxBackoffMs, 1000 * 2 ** Math.min(failures, 6)) * (0.5 + Math.random() / 2));
        continue;
      }
      session = login.session; health.logins++;
      try { listings = await loadListings(); } catch (e) { log('warn', 'scrip master unavailable, retrying', { error: String(e) }); await sleep(5000); if (!listings.size) continue; }

      const ticksBefore = health.ticks;
      health.feed = 'connecting';
      let openedAt = Date.now();
      await new Promise<void>((done) => {
        const s = new DaemonStream({
          apiKey: cfg.apiKey, clientCode: session.clientCode, feedToken: session.feedToken,
          WebSocketImpl: NodeWebSocket as never, maxRetries: 5, baseDelayMs: 1000, pingMs: 25_000,
          onTick,
          onStatus: (st) => { health.feed = st; log('info', 'feed status', { status: st }); },
          onOpen: () => { openedAt = Date.now(); subscribed = new Set(); subscribeNew(); },
          onError: (e) => { log('error', 'feed gave up', { reason: e.reason, message: e.message, attempts: e.attempts }); finish(); },
        });
        stream = s;
        // watchdog: connected but silent during market hours → recycle; also recycle before the feed token expires
        const watch = setInterval(() => {
          const quiet = Date.now() - Math.max(health.lastTickAt, openedAt);
          if (stopping || Date.now() >= session.expiresAt) { log('info', 'recycling feed', { reason: stopping ? 'stopping' : 'session expiring' }); finish(); }
          else if (s.status === 'open' && isStreamWindow(Date.now()) && quiet > cfg.stallMs) { log('warn', 'feed stalled — reconnecting', { quietMs: quiet }); finish(); }
        }, 2000);
        function finish() { clearInterval(watch); s.close(); if (stream === s) stream = null; done(); }
        s.connect();
        stopHooks.push(finish);
      });
      stream = null; health.reconnects++;
      failures = health.ticks > ticksBefore ? 0 : failures + 1;                // a feed that delivered ticks resets the backoff
      if (!stopping) await sleep(Math.min(cfg.maxBackoffMs, 500 * 2 ** Math.min(failures, 7)) * (0.5 + Math.random() / 2));
    }
  }
  const stopHooks: (() => void)[] = [];
  void runFeed();

  /* ───── health endpoint (host health check / manual curl) ───── */
  const http = createServer((req, res) => {
    if (req.url !== '/healthz') { res.writeHead(404).end(); return; }
    const age = health.lastTickAt ? Date.now() - health.lastTickAt : null;
    const stalled = isStreamWindow(Date.now()) && (age === null ? Date.now() - health.startedAt > 60_000 : age > 60_000);
    res.writeHead(stalled ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: !stalled, uptimeS: Math.round((Date.now() - health.startedAt) / 1000), feed: health.feed, ticks: health.ticks, lastTickAgeMs: age, lastTickLagMs: health.lastTickLagMs, reconnects: health.reconnects, logins: health.logins, rules: index.size, symbols: index.symbols().length, unresolvedSymbols: health.unresolved.length, realtime: health.realtime, resyncs: health.resyncs, dispatch: dispatcher.stats(), pushConfigured: dispatcher.configured }));
  });
  http.listen(cfg.port, () => log('info', 'daemon up', { port: cfg.port, rules: index.size }));

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down');
    clearInterval(resyncTimer);
    stopHooks.splice(0).forEach((h) => h());
    await dispatcher.drain(5000);
    await sb.removeChannel(channel).catch(() => undefined);
    await new Promise<void>((r) => http.close(() => r()));
  }
  return { stop };
}

if (process.argv[1] && /daemon[\\/]index\.(ts|js|mjs|cjs)$/.test(process.argv[1])) {
  main().then(({ stop }) => {
    const bye = () => void stop().then(() => process.exit(0));
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
  }).catch((e) => { log('error', 'fatal', { error: e instanceof Error ? e.message : String(e) }); process.exit(1); });
  process.on('unhandledRejection', (e) => log('error', 'unhandled rejection', { error: String(e) }));
}
