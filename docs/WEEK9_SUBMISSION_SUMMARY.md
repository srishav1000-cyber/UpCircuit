# UpCircuit — Week 9 Submission Summary

**Project:** UpCircuit real-time stock analytics & surveillance platform · M.Sc. Data Science capstone, Chanakya University
**Week 9 theme:** closed-app, sub-second alerting — a persistent daemon evaluates rules on live SmartAPI ticks and delivers Web Push (VAPID) with a service-worker acknowledgement.
**Scope of this report:** Turns 42–44. Every figure below was produced by the code in this repository; where something was *not* measured it says so.

---

## 1. What was built

| Turn | Deliverable |
|---|---|
| 42 | Alert **daemon** (`daemon/`), **VAPID Web Push dispatcher**, **service-worker ACK** (`public/sw.js`, `/api/alerts/ack`), delivery latency log, Settings "Send Test Push" |
| 43 | **Feed-health** indicator, **volume-surge** and **order-imbalance** rule types, top-5 **depth-imbalance gauge**, rules API, heartbeat + baselines schema |
| 44 | **Surveillance desk**, **heuristic depth flags**, **Quiet Hours** with critical override, **latency benchmark**, this report |

## 2. Architecture

```
SmartAPI WebSocket ──► daemon/index.ts ──► RuleIndex.onTick (daemon/engine.ts)
 (ticks + top-5 depth)    │ heartbeat 5 s       │ price / pct / circuit / volume-surge / depth-imbalance
                          │ → daemon_beat()      │ + DepthFlagTracker (walls, add/cancel)  ──► depth_flags
                          ▼                      ▼
                  Supabase Postgres      Dispatcher (daemon/dispatcher.ts)
                  alert_rules  ◄─Realtime─ claim_alert_rule() → quiet-hours check → VAPID push → alert_deliveries
                                                      │
                                           push service (FCM / APNs / Mozilla)
                                                      ▼
                                      public/sw.js: showNotification → POST /api/alerts/ack (HMAC token)
```

* **Daemon** — a long-running Node process (not a Vercel function). Keeps all enabled rules in memory, indexed by symbol; Supabase Realtime keeps it current, with a full resync on (re)subscribe and every 5 minutes. A rule fires on a **false→true crossing**; the first observation only seeds state, a cooldown swallows repeat crossings, and inputs that are N/A never flip state. Watchdog for stalled feeds, token-expiry recycle, jittered backoff, `/healthz`.
* **Dispatcher** — per match: atomic `claim_alert_rule` (cross-instance de-duplication) in parallel with a cached device lookup and the quiet-hours lookup → web-push fan-out (TTL 300 s, urgency high) → a latency-stamped `alert_deliveries` row. Expired devices (404/410) are pruned. Bounded queue, concurrency 16.
* **Service-worker ACK** — the encrypted push payload carries a per-delivery HMAC token (`lib/ackToken.ts`); after `showNotification` the worker POSTs it back with its local display time (retry on 404/5xx/network). The Delivery log then shows tick→match→push→displayed from real stamps.
* **Rule kinds (8):** `price_above/below`, `pct_up/down`, `circuit_proximity` (also run by the 5-minute cron backstop) and, daemon-only, `volume_surge`, `order_imbalance_above/below`.
  * `volume_surge`: today's cumulative volume ≥ multiple × the median full-day volume of the last ≤ 20 completed sessions; **N/A** below 10 sessions of history. Not time-of-day adjusted.
  * `order_imbalance`: (Σbid − Σask) ÷ (Σbid + Σask) over the best 5 levels; **N/A** for books under 500 shares; 0.05 hysteresis once held.
* **Quiet Hours (Turn 44)** — a per-user daily window in the user's IANA time zone (wraps past midnight, follows DST). Routine alerts inside the window are **held**: nothing is sent, and each channel the rule uses leaves a `skipped` row "held: quiet hours …". Held alerts are *not* replayed afterwards (a stale price alert is worse than none). **`circuit_proximity` bypasses** the window and its row says "quiet-hours override". A failed preference lookup **delivers** (an alert is never lost to a preference problem). The Settings test push ignores Quiet Hours.
* **Heuristic depth flags (Turn 44)** — large resting-order **walls** (≥ 4× the median of the other levels, ≥ 45 % of the side, ≥ 1 000 shares) and **rapid add/cancel** cycles (≥ 3 large orders appearing and vanishing within 5 s inside 30 s). A vanished order is *not* counted when the market traded through its price (a fill) or when it merely dropped out of the visible five levels (displacement). Every flag is labelled **"Heuristic Flag / Possible Manipulation Pattern"**, carries `heuristic: true, definitive: false`, and the database refuses any other label. They are screening hints — not proof of manipulation or intent, and never alert rules.
* **Surveillance desk (Turn 44)** — first tab of the Compliance workspace: feed health, circuit-proximity monitor, volume-surge rule status (with N/A reasons), imbalance gauge, heuristic flags (daemon-recorded plus a browser-side sample of the selected stock) and the live delivery log, on a dark slate canvas with gold/teal accents.

## 3. Database additions

Apply in order: `ENTERPRISE_SCHEMA` → `WEEK9_SCHEMA` → `WEEK9_TURN43_SCHEMA` → `WEEK9_TURN44_SCHEMA` (all re-runnable).

| Migration | Adds |
|---|---|
| `WEEK9_SCHEMA.sql` | latency columns on `alert_deliveries`, Realtime publication on `alert_rules`, `claim_alert_rule(rule, window_key)` |
| `WEEK9_TURN43_SCHEMA.sql` | `alert_rules` kind check (8 kinds) + per-kind threshold bounds, `daemon_heartbeat` + `daemon_beat()` / `daemon_health()`, `volume_baselines` |
| `WEEK9_TURN44_SCHEMA.sql` | `user_quiet_hours` (own-row RLS, no 24-hour window, valid time zone only), `depth_flags` (read-only for users, heuristic label enforced) |

## 4. Test coverage

Run on the final tree of this submission:

| Suite | Command | Result |
|---|---|---|
| Unit / integration | `npm test` | **186 checks pass** (+ 5 auth/plan/focus) |
| Database (PostgreSQL 16, RLS, constraints, RPC auth) | `bash scripts/rls-test.sh` | **158 assertions pass**; all schemas re-applied twice to prove they are re-runnable |
| Daemon smoke (real daemon process against a mock Supabase / SmartAPI / push service) | `npm run daemon:smoke` | **19 checks pass** |
| Type check · lint · production build | `tsc --noEmit` · `next lint` · `next build` | clean · clean · compiles |

Turn 44 added: quiet-hours windows, wrap-around, time zones and a DST change, critical bypass, validation; heuristic flags incl. the negative cases (balanced book, small book, too few levels, slow cancels, fills, displacement, rate limit); the flag sink never stopping rule evaluation; the dispatcher holding, overriding, caching and failing open; 18 database assertions for the two new tables.

**Not done:** the Surveillance desk was checked by a server-render test (all sections and the heuristic labels present), **not** in a real browser; and no live SmartAPI session or real device was available to this build, so live end-to-end latency is not measured here (see §5).

## 5. Latency benchmark

`npm run bench` (`scripts/benchmark-latency.ts`) replays a synthetic, seeded tick stream with top-5 depth through the **real** rule engine and dispatcher.

**What is real:** `RuleIndex.onTick` (evaluation, volume baseline, imbalance, flag tracker), `createDispatcher` (claim, device lookup, quiet-hours lookup, fan-out, delivery row), the HMAC ACK check, a real `ws` WebSocket and real HTTP calls.
**What is a local stand-in:** the exchange feed, Supabase, the push service and the device — all on loopback inside **one** Node process (Node 22, linux-x64, one shared event loop). Real network distance, database time, push-service delivery and device wake-up are **not** included, so these are *software-pipeline* figures, not what a user's phone will see.

**Run A — reference** (600 rules over 50 symbols, 2 000 ticks/s for 10 s, seed 1; 20 000 ticks, all processed at 2 000/s)

| Stage (ms) | n | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|
| Feed ingest (send → parsed) | 20 000 | 0.23 | 1.10 | 15.3 | 31.2 |
| Match evaluation (one `onTick`) | 20 000 | 0.14 | 0.36 | 0.50 | 15.4 |
| Push dispatch (enqueue → push accepted) | 252 | 4.8 | 136.8 | 202.4 | 221.1 |
| Client ACK (push accepted → ACK verified) | 252 | 1.3 | 7.0 | 13.6 | 29.4 |
| **End-to-end, tick → push accepted** | 252 | 5.3 | 148.8 | 215.2 | 235.9 |
| **End-to-end, tick → ACK** | 252 | 6.6 | 155.9 | 222.1 | 239.7 |

252 alerts fired, 252 pushes accepted, 252 delivery rows written, 252 ACK tokens verified, 0 rejected, 0 duplicates, 0 failures. The push-dispatch tail (p95/p99) is **queueing**: many rules cross within the same instants and the dispatcher caps concurrency at 16; the median alert is dispatched in a few milliseconds. Cooldown is 1 minute, so each rule fires at most once per run — the per-alert rows have n = 252, not millions.

**Run B — overload probe** (1 200 rules, 5 000 ticks/s target, 10 s, seed 7). The harness could only sustain **3 224 ticks/s**: the generator, socket, engine and mock services share one core, the feed backed up (ingest p50 ≈ 0.9 s) and dispatch queued behind it (p50 ≈ 9 s). The engine itself was not the limit — match evaluation stayed at p50 0.25 ms / p99 0.78 ms — but this run **saturated the single-process test harness**, so it must not be quoted as the daemon's capacity or latency. It shows only that, in this setup, one core sustains roughly 3 000 ticks/s end to end. Raw results: `docs/benchmark-results.json`, `docs/benchmark-results-heavy.json`.

**Reading the result honestly.** On loopback the software pipeline adds a median of ~5 ms and a p99 of ~215 ms (burst queueing) between a tick and the push service accepting it; matching a tick against 600 rules costs about 0.14 ms. That supports the design goal (sub-second alerting) for the part of the path this project controls. It does not prove sub-second delivery to a phone. The real figure is recorded per alert in production (`alert_deliveries`: tick time, daemon match time, push-accepted time, device-displayed time) and is shown in the Delivery log.

## 6. Known limitations

* `volume_surge` and `order_imbalance_*` run only in the daemon; the cron backstop cannot evaluate them. The volume baseline is a full-day figure, not time-of-day adjusted.
* Depth data exists only while SmartAPI is streaming; otherwise imbalance and flags show **N/A** (never a stale or invented book). The daemon sees only symbols that have rules; the browser samples the selected stock about twice a second.
* Heuristic flags see only five levels and can be produced by icebergs, market-maker re-quoting and ordinary risk management.
* Held (quiet-hours) alerts are not delivered later.
* Web Push delivery depends on the browser's push service and the device; iOS requires the installed PWA.
* Daemon uptime depends on the host chosen (`daemon/Dockerfile`, `docs/WEEK9_DAEMON.md`); the same `ALERT_ACK_SECRET` must be set on Vercel and on the daemon.

## 7. Reproduce

```bash
npm ci
npm test                          # 186 + 5 checks
bash scripts/rls-test.sh          # 158 database assertions (needs PostgreSQL server binaries)
npm run daemon:smoke              # 19 checks
npm run bench                     # writes docs/benchmark-results.json
npx tsx scripts/benchmark-latency.ts --rules 1200 --rate 5000 --seed 7   # overload probe
```
