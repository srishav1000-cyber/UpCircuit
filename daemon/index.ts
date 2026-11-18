// UpCircuit alert daemon — a long-running process (NOT a Vercel function) that holds the SmartAPI socket, keeps every enabled alert rule in memory,
// evaluates each live tick against the rules for its symbol, and sends Web Push through the dispatcher the moment a rule crosses.
// Run:  npm run daemon      (Node ≥ 20, e.g. Fly.io / Railway / Render / a VM — see docs/WEEK9_DAEMON.md)
import { adminHeaders, cleanEnv, cleanUrl, keyKind, privilegedKeyProblem, sbFailure, sbFailureText } from '../lib/supabaseAdmin';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { WebSocket as NodeWebSocket } from 'ws';
import { DirectSmartApiStream, type Listing as StreamListing, type MarketTick } from '../lib/smartapiDirect';
import { smartApiLogin, type FeedSession } from '../lib/smartapiLogin';
import { loadListings, type Listing } from '../lib/scripMaster';
import { isMarketOpen } from '../lib/market';
import { ackSecret } from '../lib/ackToken';
import { fetchBars } from '../lib/yahooQuotes';
import { RuleIndex, toRule } from './engine';
import { BaselineStore } from './baselines';
import { createDispatcher } from './dispatcher';
import type { DepthFlag } from '../lib/heuristicFlags';
import { createLease, newHolderId, type LeaseRow } from './lease';
import { startHealthServer } from './health';
import { lastOpenAt, sessionDeadline } from './session';

/* ───────────── config ───────────── */
type Env = Record<string, string | undefined>;
export interface DaemonConfig {
  supabaseUrl: string; serviceKey: string; apiKey: string;
  vapid?: { publicKey: string; privateKey: string; subject: string };
  port: number; resyncMs: number; stallMs: number; maxBackoffMs: number;
}
export function loadConfig(env: Env = process.env): DaemonConfig {
  const supabaseUrl = cleanUrl(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL);
  const serviceKey = cleanEnv(env.SUPABASE_SERVICE_ROLE_KEY);
  const apiKey = env.SMARTAPI_API_KEY ?? env.NEXT_PUBLIC_SMARTAPI_API_KEY;
  const missing = [!supabaseUrl && 'NEXT_PUBLIC_SUPABASE_URL', !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY', !apiKey && 'SMARTAPI_API_KEY',
    ...['SMARTAPI_CLIENT_CODE', 'SMARTAPI_PASSWORD', 'SMARTAPI_TOTP_SECRET'].filter((k) => !env[k])].filter(Boolean);
  if (missing.length) throw new Error(`Missing environment: ${missing.join(', ')}`);
  const keyProblem = privilegedKeyProblem(serviceKey);
  if (keyProblem) throw new Error(keyProblem);
  const pub = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = env.VAPID_PRIVATE_KEY, subject = env.VAPID_SUBJECT;
  return {
    supabaseUrl: supabaseUrl!, serviceKey: serviceKey!, apiKey: apiKey!,
    vapid: pub && priv && subject ? { publicKey: pub, privateKey: priv, subject } : undefined,
    port: Number(env.PORT || 10000), resyncMs: Number(env.DAEMON_RESYNC_MS ?? 300_000), stallMs: Number(env.DAEMON_STALL_MS ?? 20_000), maxBackoffMs: Number(env.DAEMON_MAX_BACKOFF_MS ?? 60_000),
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
export async function main(cfg = loadConfig(), env: Env = process.env): Promise<{ stop: () => Promise<void>; port: number }> {
  const index = new RuleIndex();
  const dispatcher = createDispatcher({
    supabaseUrl: cfg.supabaseUrl, serviceKey: cfg.serviceKey, vapid: cfg.vapid, ackSecret: ackSecret(env), pushEndpointAllow: env.PUSH_ENDPOINT_ALLOW, emailEnabled: !!env.RESEND_API_KEY, log,
  });
  const sbHeaders = adminHeaders(cfg.serviceKey, true);
  const sbBase = cleanUrl(cfg.supabaseUrl);
  // volume baselines: real daily bars (Yahoo, the repo's existing historical source — the SmartAPI login deliberately never exposes a JWT for getCandleData)
  const baselines = new BaselineStore({
    fetchDaily: (symbol) => fetchBars({ symbol, exch: 'NSE' }, '1Y'),
    fetchIntraday: (symbol) => fetchBars({ symbol, exch: 'NSE' }, '15m'),                 // ~1 month of 15-minute bars → the time-of-day profile
    onComputed: async (rows) => {
      const r = await fetch(`${sbBase}/rest/v1/volume_baselines`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify(rows.map((x) => ({ symbol: x.symbol, median_volume: x.medianVolume, sessions: x.sessions, status: x.status, computed_at: new Date(x.computedAt).toISOString(), profile: x.profile.status === 'ok' ? { cum: x.profile.cum, sessions: x.profile.sessions } : null, profile_sessions: x.profile.sessions }))),
      });
      if (!r.ok) throw new Error(`volume_baselines ${r.status}`);
    },
    log,
  });
  index.setBaselineLookup((sym, nowMs) => { const e = baselines.expected(sym, nowMs); return e ? { value: e.expected, basis: e.basis } : null; });
  // heuristic depth flags (walls, rapid add/cancel) → public.depth_flags: batched every 2 s, bounded buffer, rows older than 2 days pruned hourly.
  // They are screening hints for the Surveillance workspace, never alert rules and never proof of manipulation.
  const flagBuf: DepthFlag[] = [];
  let flagFailLogged = 0;
  index.setFlagSink((f) => { if (flagBuf.length < 500) flagBuf.push(f); });
  const flushFlags = async () => {
    if (!flagBuf.length) return;
    const batch = flagBuf.splice(0, 100);
    try {
      const r = await fetch(`${sbBase}/rest/v1/depth_flags`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, signal: AbortSignal.timeout(6000),
        body: JSON.stringify(batch.map((f) => ({ symbol: f.symbol, kind: f.kind, side: f.side, severity: f.severity, price: f.price, qty: f.qty, detail: f.detail, label: f.label, flagged_at: new Date(f.ts > 0 ? f.ts : Date.now()).toISOString() }))),
      });
      if (!r.ok) throw new Error(`depth_flags ${r.status}`);
    } catch (e) {
      const t = Date.now();
      if (t - flagFailLogged > 60_000) { flagFailLogged = t; log('warn', 'depth flag write failed (is docs/WEEK9_TURN44_SCHEMA.sql applied?)', { error: e instanceof Error ? e.message : String(e), dropped: batch.length }); }
    }
  };
  const pruneFlags = () => void fetch(`${sbBase}/rest/v1/depth_flags?flagged_at=lt.${encodeURIComponent(new Date(Date.now() - 2 * 86_400_000).toISOString())}`, { method: 'DELETE', headers: sbHeaders, signal: AbortSignal.timeout(8000) }).catch(() => undefined);
  const flagTimer = setInterval(() => void flushFlags(), 2000);
  const flagPruneTimer = setInterval(pruneFlags, 3_600_000);
  const wantBaselines = () => baselines.want(index.symbolsWithKind('volume_surge'));
  if (!dispatcher.configured) log('warn', 'web push is NOT configured (VAPID_* / ACK secret) — rules will be evaluated but nothing can be sent');

  const health = { startedAt: Date.now(), ticks: 0, lastTickAt: 0, lastTickLagMs: null as number | null, feed: 'idle' as string, reconnects: 0, logins: 0, resyncs: 0, lastResyncAt: 0, realtime: 'init' as string, unresolved: [] as string[] };
  let stopping = false;

  /* ───── leader election (docs/WEEK10_SCHEMA.sql): only the lease holder opens the feed and dispatches; others stand by ───── */
  const holderId = newHolderId();
  const haOff = env.DAEMON_HA === '0';
  let haMissing = false;
  const lease = createLease({
    name: env.DAEMON_LEASE_NAME || 'alert-daemon', holderId, log,
    ttlSeconds: Number(env.DAEMON_LEASE_TTL_S ?? 30), renewMs: Number(env.DAEMON_LEASE_RENEW_MS ?? 10_000),
    acquire: async (name, holder, ttlSeconds): Promise<LeaseRow> => {
      if (haOff) return { acquired: true, holder_id: holder, expires_at: null, epoch: 0 };
      const r = await fetch(`${sbBase}/rest/v1/rpc/acquire_daemon_lease`, { method: 'POST', headers: sbHeaders, signal: AbortSignal.timeout(5000), body: JSON.stringify({ p_lease_name: name, p_holder_id: holder, p_ttl_seconds: ttlSeconds }) });
      if (r.status === 404) {
        // migration not applied: fail OPEN as a sole leader (a second daemon would only duplicate work — claim_alert_rule still dedupes), but say so loudly
        if (!haMissing) { haMissing = true; log('error', 'acquire_daemon_lease not found — running WITHOUT leader election; apply docs/WEEK10_SCHEMA.sql before starting a second instance'); }
        return { acquired: true, holder_id: holder, expires_at: null, epoch: 0 };
      }
      if (!r.ok) throw new Error(`acquire_daemon_lease ${r.status}`);
      const rows = (await r.json()) as LeaseRow[];
      if (!rows[0]) throw new Error('acquire_daemon_lease returned no row');
      return rows[0];
    },
    release: (name, holder) => (haOff || haMissing ? Promise.resolve() : fetch(`${sbBase}/rest/v1/rpc/release_daemon_lease`, { method: 'POST', headers: sbHeaders, signal: AbortSignal.timeout(3000), body: JSON.stringify({ p_lease_name: name, p_holder_id: holder }) })),
    onChange: (info) => { if (info.role === 'standby') health.feed = 'standby'; },
  });
  /* ───── HTTP: bound FIRST (before any network call) so the host's port scan and keep-alive pings succeed while the daemon boots ───── */
  const server = await startHealthServer({
    port: cfg.port, host: '0.0.0.0',
    deps: {
      // liveness: in-memory reads only (no DB / SmartAPI work, no state change)
      liveness: () => ({ ok: true, role: lease.isLeader() ? 'leader' : 'standby', epoch: lease.info().epoch, feed: lease.isLeader() ? health.feed : 'standby', uptimeSec: Math.round((Date.now() - health.startedAt) / 1000), timestamp: new Date().toISOString() }),
      readiness: () => {
        const now = Date.now(), age = health.lastTickAt ? now - health.lastTickAt : null, leader = lease.isLeader();
        // silent feed = no tick for 60 s since the later of: last tick, process start, today's 09:15 open — judged during the cash session only
        const stalled = leader && isMarketOpen(now) && now - Math.max(health.lastTickAt, health.startedAt, lastOpenAt(now)) > 60_000;
        const li = lease.info();
        return { ok: !stalled, body: { ok: !stalled, ha: { role: leader ? 'leader' : 'standby', instance: holderId, leader: li.holder, epoch: li.epoch, expiresAt: li.expiresAt, enabled: !haOff && !haMissing }, uptimeS: Math.round((now - health.startedAt) / 1000), feed: health.feed, ticks: health.ticks, lastTickAgeMs: age, lastTickLagMs: health.lastTickLagMs, reconnects: health.reconnects, logins: health.logins, rules: index.size, symbols: index.symbols().length, unresolvedSymbols: health.unresolved.length, realtime: health.realtime, resyncs: health.resyncs, dispatch: dispatcher.stats(), baselines: baselines.stats(), volumeRulesNA: index.volumeRulesNA(), depthFlags: { ...index.flagStats(), buffered: flagBuf.length }, pushConfigured: dispatcher.configured } };
      },
    },
  });
  log('info', 'http listening', { host: '0.0.0.0', port: (server.address() as { port: number } | null)?.port ?? cfg.port });
  let stream: DaemonStream | null = null;
  let listings = new Map<string, Listing>();
  let subscribed = new Set<string>();

  /* ───── rules: initial load + resync + Realtime ───── */
  const restHeaders = adminHeaders(cfg.serviceKey);
  async function fetchAllRules() {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${cleanUrl(cfg.supabaseUrl)}/rest/v1/alert_rules?enabled=eq.true&select=id,user_id,symbol,kind,threshold,cooldown_min,channels,enabled,last_triggered_at&order=id&limit=1000&offset=${offset}`, { headers: restHeaders, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`alert_rules ${sbFailureText(await sbFailure(r))}`);
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
      subscribeNew(); wantBaselines();
    } catch (e) {
      log('error', 'rule resync failed', { reason, error: e instanceof Error ? e.message : String(e), serviceKey: keyKind(cfg.serviceKey), hint: /\b(401|403)\b/.test(String(e)) ? 'Supabase rejected the server key: check SUPABASE_SERVICE_ROLE_KEY is this project’s secret/service_role key with no stray spaces or quotes' : undefined });
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
    subscribeNew(); wantBaselines();
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
  const baselineTimer = setInterval(wantBaselines, 10 * 60_000);   // cheap: only stale symbols are reloaded (6 h TTL, IST day rollover)

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
    if (!lease.isLeader()) return;                                          // a ghost tick after losing the lease must not dispatch
    const now = Date.now();
    health.ticks++; health.lastTickAt = now;
    health.lastTickLagMs = m.timestamp > 0 ? Math.max(0, now - m.timestamp) : null;
    for (const hit of index.onTick({ symbol: m.symbol, ltp: m.lastPrice, prevClose: m.prevClose, ts: m.timestamp, volume: m.volume, depth: m.depth }, now)) {
      log('info', 'rule matched', { symbol: hit.rule.symbol, kind: hit.rule.kind, rule: hit.rule.id, price: hit.price, tickToMatchMs: hit.matchedAt - hit.tickTime });
      dispatcher.enqueue(hit);
    }
  }

  async function runFeed(): Promise<void> {
    let failures = 0;
    while (!stopping) {
      // standby: no SmartAPI login, no feed, no dispatch — the rule index stays warm through Realtime so takeover is instant
      if (!lease.isLeader()) { health.feed = 'standby'; await sleep(1000); continue; }
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

      const deadline = sessionDeadline(session.expiresAt, Date.now());
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
          const quiet = Date.now() - Math.max(health.lastTickAt, openedAt, lastOpenAt(Date.now()));
          if (!lease.isLeader()) { log('warn', 'lost the leader lease — closing the feed'); finish(); }
          else if (stopping || Date.now() >= deadline) { log('info', 'recycling feed', { reason: stopping ? 'stopping' : 'scheduled session refresh (6 h TTL or 08:45 IST)' }); finish(); }
          else if (s.status === 'open' && isMarketOpen(Date.now()) && quiet > cfg.stallMs) { log('warn', 'feed stalled — reconnecting', { quietMs: quiet }); finish(); }
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
  await lease.start();
  void runFeed();

  /* ───── heartbeat → public.daemon_health() (UI: FeedHealthStatus) ───── */
  let beatFailLogged = 0;
  const beat = async () => {
    const now = Date.now();
    try {
      const r = await fetch(`${sbBase}/rest/v1/rpc/daemon_beat`, {
        method: 'POST', headers: sbHeaders, signal: AbortSignal.timeout(4000),
        body: JSON.stringify({ p_id: lease.isLeader() ? 'alert-daemon' : 'alert-daemon-standby', p_feed_status: lease.isLeader() ? health.feed : 'standby', p_last_tick_age_ms: health.lastTickAt ? now - health.lastTickAt : null, p_ticks: health.ticks, p_reconnects: health.reconnects, p_rules: index.size, p_symbols: index.symbols().length, p_started_at: new Date(health.startedAt).toISOString(), p_version: 'week10' }),
      });
      if (!r.ok) throw new Error(`daemon_beat ${r.status}`);
    } catch (e) {
      if (now - beatFailLogged > 60_000) { beatFailLogged = now; log('warn', 'heartbeat failed (is docs/WEEK9_TURN43_SCHEMA.sql applied?)', { error: e instanceof Error ? e.message : String(e) }); }
    }
  };
  const beatTimer = setInterval(() => void beat(), 5000);
  void beat();

  log('info', 'daemon up', { rules: index.size, serviceKey: keyKind(cfg.serviceKey) });

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down');
    clearInterval(resyncTimer); clearInterval(baselineTimer); clearInterval(beatTimer); clearInterval(flagTimer); clearInterval(flagPruneTimer); await flushFlags();
    stopHooks.splice(0).forEach((h) => h());
    await dispatcher.drain(5000);
    await lease.stop();                                                  // release the lease so a standby takes over on its next poll
    await sb.removeChannel(channel).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
  }
  return { stop, port: (server.address() as { port: number }).port };
}

if (process.argv[1] && /daemon[\\/]index\.(ts|js|mjs|cjs)$/.test(process.argv[1])) {
  main().then(({ stop }) => {
    const bye = () => void stop().then(() => process.exit(0));
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
  }).catch((e) => { log('error', 'fatal', { error: e instanceof Error ? e.message : String(e) }); process.exit(1); });
  process.on('unhandledRejection', (e) => log('error', 'unhandled rejection', { error: String(e) }));
}
