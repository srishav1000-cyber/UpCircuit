# Scale-out path: Postgres event log → Kafka

**What exists today (tested):** `event_log` in Postgres with Kafka semantics — topic, monotonically increasing `offset`, key (symbol), per-consumer committed offsets (`consumer_offsets`), `event_poll / event_commit / event_reset / event_lag`. A trigger publishes every `circuit_events` insert to topic `circuit.detected`. The `circuit-stats` consumer folds events into `circuit_daily_stats` **exactly-once** (fold + offset commit in one transaction) and can be rebuilt with `replay_circuit_stats()`. `/api/worker/events` (cron, every 10 min) drives it. SQL assertions: `scripts/rls_test.sql`.

**What is optional and NOT verified here:** `deploy/docker-compose.kafka.yml` + `scripts/kafka-demo.mjs` (relays `event_poll` into a Kafka topic keyed by symbol, then replays through a consumer group). It was written but never run — the build sandbox has no Docker daemon. Run it yourself: `docker compose -f deploy/docker-compose.kafka.yml up -d`, `npm i --no-save kafkajs`, `node scripts/kafka-demo.mjs`.

## Concept mapping
| Kafka | UpCircuit |
|---|---|
| topic | `event_log.topic` (`circuit.detected`) |
| partition key | `key` = symbol (per-symbol ordering is what matters) |
| offset | `event_log."offset"` (global identity; per-topic ordering by offset) |
| consumer group | `consumer_offsets.consumer` |
| commit | `event_commit` (monotonic, `greatest`) |
| seek / replay | `event_reset`, `replay_circuit_stats` |
| lag | `event_lag` |

## When to move to Kafka
Stay on Postgres until one of: sustained > ~1–2k events/s into the log; > 3 independent consumers needing different read speeds; fan-out to other systems (warehouse, ML features); or retention/replay needs beyond what a pruned table gives. Below that, Postgres is simpler (one system, transactional with the source row, RLS and backups for free).

## Migration steps
1. Keep the trigger as the single producer; add a relay (the demo script) that publishes `event_poll('kafka-relay', …)` batches and commits only after the broker ack (at-least-once).
2. Consumers dedupe on `(topic, offset)` (carried in the payload headers) → effectively exactly-once.
3. Move consumers one at a time; compare `circuit_daily_stats` with the replay result before cutting over.
4. Only then stop writing the Postgres consumer; keep `event_log` as the outbox.
