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
- Drill (monthly, and in CI): `./scripts/backup-drill.sh` — builds a scratch cluster, seeds, `pg_dump -Fc`, `pg_restore`, then compares row counts, audit head hash, chain validity and RLS isolation. Exit code ≠ 0 means the drill failed.
- Real restore: restore to a new Supabase project/branch, run the fingerprint SQL from the script against both, switch `NEXT_PUBLIC_SUPABASE_URL`.

## Release checklist
`npm test` · `npx tsc --noEmit` · `npx next lint` · `./scripts/rls-test.sh` · `./scripts/backup-drill.sh` · `node scripts/a11y.cjs` · build.
