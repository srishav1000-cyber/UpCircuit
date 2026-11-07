// Delivery side of the alert daemon: atomic claim → VAPID Web Push fan-out → latency-stamped alert_deliveries row (+ e-mail / in-app fallbacks).
// All I/O is injectable (fetch, push sender, clock) so it is unit-testable; the Next.js test-push route reuses it.
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { PushSub } from '../lib/cloud';
import { fanOut, isB64Url, isPushEndpoint, type SendFn } from '../lib/pushSender';
import { ackToken } from '../lib/ackToken';
import { terminalUrl } from '../lib/appUrl';
import { ruleEmail } from '../lib/alertWorker';
import { sendEmail } from '../lib/email';
import type { RuleMatch } from './engine';

export interface DispatcherConfig {
  supabaseUrl: string;
  /** service-role key — server only */
  serviceKey: string;
  vapid?: { publicKey: string; privateKey: string; subject: string };
  /** HMAC key for ACK tokens (lib/ackToken.ackSecret()) */
  ackSecret?: string;
  /** extra push hosts allowed (env PUSH_ENDPOINT_ALLOW) */
  pushEndpointAllow?: string;
  fetchImpl?: typeof fetch;
  /** replaces web-push (tests) */
  send?: SendFn;
  now?: () => number;
  /** parallel dispatches (default 16) */
  concurrency?: number;
  /** device-list cache (default 60 000 ms) */
  subsTtlMs?: number;
  /** push TTL seconds (default 300 — a stale price alert is worse than none) */
  ttlSec?: number;
  emailEnabled?: boolean;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export type DispatchOutcome = 'delivered' | 'no_devices' | 'push_failed' | 'duplicate' | 'error' | 'unconfigured';
export interface DispatchResult { outcome: DispatchOutcome; deliveryId?: string; sent: number; devices: number; failed: number; matchedAt: number; pushSentAt: number | null; detail?: string }
export interface DispatcherStats { enqueued: number; delivered: number; duplicates: number; noDevices: number; failed: number; errors: number; queued: number; inFlight: number; lastMatchToPushMs: number | null }

const iso = (ms: number | null | undefined): string | null => (ms && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const isUuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x);

export function createDispatcher(cfg: DispatcherConfig) {
  const f = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? Date.now;
  const base = cfg.supabaseUrl.replace(/\/+$/, '');
  const log = cfg.log ?? (() => undefined);
  const concurrency = cfg.concurrency ?? 16;
  const subsTtl = cfg.subsTtlMs ?? 60_000;
  const ttl = cfg.ttlSec ?? 300;
  const headers = { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, 'Content-Type': 'application/json' };
  const rest = (path: string, init: RequestInit = {}) =>
    f(`${base}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(8000) });

  const send: SendFn | null =
    cfg.send ?? (cfg.vapid ? (sub, body) => webpush.sendNotification(sub, body, { TTL: ttl, urgency: 'high', timeout: 8000, vapidDetails: cfg.vapid! }).then(() => undefined) : null);
  const configured = !!send && !!cfg.ackSecret;

  const stats: DispatcherStats = { enqueued: 0, delivered: 0, duplicates: 0, noDevices: 0, failed: 0, errors: 0, queued: 0, inFlight: 0, lastMatchToPushMs: null };

  /* ───────── devices ───────── */
  const subsCache = new Map<string, { at: number; subs: PushSub[] }>();
  async function loadSubs(userId: string, fresh = false): Promise<PushSub[]> {
    const hit = subsCache.get(userId);
    if (!fresh && hit && now() - hit.at < subsTtl) return hit.subs;
    const r = await rest(`push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,keys`);
    if (!r.ok) throw new Error(`push_subscriptions ${r.status}`);
    const rows = (await r.json()) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }[];
    const seen = new Set<string>();
    const subs: PushSub[] = [];
    for (const x of rows) {
      if (isPushEndpoint(x.endpoint, cfg.pushEndpointAllow) && isB64Url(x.keys?.p256dh, 40) && isB64Url(x.keys?.auth, 10, 40) && !seen.has(x.endpoint)) {
        seen.add(x.endpoint);
        subs.push({ endpoint: x.endpoint, keys: { p256dh: x.keys.p256dh, auth: x.keys.auth } });
      }
    }
    subsCache.set(userId, { at: now(), subs });
    return subs;
  }
  async function pruneGone(userId: string, endpoints: string[]): Promise<void> {
    if (!endpoints.length) return;
    subsCache.delete(userId);
    await Promise.all(endpoints.map((e) => rest(`push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&endpoint=eq.${encodeURIComponent(e)}`, { method: 'DELETE' }).catch(() => null)));
  }

  /* ───────── DB writes ───────── */
  async function claim(ruleId: string, windowKey: string): Promise<boolean> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await rest('rpc/claim_alert_rule', { method: 'POST', body: JSON.stringify({ p_rule: ruleId, p_window_key: windowKey }) });
        if (r.ok) return (await r.json()) === true;
        if (r.status < 500) throw new Error(`claim_alert_rule ${r.status}`);   // 4xx will not improve on retry
        last = new Error(`claim_alert_rule ${r.status}`);
      } catch (e) {
        if (attempt === 1 || (e instanceof Error && /claim_alert_rule 4/.test(e.message))) throw e;
        last = e;
      }
      await new Promise((res) => setTimeout(res, 150));
    }
    throw last instanceof Error ? last : new Error('claim failed');
  }
  type Row = { id?: string; rule_id: string | null; user_id: string; symbol: string; kind: string; price: number | null; channel: 'push' | 'email' | 'inapp'; status: 'sent' | 'failed' | 'skipped'; detail?: string; fired_at?: string | null; tick_time?: string | null; daemon_matched_at?: string | null; push_sent_at?: string | null };
  async function record(row: Row): Promise<void> {
    const body = JSON.stringify([{ ...row, detail: row.detail?.slice(0, 200) ?? null }]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await rest('alert_deliveries', { method: 'POST', body, headers: { Prefer: 'return=minimal' } }).catch(() => null);
      if (r?.ok) return;
      if (r && r.status < 500) { log('error', 'alert_deliveries insert rejected', { status: r.status }); return; }
    }
    log('error', 'alert_deliveries insert failed after retry', { symbol: row.symbol });
  }
  const audit = (entityId: string, meta: Record<string, unknown>) =>
    rest('rpc/audit_write', { method: 'POST', body: JSON.stringify({ p_action: 'alert_rule.fire', p_entity: 'alert_rule', p_entity_id: entityId, p_meta: meta }) }).catch(() => null);

  /* ───────── push ───────── */
  interface PushOutcome { sent: number; failed: number; devices: number; firstAcceptedAt: number | null; gone: string[] }
  async function pushTo(subs: PushSub[], payload: Record<string, unknown>): Promise<PushOutcome> {
    let firstAcceptedAt: number | null = null;
    const res = await fanOut(subs, payload as never, async (s, body) => {
      await send!(s, body);
      firstAcceptedAt ??= now();
    });
    return { sent: res.sent, failed: res.failed, devices: subs.length, firstAcceptedAt, gone: res.gone };
  }

  /** One matched rule → claim, push, record. Resolves with what happened (never throws). */
  async function dispatch(m: RuleMatch): Promise<DispatchResult> {
    const { rule } = m;
    const empty = { sent: 0, devices: 0, failed: 0, matchedAt: m.matchedAt, pushSentAt: null as number | null };
    if (!send) return { ...empty, outcome: 'unconfigured', detail: 'web push is not configured' };
    try {
      const windowKey = `${Math.floor(m.matchedAt / Math.max(1, rule.cooldown_min * 60_000))}`;
      // claim and device lookup run in parallel — the lookup is cached, the claim is the only mandatory round-trip
      const [claimed, subs] = await Promise.all([
        claim(rule.id, windowKey),
        rule.channels.push ? loadSubs(rule.user_id).catch((e) => { log('warn', 'device lookup failed', { error: String(e) }); return null; }) : Promise.resolve([] as PushSub[]),
      ]);
      if (!claimed) { stats.duplicates++; return { ...empty, outcome: 'duplicate' }; }

      const base = { rule_id: rule.id, user_id: rule.user_id, symbol: rule.symbol, kind: rule.kind, price: m.price };
      const tick = m.tickTime && Math.abs(m.tickTime - m.matchedAt) < 6 * 3600_000 ? m.tickTime : null;
      let result: DispatchResult = { ...empty, outcome: 'no_devices' };

      if (rule.channels.push) {
        if (subs === null) {
          await record({ ...base, channel: 'push', status: 'failed', detail: 'device lookup failed', fired_at: iso(m.matchedAt), tick_time: iso(tick), daemon_matched_at: iso(m.matchedAt) });
          stats.errors++;
          result = { ...empty, outcome: 'error', detail: 'device lookup failed' };
        } else if (!subs.length) {
          await record({ ...base, channel: 'push', status: 'skipped', detail: 'no registered devices', fired_at: iso(m.matchedAt), tick_time: iso(tick), daemon_matched_at: iso(m.matchedAt) });
          stats.noDevices++;
        } else {
          const id = randomUUID();
          const payload = { title: `UpCircuit · ${rule.symbol}`, body: m.message, url: terminalUrl(rule.symbol), tag: `rule-${rule.id}`, delivery_id: id, ack: cfg.ackSecret ? ackToken(id, cfg.ackSecret) : undefined, sent_at: m.matchedAt };
          const p = await pushTo(subs, payload);
          void pruneGone(rule.user_id, p.gone);
          const ok = p.sent > 0;
          await record({ ...base, id, channel: 'push', status: ok ? 'sent' : 'failed', detail: ok ? `${p.sent}/${p.devices} devices` : 'no device accepted the push', fired_at: iso(m.matchedAt), tick_time: iso(tick), daemon_matched_at: iso(m.matchedAt), push_sent_at: iso(p.firstAcceptedAt) });
          if (ok) { stats.delivered++; stats.lastMatchToPushMs = (p.firstAcceptedAt ?? now()) - m.matchedAt; } else stats.failed++;
          result = { outcome: ok ? 'delivered' : 'push_failed', deliveryId: id, sent: p.sent, devices: p.devices, failed: p.failed, matchedAt: m.matchedAt, pushSentAt: p.firstAcceptedAt };
        }
      } else {
        // push switched off for this rule: keep the user-visible trace the cron worker always wrote
        await record({ ...base, channel: 'inapp', status: 'sent', detail: m.message, fired_at: iso(m.matchedAt), tick_time: iso(tick), daemon_matched_at: iso(m.matchedAt) });
      }

      if (rule.channels.email) void emailFallback(m).catch((e) => log('warn', 'email failed', { error: String(e) }));
      void audit(rule.id, { symbol: rule.symbol, kind: rule.kind, price: m.price, via: 'daemon' });
      return result;
    } catch (e) {
      stats.errors++;
      log('error', 'dispatch failed', { rule: rule.id, error: e instanceof Error ? e.message : String(e) });
      return { ...empty, outcome: 'error', detail: e instanceof Error ? e.message : 'dispatch failed' };
    }
  }

  async function emailFallback(m: RuleMatch): Promise<void> {
    const { rule } = m;
    const base = { rule_id: rule.id, user_id: rule.user_id, symbol: rule.symbol, kind: rule.kind, price: m.price, channel: 'email' as const, fired_at: iso(m.matchedAt) };
    if (!cfg.emailEnabled) return record({ ...base, status: 'skipped', detail: 'unconfigured' });
    const u = await f(`${base_auth()}/admin/users/${encodeURIComponent(rule.user_id)}`, { headers, signal: AbortSignal.timeout(6000) }).catch(() => null);
    const to = u?.ok ? ((await u.json()) as { email?: string }).email : undefined;
    if (!to) return record({ ...base, status: 'skipped', detail: 'no_address' });
    const ok = (await sendEmail({ to, ...ruleEmail({ rule, price: m.price, pct: m.pct, message: m.message }) })).ok;
    return record({ ...base, status: ok ? 'sent' : 'failed', detail: ok ? undefined : 'failed' });
  }
  const base_auth = () => `${base}/auth/v1`;

  /* ───────── test push (settings button) ───────── */
  async function sendTest(userId: string): Promise<{ ok: boolean; error?: string; deliveryId?: string; sent: number; devices: number; failed: number; pruned: number }> {
    const none = { sent: 0, devices: 0, failed: 0, pruned: 0 };
    if (!configured) return { ok: false, error: 'Web push is not configured on the server (VAPID keys / ACK secret).', ...none };
    if (!isUuid(userId)) return { ok: false, error: 'Bad user id.', ...none };
    let subs: PushSub[];
    try { subs = await loadSubs(userId, true); } catch { return { ok: false, error: 'Could not read your devices.', ...none }; }
    if (!subs.length) return { ok: false, error: 'No device is registered yet — switch on Web Push Notifications on this device first.', ...none };
    const id = randomUUID();
    const t0 = now();
    const payload = { title: 'UpCircuit · test push', body: 'If you can read this, closed-app alerts will reach this device.', url: terminalUrl('NIFTY'), tag: `test-${userId}`, delivery_id: id, ack: ackToken(id, cfg.ackSecret!), sent_at: t0 };
    const p = await pushTo(subs, payload);
    await pruneGone(userId, p.gone);
    const ok = p.sent > 0;
    await record({ id, rule_id: null, user_id: userId, symbol: 'TEST', kind: 'test', price: null, channel: 'push', status: ok ? 'sent' : 'failed', detail: ok ? `${p.sent}/${p.devices} devices` : 'no device accepted the push', fired_at: iso(t0), daemon_matched_at: iso(t0), push_sent_at: iso(p.firstAcceptedAt) });
    return { ok, error: ok ? undefined : p.gone.length === p.devices ? 'Every saved device was rejected as expired and has been removed — switch push off and on again on this device.' : 'The push service did not accept the message.', deliveryId: id, sent: p.sent, devices: p.devices, failed: p.failed, pruned: p.gone.length };
  }

  /* ───────── bounded queue (keeps a burst of matches off the tick path) ───────── */
  const queue: RuleMatch[] = [];
  const idle: (() => void)[] = [];
  function pump(): void {
    while (stats.inFlight < concurrency && queue.length) {
      const m = queue.shift()!;
      stats.queued = queue.length;
      stats.inFlight++;
      void dispatch(m).finally(() => {
        stats.inFlight--;
        if (!stats.inFlight && !queue.length) idle.splice(0).forEach((r) => r());
        else pump();
      });
    }
  }
  function enqueue(m: RuleMatch): void {
    stats.enqueued++;
    queue.push(m);
    stats.queued = queue.length;
    pump();
  }
  /** resolves when the queue is empty and nothing is in flight (or after timeoutMs) */
  function drain(timeoutMs = 5000): Promise<void> {
    if (!stats.inFlight && !queue.length) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, timeoutMs);
      idle.push(() => { clearTimeout(t); res(); });
    });
  }

  return { dispatch, enqueue, drain, sendTest, stats: () => ({ ...stats }), configured, invalidateDevices: (userId?: string) => (userId ? subsCache.delete(userId) : subsCache.clear()) };
}
export type Dispatcher = ReturnType<typeof createDispatcher>;
