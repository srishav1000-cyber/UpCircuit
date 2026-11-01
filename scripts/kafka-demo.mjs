// Kafka demo: SIMULATED SmartAPI-style ticks → topic `market-ticks` → consumer that updates VWAP / EMA / RSI and runs circuit-breaker proximity checks.
// The prices are generated here (clearly simulated); nothing is real market data. The app itself does not use Kafka.
//
//   docker compose -f deploy/docker-compose.kafka.yml up -d
//   npm i --no-save kafkajs
//   node scripts/kafka-demo.mjs                       # TICKS=50000 SYMBOLS=25 KAFKA_BROKER=localhost:9092 optional
//   docker compose -f deploy/docker-compose.kafka.yml down -v
//
//   node scripts/kafka-demo.mjs --dry-run             # same producer/consumer code on an in-memory bus: no Docker, no kafkajs
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const TOPIC = 'market-ticks', DRY = process.argv.includes('--dry-run');
const TICKS = Number(process.env.TICKS ?? 50000), NSYM = Number(process.env.SYMBOLS ?? 25), BROKER = process.env.KAFKA_BROKER ?? 'localhost:9092';
const BANDS = [5, 10, 20], NEAR_PCT = 1.5; // same bands / 1.5 % proximity as the terminal

// ── simulated SmartAPI tick stream (deterministic LCG so runs are comparable) ─────────────────────────────────────────────────────────────
let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const symbols = Array.from({ length: NSYM }, (_, i) => ({ s: `SIM${String(i + 1).padStart(2, '0')}`, prev: 100 + i * 37, px: 100 + i * 37, band: BANDS[i % 3], drift: 0 }));
const nextTick = (i) => {
  const y = symbols[i % NSYM]; if (y.s === 'SIM01' && i > TICKS * 0.6) y.drift = 0.0009; // SIM01 trends toward its upper limit late in the run
  y.px = Math.max(1, y.px * (1 + (rnd() - 0.5) * 0.002 + y.drift));
  const limit = y.prev * (1 + y.band / 100); if (y.px > limit) y.px = limit;
  return { s: y.s, ltp: +y.px.toFixed(2), vol: 1 + Math.floor(rnd() * 500), prevClose: y.prev, band: y.band, ts: Date.now() };
};

// ── indicators (incremental, O(1) per tick) ───────────────────────────────────────────────────────────────────────────────────────────────
const state = new Map();
const st = (s) => state.get(s) ?? (state.set(s, { n: 0, pv: 0, v: 0, e9: null, e21: null, last: null, ag: 0, al: 0, flagged: false }).get(s));
const ema = (prev, x, n) => (prev === null ? x : prev + (2 / (n + 1)) * (x - prev));
function update(t, alerts) {
  const a = st(t.s); a.n++; a.pv += t.ltp * t.vol; a.v += t.vol; a.e9 = ema(a.e9, t.ltp, 9); a.e21 = ema(a.e21, t.ltp, 21);
  if (a.last !== null) { const d = t.ltp - a.last, g = Math.max(d, 0), l = Math.max(-d, 0), k = 1 / 14; a.ag = a.n <= 15 ? a.ag + g / 14 : a.ag * (1 - k) + g * k; a.al = a.n <= 15 ? a.al + l / 14 : a.al * (1 - k) + l * k; } // Wilder smoothing
  a.last = t.ltp; a.vwap = a.pv / a.v; a.rsi = a.n < 15 ? null : a.al === 0 ? 100 : 100 - 100 / (1 + a.ag / a.al);
  const move = ((t.ltp / t.prevClose - 1) * 100), lim = Math.sign(move || 1) * t.band, prox = Math.abs(lim) - Math.abs(move); // % below the limit
  if (!a.flagged && prox <= NEAR_PCT && Math.abs(move) > 0) { a.flagged = true; alerts.push({ s: t.s, move: +move.toFixed(2), band: t.band, side: move >= 0 ? 'UPPER' : 'LOWER', at: a.n }); }
}

// ── transport: Kafka (kafkajs) or the in-memory stand-in with the same send / batch semantics ─────────────────────────────────────────────
async function connect() {
  if (DRY) {
    const q = []; let handler = null;
    return { mode: 'in-memory (dry-run)', send: async (msgs) => { q.push(...msgs); if (handler) { const b = q.splice(0); await handler(b); } }, onBatch: async (h) => { handler = h; }, close: async () => {} };
  }
  let Kafka; try { ({ Kafka } = await import('kafkajs')); } catch { console.error('kafkajs missing: run  npm i --no-save kafkajs'); process.exit(2); }
  const kafka = new Kafka({ clientId: 'upcircuit-demo', brokers: [BROKER], retry: { retries: 8 } });
  const admin = kafka.admin(); await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: [{ topic: TOPIC, numPartitions: 3, replicationFactor: 1 }] }); await admin.disconnect(); // no-op if init-topics already made it
  const producer = kafka.producer({ allowAutoTopicCreation: false }); await producer.connect();
  const consumer = kafka.consumer({ groupId: `ticks-${randomUUID().slice(0, 8)}`, maxWaitTimeInMs: 50 }); await consumer.connect(); await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  return {
    mode: `Kafka @ ${BROKER}`,
    send: (msgs) => producer.send({ topic: TOPIC, acks: 1, messages: msgs.map((m) => ({ key: m.key, value: m.value })) }),
    onBatch: (h) => consumer.run({ eachBatchAutoResolve: true, eachBatch: async ({ batch, heartbeat, resolveOffset }) => { await h(batch.messages.map((m) => ({ key: m.key.toString(), value: m.value.toString() })), heartbeat); for (const m of batch.messages) resolveOffset(m.offset); } }),
    close: async () => { await consumer.disconnect(); await producer.disconnect(); },
  };
}

(async () => {
  const bus = await connect(), alerts = []; let consumed = 0, resolveDone; const done = new Promise((r) => (resolveDone = r));
  const lag = monitorEventLoopDelay({ resolution: 5 }); lag.enable();
  // consumer: processes in slices and yields to the event loop (setImmediate) so indicator math never starves timers / I/O
  await bus.onBatch(async (msgs, heartbeat) => {
    for (let i = 0; i < msgs.length; i++) { update(JSON.parse(msgs[i].value), alerts); consumed++; if (i % 500 === 499) { await new Promise((r) => setImmediate(r)); await heartbeat?.(); } }
    if (consumed >= TICKS) resolveDone();
  });
  console.log(`transport: ${bus.mode} · ${TICKS} SIMULATED ticks · ${NSYM} symbols · topic ${TOPIC}`);
  const t0 = performance.now(); let sent = 0;
  while (sent < TICKS) { // producer: batches of 500, keyed by symbol (same symbol → same partition → ordered)
    const n = Math.min(500, TICKS - sent), msgs = []; for (let i = 0; i < n; i++) { const t = nextTick(sent + i); msgs.push({ key: t.s, value: JSON.stringify(t) }); }
    await bus.send(msgs); sent += n; await new Promise((r) => setImmediate(r));
  }
  const tp = performance.now(); console.log(`produced ${sent} in ${((tp - t0) / 1000).toFixed(2)}s (${Math.round(sent / ((tp - t0) / 1000))}/s)`);
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: consumed ${consumed}/${TICKS}`)), 60000))]);
  const dt = (performance.now() - t0) / 1000; lag.disable();
  console.log(`consumed ${consumed} in ${dt.toFixed(2)}s end-to-end (${Math.round(consumed / dt)}/s) · event-loop delay p99 ${(lag.percentile(99) / 1e6).toFixed(1)} ms, max ${(lag.max / 1e6).toFixed(1)} ms`);
  for (const s of ['SIM01', 'SIM02']) { const a = state.get(s); console.log(`${s}: n=${a.n} last=${a.last} VWAP=${a.vwap.toFixed(2)} EMA9=${a.e9.toFixed(2)} EMA21=${a.e21.toFixed(2)} RSI14=${a.rsi?.toFixed(1) ?? 'n/a'}`); }
  console.log(alerts.length ? `circuit proximity alerts (within ${NEAR_PCT}% of band):` : 'no circuit proximity alerts', alerts);
  await bus.close(); process.exit(consumed === TICKS ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
