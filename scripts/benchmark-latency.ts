// Synthetic replay + latency benchmark for the alert pipeline.
//   npx tsx scripts/benchmark-latency.ts [--rules 600] [--symbols 50] [--rate 2000] [--seconds 10] [--devices 1] [--seed 1] [--out docs/benchmark-results.json]
//
// What runs for real (same code the daemon runs): RuleIndex.onTick (rule evaluation + volume baseline + top-5 imbalance + heuristic flags),
// createDispatcher (claim → device lookup → quiet-hours lookup → push fan-out → alert_deliveries row), lib/ackToken HMAC.
// What is simulated, and therefore NOT measured:
//   • the exchange feed — ticks are generated here and sent over a loopback WebSocket (real `ws` framing + JSON parse, zero network distance);
//   • Supabase — a local HTTP server answering claim_alert_rule / push_subscriptions / alert_deliveries (zero database time);
//   • the push service (FCM / APNs / Mozilla) — a local HTTP endpoint that accepts immediately; real push-service latency is outside this benchmark;
//   • the device — the "client ACK" is a loopback HTTP POST carrying the real ACK token, verified with the real HMAC check. Real device wake-up
//     and service-worker time is outside this benchmark (the live numbers come from alert_deliveries.sw_ack_at via the Delivery log).
// Server, feed and client share ONE Node process and event loop, which makes the numbers conservative for the match stage (the generator competes
// with the engine) and optimistic for everything that crosses a real network. Report them as "software pipeline on loopback", nothing more.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { RuleIndex } from '../daemon/engine';
import { createDispatcher } from '../daemon/dispatcher';
import { ackSecret, verifyAckToken } from '../lib/ackToken';
import type { AlertRule, RuleKind } from '../lib/alertRules';
import type { DepthLevel } from '../lib/types';

/* ───────── args ───────── */
const argv = process.argv.slice(2);
const arg = (k: string, d: number | string): number | string => { const i = argv.indexOf(`--${k}`); if (i < 0 || !argv[i + 1]) return d; return typeof d === 'number' ? Number(argv[i + 1]) : argv[i + 1]; };
const RULES = Math.max(1, Number(arg('rules', 600))), SYMBOLS = Math.max(1, Number(arg('symbols', 50))), RATE = Math.max(1, Number(arg('rate', 2000)));
const SECONDS = Math.max(1, Number(arg('seconds', 10))), DEVICES = Math.max(1, Number(arg('devices', 1))), SEED = Number(arg('seed', 1)), OUT = String(arg('out', ''));
if (![RULES, SYMBOLS, RATE, SECONDS, DEVICES, SEED].every(Number.isFinite)) { console.error('bad numeric argument'); process.exit(2); }

/* ───────── helpers ───────── */
function rng(seed: number): () => number { let s = seed >>> 0 || 1; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);
const pct = (xs: number[], p: number): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
interface Stat { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }
const stat = (xs: number[]): Stat => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : null });
const f = (v: number | null) => (v === null ? 'N/A' : v < 10 ? v.toFixed(3) : v < 1000 ? v.toFixed(1) : v.toFixed(0));

/* ───────── synthetic market + rules ───────── */
const syms = Array.from({ length: SYMBOLS }, (_, i) => `SYN${String(i).padStart(3, '0')}`);
const px0 = new Map(syms.map((s) => [s, 100 + rand() * 1900]));
const BASELINE = 1_000_000;
const KINDS: RuleKind[] = ['price_above', 'price_below', 'pct_up', 'pct_down', 'circuit_proximity', 'volume_surge', 'order_imbalance_above', 'order_imbalance_below'];
const rules: AlertRule[] = Array.from({ length: RULES }, (_, i) => {
  const kind = KINDS[i % KINDS.length], sym = syms[Math.floor(rand() * SYMBOLS)], p0 = px0.get(sym)!;
  const threshold = kind === 'price_above' ? p0 * (1 + 0.001 + rand() * 0.012) : kind === 'price_below' ? p0 * (1 - 0.001 - rand() * 0.012)
    : kind === 'pct_up' || kind === 'pct_down' ? 0.1 + rand() * 0.8 : kind === 'circuit_proximity' ? 4.6 + rand() * 0.4 : kind === 'volume_surge' ? 0.55 + rand() * 0.6 : 0.15 + rand() * 0.5;
  return { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, user_id: `user-${i % 40}`, symbol: sym, kind, threshold: +threshold.toFixed(4), cooldown_min: 1, channels: { push: true, email: false }, enabled: true, last_triggered_at: null };
});

interface Tick { symbol: string; ltp: number; prevClose: number; ts: number; volume: number; depth: { bids: DepthLevel[]; asks: DepthLevel[] }; emit: number }
const px = new Map(px0), vol = new Map(syms.map((s) => [s, BASELINE * 0.45])), bias = new Map(syms.map((s) => [s, (rand() - 0.5) * 1.2]));
function nextTick(sym: string): Tick {
  const p = px.get(sym)! * (1 + (rand() - 0.5 + (bias.get(sym)! * 0.02)) * 0.0008);
  px.set(sym, p); vol.set(sym, vol.get(sym)! + 800 + rand() * 2400);
  bias.set(sym, Math.max(-0.9, Math.min(0.9, bias.get(sym)! + (rand() - 0.5) * 0.1)));
  const tilt = bias.get(sym)!;
  const lv = (side: 1 | -1, k: number): DepthLevel[] => Array.from({ length: 5 }, (_, i) => ({ price: +(p + side * 0.05 * (i + 1)).toFixed(2), qty: Math.round((2000 + rand() * 3000) * (1 + side * tilt * k) / (1 + i * 0.1)), orders: 1 + Math.floor(rand() * 9) }));
  return { symbol: sym, ltp: +p.toFixed(2), prevClose: px0.get(sym)!, ts: Date.now(), volume: Math.round(vol.get(sym)!), depth: { bids: lv(-1, 1), asks: lv(1, -1) }, emit: 0 };
}

/* ───────── loopback services ───────── */
const secret = ackSecret({ VAPID_PRIVATE_KEY: 'bench'.repeat(10) })!;
const trace = new Map<string, { emit: number; match: number; enq: number; pushed?: number; acked?: number; delivery?: string }>();
const body = (req: IncomingMessage): Promise<string> => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
const J = (res: ServerResponse, v: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
let claims = 0, rowsWritten = 0, pushes = 0, acksOk = 0, acksBad = 0;
const subs = (user: string) => Array.from({ length: DEVICES }, (_, i) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${encodeURIComponent(user)}-dev${i}`, keys: { p256dh: 'B'.repeat(80), auth: 'a'.repeat(22) } }));
const supabase = createServer(async (req, res) => {
  const u = req.url ?? '';
  if (u.includes('rpc/claim_alert_rule')) { await body(req); claims++; return J(res, true); }
  if (u.includes('rpc/audit_write')) { await body(req); return J(res, null); }
  if (u.includes('push_subscriptions')) { const m = /user_id=eq\.([^&]+)/.exec(u); return J(res, subs(decodeURIComponent(m?.[1] ?? 'x'))); }
  if (u.includes('user_quiet_hours')) return J(res, []);
  if (u.includes('/alert_deliveries')) { await body(req); rowsWritten++; res.writeHead(201).end(); return; }
  J(res, {}, 404);
});
const pushSvc = createServer(async (req, res) => { await body(req); pushes++; res.writeHead(201).end(); });
let ackBase = '';
const ackSvc = createServer(async (req, res) => {
  const now = performance.now();
  const { delivery_id, ack } = JSON.parse(await body(req)) as { delivery_id: string; ack: string; rule: string };
  if (verifyAckToken(delivery_id, ack, secret)) { acksOk++; for (const t of trace.values()) if (t.delivery === delivery_id) t.acked ??= now; res.writeHead(204).end(); }
  else { acksBad++; res.writeHead(403).end(); }
});
const listen = (s: ReturnType<typeof createServer>) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

/* ───────── run ───────── */
async function main(): Promise<void> {
  const [sbPort, pushPort, ackPort] = await Promise.all([listen(supabase), listen(pushSvc), listen(ackSvc)]);
  ackBase = `http://127.0.0.1:${ackPort}`;

  const index = new RuleIndex();
  index.setBaselineLookup(() => BASELINE);
  index.setFlagSink(() => undefined);                     // flag detection runs; persistence is not part of the alert path
  for (const r of rules) index.upsert(r);

  const dispatcher = createDispatcher({
    supabaseUrl: `http://127.0.0.1:${sbPort}`, serviceKey: 'bench', ackSecret: secret, concurrency: 16,
    send: async (_sub, payload) => {
      const p = JSON.parse(payload) as { tag?: string; delivery_id: string; ack: string };
      const rid = p.tag?.replace(/^rule-/, '') ?? '';
      const r = await fetch(`http://127.0.0.1:${pushPort}/push`, { method: 'POST', body: payload });
      if (!r.ok) throw new Error(`push ${r.status}`);
      const t = trace.get(rid);
      if (t && t.pushed === undefined) {
        t.pushed = performance.now(); t.delivery = p.delivery_id;
        // simulated device: the service worker POSTs the ACK as soon as the notification is shown
        void fetch(`${ackBase}/ack`, { method: 'POST', body: JSON.stringify({ delivery_id: p.delivery_id, ack: p.ack, rule: rid }) }).catch(() => undefined);
      }
    },
  });

  const ingest: number[] = [], matchTick: number[] = [];
  let received = 0, matchedTicks = 0, firedTotal = 0, lagMax = 0;
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const wsPort = (wss.address() as { port: number }).port;
  const client = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const serverSock = new Promise<import('ws').WebSocket>((r) => wss.once('connection', r));
  await new Promise<void>((r) => client.once('open', () => r()));
  const sock = await serverSock;

  const done = new Promise<void>((resolve) => {
    client.on('message', (data) => {
      const t0 = performance.now();
      const m = JSON.parse(String(data)) as Tick;
      const t1 = performance.now();
      ingest.push(t1 - m.emit);                                    // generator send → parsed on the consumer side (includes socket, framing, JSON.parse, loop wait)
      const a = performance.now();
      const hits = index.onTick({ symbol: m.symbol, ltp: m.ltp, prevClose: m.prevClose, ts: m.ts, volume: m.volume, depth: m.depth });
      const b = performance.now();
      matchTick.push(b - a); received++; void t0;
      if (hits.length) { matchedTicks++; for (const h of hits) { firedTotal++; trace.set(h.rule.id, { emit: m.emit, match: b, enq: performance.now() }); dispatcher.enqueue(h); } }
      if (received === total) resolve();
    });
  });
  const total = Math.floor(RATE * SECONDS);

  console.log(`benchmark: ${RULES} rules · ${SYMBOLS} symbols · ${RATE} ticks/s × ${SECONDS}s = ${total} ticks · ${DEVICES} device(s)/user · seed ${SEED}`);
  const start = performance.now();
  let sent = 0;
  await new Promise<void>((resolve) => {
    let last = performance.now();
    const pump = () => {
      const now = performance.now();
      lagMax = Math.max(lagMax, now - last - 1); last = now;
      const due = Math.min(total, Math.floor(((now - start) / 1000) * RATE));
      while (sent < due) { const t = nextTick(syms[sent % SYMBOLS]); t.emit = performance.now(); sock.send(JSON.stringify(t)); sent++; }
      if (sent < total) setTimeout(pump, 1); else resolve();
    };
    pump();
  });
  await done;
  const feedMs = performance.now() - start;
  await dispatcher.drain(15_000);
  await new Promise((r) => setTimeout(r, 500));                    // let the last ACKs land

  /* ───────── report ───────── */
  const T = [...trace.values()];
  const push = T.filter((t) => t.pushed !== undefined).map((t) => t.pushed! - t.enq);
  const ack = T.filter((t) => t.acked !== undefined && t.pushed !== undefined).map((t) => t.acked! - t.pushed!);
  const e2e = T.filter((t) => t.acked !== undefined).map((t) => t.acked! - t.emit);
  const e2ePush = T.filter((t) => t.pushed !== undefined).map((t) => t.pushed! - t.emit);
  const st = dispatcher.stats();
  const result = {
    config: { rules: RULES, symbols: SYMBOLS, ticksPerSecondTarget: RATE, seconds: SECONDS, devicesPerUser: DEVICES, seed: SEED, node: process.version, platform: `${process.platform}-${process.arch}` },
    run: { ticksSent: sent, ticksProcessed: received, achievedTicksPerSecond: Math.round((received / feedMs) * 1000), wallMs: Math.round(feedMs), maxSchedulerStallMs: +lagMax.toFixed(2),
      ticksWithMatches: matchedTicks, alertsFired: firedTotal, claims, pushesAccepted: pushes, deliveryRowsWritten: rowsWritten, acksVerified: acksOk, acksRejected: acksBad, dispatcher: st },
    stagesMs: {
      feedIngest: stat(ingest), matchEvaluation: stat(matchTick), pushDispatch: stat(push), clientAck: stat(ack),
      endToEndTickToPush: stat(e2ePush), endToEndTickToAck: stat(e2e),
    },
    notes: [
      'Loopback only: feed, Supabase, push service and device are local stand-ins in one process. Real network, push-service and device time are NOT included.',
      'feedIngest = generator send → parsed by the consumer (socket + JSON.parse + event-loop wait). matchEvaluation = one RuleIndex.onTick call per tick. pushDispatch = enqueue → push service accepted (claim, device lookup, quiet-hours lookup, send). clientAck = push accepted → ACK received and HMAC-verified.',
      'Cooldown is 1 minute, so each rule fires at most once per run; percentiles over alerts use that many samples (see n).',
    ],
  };
  const row = (name: string, s: Stat) => `${name.padEnd(26)} n=${String(s.n).padStart(6)}  p50 ${f(s.p50).padStart(8)}  p95 ${f(s.p95).padStart(8)}  p99 ${f(s.p99).padStart(8)}  max ${f(s.max).padStart(8)}  (ms)`;
  console.log(`\nticks processed ${received}/${sent} at ${result.run.achievedTicksPerSecond}/s · alerts fired ${firedTotal} · pushes ${pushes} · rows ${rowsWritten} · ACKs ${acksOk} ok / ${acksBad} rejected · max scheduler stall ${result.run.maxSchedulerStallMs} ms\n`);
  for (const [k, v] of Object.entries(result.stagesMs)) console.log(row(k, v));
  console.log('\nloopback software pipeline only — see notes in the JSON output');
  if (OUT) { writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n'); console.log(`wrote ${OUT}`); }

  client.close(); wss.close(); supabase.close(); pushSvc.close(); ackSvc.close();
  supabase.closeAllConnections?.(); pushSvc.closeAllConnections?.(); ackSvc.closeAllConnections?.();
  process.exit(received === sent && acksBad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
