# Week 8 · P1 — hardening, entitlements, risk & governance
Run `docs/ENTERPRISE_SCHEMA_P1.sql` after the P0 schema (re-runnable). Data source unchanged (SmartAPI-primary).

| Area | What shipped |
|---|---|
| CI | `.github/workflows/ci.yml`: tsc · lint · tests · build · `npm audit` · PostgreSQL RLS job |
| Security headers | `next.config.mjs`: CSP (SmartAPI socket + Supabase allow-list; `script-src 'unsafe-inline'` because Next inlines bootstrap scripts — nonce CSP is P2), HSTS, X-Frame-Options, nosniff, Referrer/Permissions-Policy, COOP |
| Logging / errors | `lib/log.ts` JSON lines with secret redaction; `captureException` → Sentry envelope when `SENTRY_DSN` is set (no SDK); `/api/client-error` + `app/error.tsx` |
| Load test | `node scripts/loadtest.mjs <url> <secs> <concurrency>` — local run: 375 req/s, 0 errors, p95 ≤ 116 ms (read endpoints) |
| Status | `/status` page + `/api/health` |
| Entitlements | day / retail / full table in `lib/entitlements-shared.ts`; AI quota per plan enforced in `/api/ask` + `/api/copilot` (anonymous: 6/h); alert-rule cap per plan enforced **in the database**; daily risk report is Full-only |
| Risk | limits sync to the account (`preferences.risk_limits`), each new breach → audit trail, optional daily e-mail report (`/api/worker/risk-report`, weekdays 09:00 IST) with limits + 6 stress scenarios |
| Governance | model · prompt version · data used · SHA-256 of the exact text · human approve / reject (note required) → `ai_signoffs` + audit; Compliance → AI sign-offs |
| Audit export | CSV (P0) + PDF |
| DPDP | Settings → Cloud & Data → download all my data (JSON) / delete my account (`/api/account/delete`, needs `SUPABASE_SERVICE_ROLE_KEY`) |

**Env added**: `SENTRY_DSN`, `LOG_LEVEL`, `CSP_CONNECT_EXTRA`. **Tests**: `npm test` (160) · `./scripts/rls-test.sh` (87).

**Honest limits**: the stress scenarios use illustrative sector betas, not estimated ones; the scheduled risk report has no circuit-exposure row (needs live bands); the CSP still allows inline scripts; Sentry reporting is a minimal envelope POST (no source maps / breadcrumbs); the load test ran locally against mocks, not production infrastructure; erased users' audit rows are retained (de-linked from a person only once the auth user is deleted).
