# Threat model (STRIDE) — UpCircuit

Scope: browser app (Next.js), API routes, Supabase (Postgres + Auth + RLS), SmartAPI (market data), Yahoo fallback, Upstash rate limiting, Resend/Web-Push, AI providers. This is a design-time review, not a penetration test.

| # | Threat | Where | Mitigation in code | Residual / next |
|---|---|---|---|---|
| S1 | Spoofed user / stolen JWT | API routes, REST | Supabase Auth JWT verified server-side; RLS on every table; MFA-ready via TOTP in Supabase | No device binding; session theft via XSS → CSP (T-XSS) |
| S2 | Spoofed cron caller | `/api/worker/*` | `CRON_SECRET` bearer, constant-time compare, 401 otherwise | Rotate secret per RUNBOOK |
| T1 | Tampering with audit trail | `audit_log` | Append-only (no update/delete grants), hash chain (`audit_hash`), drill recomputes the chain after restore | DB superuser could rewrite; export head hash externally |
| T2 | Tampering with circuit register | `circuit_events` | Writes only via security-definer RPCs; review needs `risk`+ role | — |
| T3 | Client-side role escalation | UI | UI gating is cosmetic; roles enforced by `has_role` in RLS/RPC (tested in `rls_test.sql`, 104 assertions) | — |
| R1 | Repudiation of reviews/sign-offs | register, AI sign-offs | Actor, role, timestamp and hash in audit log | Clock = DB clock |
| I1 | Secret leakage | env, UI, logs | Keys never accepted in UI; service key server-only; `redact()` in logs; Sentry envelope scrubbed | Review third-party scripts |
| I2 | Cross-tenant data read | Postgres | RLS per `auth.uid()`; backup drill checks user sees only own rows after restore | Service-role code paths need review each release |
| I3 | PII in AI prompts | copilot | Only symbols/prices/user-entered text; sign-off logs SHA-256 of output and data classes used | Provider retention is outside our control |
| I4 | DPDP: export/erasure | `/api/account/delete`, `export_my_data` | Implemented and e2e tested | Legal review of retention periods |
| D1 | API abuse / scraping | all routes | Per-IP limiter (Upstash, memory fallback), plan-based AI quotas, alert-rule cap trigger | Memory fallback is per-instance |
| D2 | Upstream outage | SmartAPI/Yahoo | Fallback chain, N/A instead of invented values, `/status` page | Single data vendor primary |
| D3 | Poison event / runaway consumer | event log | Payload ≤ 8 KB, topic regex, batch cap, loop cap 20 rounds | — |
| E1 | XSS | UI | React escaping, strict CSP (no foreign scripts, no framing, no objects), HTML-escaped emails, sanitised names (layouts) | `style-src` inline allowance (Next) |
| E2 | Open redirect / email-link poisoning | auth, emails | All via `lib/appUrl.ts`, allow-listed origin | — |
| E3 | Supply chain | npm | Lockfile, CI audit step | Add Dependabot / provenance |
| E4 | Misleading signals (model risk) | predictions | Methodology page, back-test with baseline + caveats, AI sign-off | Not investment advice; SEBI position in legal pages |
