# Week 8 · P0 — governance foundation
Data source is unchanged: SmartAPI stream in the browser, Yahoo/last-close fallback.

**Setup**: run `docs/PERSISTENCE_SCHEMA.sql`, then `docs/ENTERPRISE_SCHEMA.sql` (re-runnable). First admin: `insert into user_roles(user_id, role) values ('<uuid>', 'admin');` — everyone else defaults to `analyst`.
**Env**: `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` (worker); optional `UPSTASH_REDIS_REST_URL/TOKEN`. `vercel.json` calls `/api/worker/alerts` every 5 min (Hobby plan: use an external scheduler).
**Tests**: `npm test` · `./scripts/rls-test.sh` (69 assertions on a real throw-away PostgreSQL).

| Area | Where |
|---|---|
| Roles viewer<analyst<risk<compliance<admin | `user_roles`, `has_role()`, `lib/rbac.ts` |
| Hash-chained append-only audit log | `audit_log`, `audit_verify()`, Compliance → Audit trail |
| Circuit surveillance register + review workflow | `circuit_events`, `review_circuit_event()`, Compliance → Register |
| Server-side alert rules + worker | `alert_rules`, `claim_alert_rule()`, `/api/worker/alerts`, Compliance → Alert rules |
| Distributed rate limits | `allowAsync` (`lib/ttlCache.ts`) |
| Legal pages / consent | `/legal/{privacy,terms,data-sources,disclaimer}` (templates — counsel review required) |

**Honest limits**: single-organisation register (no tenant isolation); the worker uses delayed server quotes (no SmartAPI socket server-side); the audit chain detects tampering but is not a substitute for off-site backups; legal text is not legal advice.
