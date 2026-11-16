# Runbook

**Objectives (self-assessed, drill-backed):** RPO = Supabase PITR window (plan-dependent; daily backup on free). RTO target < 1 h. The logical dump/restore drill on a 2 000-portfolio dataset takes < 1 s; real data will be larger — re-measure.

## Health
- `GET /api/health` (liveness + dependency checks), `/status` page. Failing: check Supabase status, then SmartAPI session, then Yahoo fallback. The UI shows N/A, never invented values.

## Incidents
| Symptom | First check | Action |
|---|---|---|
| No live ticks | `/status` → SmartAPI | Re-login; market hours (IST 09:15–15:30); fallback delayed data is labelled |
| Alerts not firing | Vercel cron logs `/api/worker/alerts` | Verify `CRON_SECRET`; run worker manually with the bearer |
| Circuit stats stale | `/api/worker/events` response `lag` | Run manually; `select * from event_lag('circuit-stats','circuit.detected')`; if corrupt → `select replay_circuit_stats()` |
| Audit chain mismatch | `backup-drill.sh` chain recompute query | Freeze writes, compare against last exported head hash, escalate |
| 429 storm | Upstash dashboard | Check bot traffic; tighten limiter |
| AI errors/quota | provider status | Quotas are server-side per plan |

## Rollback
Vercel → Deployments → promote previous build. Schema migrations are additive (`docs/ENTERPRISE_SCHEMA*.sql`, idempotent); no destructive down-migrations — restore from backup if needed.

## Secrets rotation
`CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, SmartAPI keys, Resend, VAPID, Sentry DSN: change in Vercel env, redeploy, verify `/api/health` and one cron run. Never paste keys in the UI.

## Backup / restore
- Automated: Supabase backups/PITR.
- Drill (monthly, and in CI against postgres:15): `./scripts/backup-drill.sh` — seeds, `pg_dump -Fc`, drops the database, `pg_restore`s into a fresh one, then compares row counts, audit head hash, chain validity and RLS isolation. Exit code ≠ 0 means the drill failed.
- Real restore: restore to a new Supabase project/branch, run the fingerprint SQL from the script against both, switch `NEXT_PUBLIC_SUPABASE_URL`.

## Release checklist
`npm test` · `npx tsc --noEmit` · `npx next lint` · `./scripts/rls-test.sh` · `./scripts/backup-drill.sh` · `node scripts/a11y.cjs` · build.

## Week 10 additions

**Migration order:** … → `WEEK9_TURN44_SCHEMA` → `WEEK10_SCHEMA` (re-runnable). Adds `daemon_leases`, `acquire_daemon_lease()` / `release_daemon_lease()` (service role only) and `volume_baselines.profile`.

**High availability (leader lease).** Run 2+ daemon instances; one holds the `alert-daemon` lease and does SmartAPI/feed/dispatch, the rest stand by with a warm rule index. Lease renews every 10 s, TTL 30 s (crash failover ≤ ~30 s; graceful stop releases at once). The leader stops acting 3 s before its lease can expire. `/healthz` → `ha.{role,leader,epoch,expiresAt}`.

| Env | Default | Meaning |
|---|---|---|
| `DAEMON_HA` | on | `0` = single instance, no lease |
| `DAEMON_LEASE_NAME` | `alert-daemon` | lease key |
| `DAEMON_LEASE_TTL_S` | 30 | must be ≥ 2 × renew |
| `DAEMON_LEASE_RENEW_MS` | 10000 | renew/poll interval |

If `WEEK10_SCHEMA` is not applied (RPC 404) the daemon logs loudly and runs as sole leader.

**volume_surge semantics changed:** the baseline is now the median *cumulative* volume by the current 15-min bucket (last ≤ 20 sessions, ≥ 10 required); it falls back to the full-day median outside 09:15–15:30 IST or without a profile. Alert text states which basis was used.

**Order imbalance:** gauge has Raw / Weighted (w = e^(−0.5·(i−1))). Alert rules still use Raw.

**Backtest:** `npm run backtest` (synthetic, labels come from the generator — precision reflects agreement with that definition and the assumed noise, not real manipulation).
