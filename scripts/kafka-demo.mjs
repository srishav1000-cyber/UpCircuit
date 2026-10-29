// OPTIONAL: relays the PostgreSQL event log to a real Kafka topic and consumes it back (producer → topic → consumer group → replay from offset 0).
// Needs: docker compose -f deploy/docker-compose.kafka.yml up -d · npm i --no-save kafkajs · SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// NOT run in this repo's CI or in the turn-39 verification (no Docker daemon was available) — treat as a starting point.
import { Kafka } from 'kafkajs';
const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, KAFKA_BROKER = 'localhost:9092' } = process.env;
if (!url || !key) throw new Error('set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
const rpc = async (fn, body) => (await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const kafka = new Kafka({ clientId: 'upcircuit-demo', brokers: [KAFKA_BROKER] });
const producer = kafka.producer(); await producer.connect();
// producer: drain the Postgres log (consumer group "kafka-relay") into Kafka, keyed by symbol so one stock stays ordered in one partition
const rows = await rpc('event_poll', { p_consumer: 'kafka-relay', p_topic: 'circuit.detected', p_max: 500 });
if (rows.length) {
  await producer.send({ topic: 'circuit.detected', messages: rows.map((r) => ({ key: r.key, value: JSON.stringify({ offset: r.offset, ...r.payload }) })) });
  await rpc('event_commit', { p_consumer: 'kafka-relay', p_topic: 'circuit.detected', p_offset: rows[rows.length - 1].offset });
}
console.log(`relayed ${rows.length} events`);
await producer.disconnect();
// consumer group: replay from the beginning, count per direction
const consumer = kafka.consumer({ groupId: `demo-${Date.now()}` }); await consumer.connect();
await consumer.subscribe({ topic: 'circuit.detected', fromBeginning: true });
const counts = {}; let seen = 0;
await consumer.run({ eachMessage: async ({ message }) => { const e = JSON.parse(message.value.toString()); counts[e.direction] = (counts[e.direction] || 0) + 1; if (++seen >= rows.length) { console.log('replayed counts', counts); await consumer.disconnect(); process.exit(0); } } });
setTimeout(() => { console.log('timeout; counts so far', counts); process.exit(0); }, 15000);
