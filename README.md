# UpCircuit — Real-Time Stock Market Analytics & Surveillance Platform for Indian Equities

**M.Sc. Data Science Capstone Project · Chanakya University**
Rishav Singh & Pratima Bastola

| | |
|---|---|
| Web app | https://upcircuit.vercel.app |
| Alert daemon | https://upcircuit-daemon.onrender.com (`/health`, `/healthz`) |

UpCircuit streams NSE equity data, charts it, and watches it. A Next.js terminal serves retail traders, analysts and risk/compliance staff; a separate always-on daemon evaluates alert rules against the live tick stream and pushes to closed-app phones. Everything shown is either live data or labelled **N/A** — values are never invented.

> **Not investment advice.** Heuristic flags, AI output and backtest numbers are screening aids. See [Compliance & limits](#compliance--limits).

---

## Architecture

```
 Angel One SmartAPI WebSocket (binary) ──► Next.js 14 app (Vercel)  ──► Supabase (Auth · Postgres + RLS · Realtime)
        │  Yahoo Finance fallback            Terminal · Discovery Hub · Compliance        ▲   ▲
        │                                                                                │   │ Realtime (alert_rules) + 5-min resync
        └──────────────► Alert daemon (Docker, Render) ── claim_alert_rule ──────────────┘   │
                          rule engine · lease HA · quiet hours                               │
                          │                                                                  │
                          ├─► Web Push (VAPID) ─► desktop / Android / iOS PWA ─► Service Worker ACK ─► /api/alerts/ack
                          └─► Resend e-mail
```

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS, TradingView **Lightweight Charts** |
| Data & auth | Supabase — Auth, PostgreSQL, Row-Level Security, Realtime |
| Live market data | Angel One **SmartAPI** WebSocket binary stream; Yahoo Finance fallback |
| Alert daemon | Node/TypeScript (`tsx`), containerised (`daemon/Dockerfile`), deployed on Render |
| Notifications | PWA (`app/manifest.ts` + `public/manifest.json`), multi-device VAPID Web Push, Service Worker ACK tracking, Resend transactional e-mail |
| Client libs | `jspdf`, `pdfjs-dist`, `tesseract.js`, `vader-sentiment`, `lucide-react`, `next-themes` |

## Key features

### Surveillance Desk (Compliance workspace)
- **Feed Health** monitor — feed state, last-tick age, daemon heartbeat (ages use the database clock, so browser skew cannot fake "stale").
- **Order Book Imbalance gauge** — exponentially level-weighted top-5 depth, `w_i = e^(−λ(i−1))`, λ = 0.5 (`lib/depthImbalance.ts`). Display only; alert rules use the raw ratio.
- **Intraday volume baseline** — 25 buckets of 15 minutes, median cumulative curve over completed sessions (≥ 10 required, 2 % floor, full-day fallback) (`lib/volumeBaseline.ts`).
- **Resting-order wall** and **rapid add/cancel** flags, always labelled *Heuristic Flag / Possible Manipulation Pattern* (enforced by a DB `CHECK`).
- **Heuristic backtest card** — deterministic run over 539,972 synthetic snapshots: 13.3 % precision, 100.0 % `spoof_wall` recall, 95.2 % `flicker` recall (`public/backtest-heuristics.json`). Labels come from the generator, so these figures describe the assumed noise model, **not** real-market manipulation.
- **Live Alert Deliveries** latency log: tick → daemon match → push accepted → service-worker ACK → displayed.
- Circuit-breaker register with audit hash chain, review workflow and RBAC (viewer / analyst / risk / compliance / admin).

### High-availability alert daemon (`daemon/`)
- **PostgreSQL lease election** — one leader, others stand by with a warm rule index (`daemon/lease.ts`, `acquire_daemon_lease`, DB-clock TTL, monotonic fencing `epoch`).
- SmartAPI ingestion → in-memory rule index → **rising-edge** crossing with cooldown; `claim_alert_rule(rule, window)` makes dispatch idempotent across daemons and the cron backstop.
- Rule kinds: `price_above/below`, `pct_up/down`, `circuit_proximity`, `volume_surge`, `order_imbalance_above/below`.
- **Timezone-aware quiet hours** (`user_quiet_hours`, IANA zone).
- **Multi-device fan-out** — VAPID Web Push to every registered desktop/Android/iOS-PWA device, plus Resend e-mail.

### Terminal & Discovery Hub (cross-device)
- Candlestick chart defaulting to **1D**; timeframes and indicators (EMA20, EMA50, VWAP, RSI) synced through Supabase (`preferences.ui`, newest-write-wins; defaults never overwrite saved choices).
- Persistent **MY FOCUS** basket (local + account, loaded before any starter seeding).
- Persona dashboards: **Retail Investor, Day Trader, Institutional Analyst, Executive / Risk Manager**.
- Portfolio import by **OCR / PDF / CSV**; watchlists, price alerts, PDF export.
- **Ask UpCircuit** AI copilot (Gemini) with human sign-off trail.
- Settings → *Cloud & Data* shows sync status and last-saved time; *Alert Channels* lists devices with Remove and a mobile setup guide.

### Compliance & limits
- Mandatory **SEBI risk / self-responsibility disclosure** modal on every fresh session or login (`components/RegulatoryDisclosureModal.tsx`, `lib/disclosure.ts`); acknowledgement timestamp stored in auth user metadata as an audit trail.
- Heuristic flags are never proof; the backtest is synthetic; AI output requires explicit sign-off (`ai_signoffs`).
- DPDP Act 2023 helpers: `export_my_data()`, `delete_my_data()` (+ `/api/account/delete`).

---

## Repository map

| Path | Contents |
|---|---|
| `app/` | Routes (`/`, `/terminal`, `/login`, `/settings`, `/status`, `/legal`), `app/api/*` (alerts, quotes, bars, market, copilot, ask, worker …), `manifest.ts` |
| `components/` | UI; `dashboards/` (personas, Surveillance workspace), `settings/` |
| `lib/` | Engines and shared logic (alerts, depth imbalance, volume baseline, cloud sync, disclosure …) |
| `daemon/` | Alert daemon: `index.ts`, `engine.ts`, `dispatcher.ts`, `lease.ts`, `baselines.ts`, `Dockerfile` |
| `scripts/` | Verification, RLS test, backtest, benchmark, instrument sync, daemon smoke test |
| `tests/` | `week10.test.ts`, `fixes.test.ts`, `week11.test.ts` (node:test) |
| `docs/` | Runbook, deployment, threat model, daemon notes, per-week SQL history |
| `schema.sql` | **Consolidated, idempotent production schema** (use this for new projects) |
| `public/` | `manifest.json`, icons, `sw.js`, `backtest-heuristics.json` |

---

## Setup

Requires Node 20+ (the daemon image uses Node 22) and a Supabase project.

```bash
git clone https://github.com/srishav1000-cyber/UpCircuit.git && cd UpCircuit
npm i
cp .env.example .env.local        # fill in values — never commit real keys
npm run sync:instruments          # download the NSE/Angel instrument master
npm run dev                       # http://localhost:3000
```

### Database
Open the Supabase SQL editor and run **`schema.sql`** once. It is idempotent (safe to re-run) and includes tables, indexes, RLS policies, grants, `SECURITY DEFINER` RPCs, the final function privilege allow-list and the Realtime publication for `alert_rules`. It supersedes the files in `docs/*.sql`, which are kept as history. To make yourself the first admin, follow the bootstrap comment at the top of `schema.sql`.

### Environment variables
Names only — see `.env.example` for comments. Server-only secrets must never use the `NEXT_PUBLIC_` prefix.

| Group | Variables |
|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `NEXT_PUBLIC_AUTH_REQUIRED`, `NEXT_PUBLIC_APP_URL` |
| SmartAPI | `SMARTAPI_API_KEY`, `SMARTAPI_CLIENT_CODE`, `SMARTAPI_PASSWORD`, `SMARTAPI_TOTP_SECRET`, `NEXT_PUBLIC_SMARTAPI_API_KEY`, `SMARTAPI_SESSION_PUBLIC` |
| Web Push | `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_ENDPOINT_ALLOW`, `ALERT_ACK_SECRET` |
| E-mail | `RESEND_API_KEY`, `EMAIL_FROM` |
| AI / news | `GEMINI_API_KEY`, `GEMINI_MODEL`, `NEWS_RSS_URLS` |
| Instruments | `ANGEL_SCRIP_MASTER_URL`, `NSE_EQUITY_CSV_URL` |
| Ops | `CRON_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SENTRY_DSN`, `LOG_LEVEL`, `CSP_CONNECT_EXTRA` |
| Daemon | `PORT` (default 10000), `DAEMON_HA`, `DAEMON_LEASE_NAME`, `DAEMON_LEASE_TTL_S`, `DAEMON_LEASE_RENEW_MS`, `DAEMON_RESYNC_MS`, `DAEMON_STALL_MS`, `DAEMON_MAX_BACKOFF_MS` |

`ALERT_ACK_SECRET` must be identical on Vercel and the daemon (otherwise it is derived from `VAPID_PRIVATE_KEY`, which must then match).

### Alert daemon (Docker)
Build from the repo root; supply configuration at run time, not in the image.

```bash
docker build -f daemon/Dockerfile -t upcircuit-daemon .
docker run -d --name upcircuit-daemon -p 10000:10000 --env-file .env.daemon upcircuit-daemon
curl http://localhost:10000/health      # liveness (always 200)
curl http://localhost:10000/healthz     # readiness / diagnostics (503 if the leader's feed is silent in market hours)
```
Without Docker: `npm run daemon`. On Render, deploy as a Docker web service from `daemon/Dockerfile`. Run two instances for HA — the lease keeps one active. Details: `docs/WEEK9_DAEMON.md`, `docs/RUNBOOK.md`.

## Week 11 capstone

- **Multi-signal confirmation.** `confirmed_composite` mode keeps a spoof-wall / flicker candidate only if ≥ 2 of 3 agree: |OBI_λ| ≥ 0.35, 15-min volume surge R(t) ≥ 1.8, spread ≥ 1.5× its rolling median. Flags are tagged `Baseline Flag` or `Multi-Signal Confirmed`. `npx tsx scripts/backtest-heuristics.ts --out public/backtest-heuristics.json` regenerates the baseline-vs-composite comparison and the 5×4×4 sweep (synthetic data, no look-ahead; the volume↔episode link is an assumption, shown with sensitivity runs).
- **Threshold & Sensitivity Explorer** and **Slippage / Circuit-Lock Exit Risk** card in the Surveillance Desk (Day Trader too); N/A when the market is closed or no 5-level depth.
- **Surveillance Audit Pack.** Button in the Surveillance Desk downloads `upcircuit-surveillance-audit-<YYYY-MM-DD>.json` (SHA-256 sealed, secrets redacted) and opens a printable report. It is a white-box record of rules and readings, not investment advice and not a statement of regulatory compliance.
- Optional: `DEPTH_CONFIRM=1` on the daemon stores `depth_flags.confirmed_by`; apply `docs/WEEK11_CAPSTONE_SCHEMA.sql` (or the root `schema.sql`) first.

## Final Defense Demo Guide (Market Open vs. After-Hours Replay)

Every feature can be verified at any hour; the table says what each one shows live (09:15–15:30 IST, Mon–Fri) and what it shows otherwise. Nothing below needs a paid service.

| Feature (Surveillance Desk unless stated) | Market open | After hours / weekend |
|---|---|---|
| **Daily Market Surveillance Digest** | This session's peak R(t), OBI, circuit touches, flags, plus the day's persisted circuit register / daemon flags | Same data if any was persisted; otherwise the labelled **REPLAY** digest. "Show replay digest" forces it |
| **Alert & rule sandbox → "Simulate Live Market Burst"** | Works identically (own private state, never touches live quotes or stored records) | Same — press it, pick RELIANCE / TCS / INFY, watch R(t), the OBI gauge, `Baseline Flag` vs `Multi-Signal Confirmed`, and the *simulated* push + chime |
| **Holdings Surveillance & Liquidity Risk** (Retail lens; Executive and Institutional lenses via the risk engine) | Holdings + MY FOCUS vs flags (30 min), circuit proximity ≤ 2 %, visible exit depth for the stock being viewed | Circuit proximity from the last quotes; exit depth and flags show N/A rather than guesses |
| **Slippage & circuit-lock exit risk** | VWAP fill over live 5-level depth | N/A with the reason |
| **Threshold & Sensitivity Explorer**, backtest | Same (precomputed `public/backtest-heuristics.json`) | Same |
| **Export Surveillance Audit Pack** | JSON (SHA-256 sealed) + printable report incl. the digest | Same; depth-derived fields N/A |

**3-minute walkthrough.** (1) Open the Surveillance Desk → *Simulate Live Market Burst* at 4× speed. At ≈ 5 min of replay time R(t) becomes available; at 8 min TCS shows a **Baseline** wall (OBI only, normal volume — suppressed); at 10 min RELIANCE shows a **Multi-Signal Confirmed** wall (OBI + volume) and a simulated push; at 21 min INFY touches the upper circuit. (2) Scroll to the Digest — the same events are summarised with the suppression ratio. (3) Open Retail → the holdings badge. (4) *Export Surveillance Audit Pack*.

**CLI.** `npm run eod:digest -- --offline` prints the deterministic replay digest; with `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment (never committed) and a date that has persisted data, `npm run eod:digest -- --date 2026-11-18 --out digest.json` summarises that day from `market_ticks`, `circuit_events` and `depth_flags`.

**Honest limits.** The replay is synthetic and labelled so everywhere. The suppression ratio is the share of single-rule flags the filter would not alert on — a filtering ratio, not a measured false-positive rate (the labelled figure is the synthetic backtest's). Order-book depth is not persisted, so a past day's digest has no OBI readings (flags that OBI corroborated are still listed). Without a median volume profile, R(t) in the digest uses the session-average pace and says so. The sandbox's "push" is a local chime and an on-screen row; nothing is sent to any device. Heuristic flags are patterns in resting orders, not proof of manipulation, and nothing here is investment advice.

## Verification

```bash
npm test                              # verify.ts + verify-auth.ts + tests/week10 · fixes · week11
npm run typecheck                     # tsc --noEmit
npx tsx scripts/backtest-heuristics.ts   # regenerate the synthetic heuristic backtest
npm run daemon:smoke                  # daemon vs local mock feed / Supabase / push service
bash scripts/rls-test.sh              # RLS + RPC assertions on a throw-away local PostgreSQL (needs server binaries)
RLS_SCHEMA_MODE=consolidated bash scripts/rls-test.sh   # same assertions against schema.sql, applied twice
npm run build                         # production build
```
Benchmarks (`npm run bench`) and the daemon smoke test use local mocks; they do not measure real SmartAPI or push-service latency.

## License & disclaimer
Academic capstone project. Market data is provided as-is and may be delayed or unavailable; nothing here is a recommendation to buy or sell any security.
