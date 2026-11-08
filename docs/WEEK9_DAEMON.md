# Week 9 · Turn 42 — real-time closed-app alert daemon

```
SmartAPI WS ─ticks─► daemon (RuleIndex: Map<SYMBOL, AlertRule[]>) ─rising edge─► claim_alert_rule(rule, window)
                         ▲ Supabase Realtime (alert_rules INSERT/UPDATE/DELETE) + 5-min REST resync          │ true
                                                                                                          ▼
 phone / desktop ◄─ push service (FCM/Mozilla/Apple) ◄─ web-push (VAPID, encrypted) ◄─ dispatcher ─► alert_deliveries
        │ sw.js: showNotification → POST /api/alerts/ack {delivery_id, ack, displayed_at} ─► sw_ack_at, displayed_at
```

## Deploy (not on Vercel — it needs one long-lived process)
1. Run `docs/WEEK9_SCHEMA.sql` in the Supabase SQL editor (after `ENTERPRISE_SCHEMA.sql`).
2. Host: any always-on container/VM (Fly.io, Railway, Render, a VM). `docker build -f daemon/Dockerfile -t upcircuit-daemon .` or `npm ci && npm run daemon`.
3. Daemon env: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SMARTAPI_API_KEY`, `SMARTAPI_CLIENT_CODE`, `SMARTAPI_PASSWORD`, `SMARTAPI_TOTP_SECRET`,
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, optional `RESEND_API_KEY`, `ALERT_ACK_SECRET`, `NEXT_PUBLIC_APP_URL`, `PORT`.
4. Vercel env (so the test button and ACK route work): `SUPABASE_SERVICE_ROLE_KEY`, the three VAPID vars, and the **same** `ALERT_ACK_SECRET` (or the same `VAPID_PRIVATE_KEY`, from which the ACK key is derived).
5. Health: `GET :$PORT/healthz` → feed state, last-tick age, rule/symbol counts, dispatch counters (503 when the feed is silent > 60 s in market hours).

## Behaviour you should know
- **Edge-triggered**: fires on the tick where a condition goes false → true. The first tick after a rule appears only seeds state; a crossing inside the cooldown is swallowed.
- **Safe to run two daemons** (duplicates are suppressed by `claim_alert_rule`) but there is no leader election yet — the standby just wastes work. The 5-minute cron (`/api/worker/alerts`) stays as a backstop; it uses the 1-arg claim, so both paths share `last_triggered_at`.
- **Device list is cached 60 s** per user (a device registered in the last minute may miss one alert; the Settings test push always reads fresh).
- Subscriptions are only ever **added** during a session (SmartAPI stays subscribed to symbols whose rules were deleted until the next reconnect).
- `push_sent_at` = first device accepted by its push service (HTTP 201). `displayed_at` is the **device** clock; `sw_ack_at` the server's. `tick_time` is the exchange timestamp (1 s resolution).
- "Sub-second" is measurable only up to push-service acceptance; delivery to the screen is the push service's and the OS's call. A fully quit desktop browser generally gets nothing; iOS needs the installed PWA.

## Verifying
`npm test` (unit: engine, dispatcher, latency maths, service-worker ACK) · `bash scripts/rls-test.sh` (real PostgreSQL: claim function, columns, Realtime publication) · `npm run daemon:smoke` (daemon vs local mock feed / Supabase / HTTPS push service with real VAPID encryption).
None of these measure real SmartAPI or FCM latency — run the daemon in market hours and read the Delivery log summary for that.

---

## Turn 43 — feed health, volume surge, depth imbalance

**Migration order:** `ENTERPRISE_SCHEMA.sql` → `WEEK9_SCHEMA.sql` → `WEEK9_TURN43_SCHEMA.sql`.
Redeploy the daemon after migrating (it now calls `rpc/daemon_beat` and writes `volume_baselines`).

| Kind | Threshold | Fires when |
|---|---|---|
| `volume_surge` | multiple 0.5–50 of typical full-day volume | today's cumulative volume ≥ multiple × median of last ≤20 completed sessions (needs ≥10, else **N/A**) |
| `order_imbalance_above` | 0.1–1 | (Σbid−Σask)/(Σbid+Σask) over top-5 depth crosses up through +x |
| `order_imbalance_below` | 0.1–1 | same ratio crosses down through −x |

Limits (by design):
- Both kinds are **daemon-only**; the cron backstop cannot evaluate them.
- Volume baseline is full-day, **not time-of-day adjusted**; early-session surges need a low multiple.
- Imbalance is a heuristic of resting orders (can be cancelled). Books under 500 shares across the top 5 levels are N/A. 0.05 hysteresis applies once a crossing is held.
- Rule API: `POST /api/alerts/rules?dry_run=1` validates without saving; PATCH edits threshold/cooldown/channels/enabled (symbol and kind are immutable).

Feed health: the browser pill/banner uses its own tick age (Live ≤5 s, Delayed, Down >60 s). The daemon heartbeat (every 5 s, DB clock) drives "Closed-app alerts are paused" when a previously seen daemon is stale (≥20 s) or offline (≥120 s).

---

## Turn 44 — surveillance desk, heuristic flags, quiet hours

**Migration:** apply `docs/WEEK9_TURN44_SCHEMA.sql` after the Turn 43 one, then redeploy the daemon (it now writes `depth_flags`, reads `user_quiet_hours`, and beats with `version: turn44`).

* **Quiet Hours** — Settings → Alerts. Routine alerts inside the window are held (a `skipped` row "held: quiet hours …", not replayed); `circuit_proximity` always bypasses; a failed preference lookup delivers. The daemon caches each user's window for 60 s.
* **Heuristic depth flags** — walls and rapid add/cancel patterns on top-5 depth, written to `depth_flags` (pruned after 2 days) and shown on the Surveillance desk as "Heuristic Flag / Possible Manipulation Pattern". Not proof; never an alert rule. `/healthz` reports `depthFlags`.
* **Benchmark** — `npm run bench` (loopback software pipeline only; see `docs/WEEK9_SUBMISSION_SUMMARY.md` §5 for what it does and does not measure).
