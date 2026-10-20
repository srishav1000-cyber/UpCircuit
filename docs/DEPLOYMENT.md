# UpCircuit — hosting, accounts, plans

## 1. Live market feed — direct from the browser (no relay, 100 % Vercel)

The browser opens Angel One's market-data socket itself (`wss://smartapisocket.angelone.in/smart-stream`, `lib/smartapiDirect.ts`). It never sees your password or TOTP secret: a serverless route, `GET /api/smartapi/session`, logs in with them and returns **only** `{ clientCode, feedToken }`. Instrument tokens come from `GET /api/smartapi/tokens` (Angel's public scrip master).

**Steps**
1. Vercel → Settings → Environment Variables:
   - server-side secrets: `SMARTAPI_API_KEY`, `SMARTAPI_CLIENT_CODE`, `SMARTAPI_PASSWORD`, `SMARTAPI_TOTP_SECRET`
   - public, build-time: `NEXT_PUBLIC_SMARTAPI_API_KEY` (the same API key — it is visible in the browser, by design of this architecture)
   - accounts: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the session endpoint only serves verified Supabase users; private deployments without Supabase may set `SMARTAPI_SESSION_PUBLIC=1`)
2. **Redeploy** (`NEXT_PUBLIC_*` is baked in at build time).
3. During market hours the header pill reads **● SMARTAPI LIVE**. Otherwise (no key, not signed in, login rejected, socket failed 3× + one fresh session, outside 09:00–15:45 IST) the app stays on **● REAL YAHOO DATA (DELAYED)**; the status popover says why.

Notes
- The socket opens only inside a window of 15 min either side of the session (Mon–Fri) and falls back to Yahoo on any failure; Yahoo polling keeps running underneath, so there is no gap.
- Security trade-off: the API key and a feed token are visible to the signed-in user's browser. The feed token only permits market-data streaming (no orders), but treat it as a credential; do not share a deployment publicly without Supabase auth.
- **UNVERIFIED against a live account:** browser WebSockets cannot set headers, so credentials go in the URL query string as Angel's browser SDK does; if Angel's server rejects that (or checks `Origin`), the app silently stays on Yahoo. Verify during market hours.
- SmartAPI's static-IP requirement applies to **order placement**; UpCircuit places no orders. I could not confirm any IP rule for market-data sockets, so check with Angel One.
- Serverless instances each log in at most once per 6 h; refreshes are throttled to 1/min.

## 2. Accounts & roles

Email + password sign-up/login (`components/AuthScreen.tsx`). At sign-up the user picks a **plan** and a **primary role** with radio buttons (⚡ Day Trader · 📊 Retail Investor · 🏛️ Institutional Analyst · 🛡️ Executive / Risk Manager). Roles outside the plan are disabled.

Backends (`lib/authBackends.ts`):
- **Local demo** (default, no setup): PBKDF2-SHA256 (120k) + per-user salt in `localStorage`. Anyone with the browser profile can edit it, so it is **not a security boundary**.
- **Supabase** (set `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`, run `docs/AUTH_SCHEMA.sql`): Supabase Auth + `profiles(id, role, plan)` with RLS; the browser can only update `role`.
- Auth is skipped with `NEXT_PUBLIC_AUTH_REQUIRED=false`.

Per-user data: watchlists, portfolio, alerts, chat history, chart drawings and the focus basket are stored under `upcircuit:<key>:<userId>`; with Supabase you can move them to the `watchlists` / `preferences` tables.

## 3. Plans

| Tier | Plan | Roles |
|---|---|---|
| 1 | Day Trader | ⚡ only |
| 2 | Retail Investor | 📊 only |
| 3 | Full Access | all four |

Locked roles show 🔒 in the persona dropdown and open the Plans dialog. `canUse(plan, role)` in `lib/auth.ts` is the single rule. **This is UX gating only** — dashboards run in the browser, so the data is not secret. To enforce server-side, verify the Supabase JWT in your API routes and check `profiles.plan` before serving paid endpoints (e.g. `/api/ask`, `/api/session`). Payments are not wired; prices are illustrative.

## 4. Dashboard personalisation

Day Trader and Retail dashboards open with **🎯 My focus**: up to 6 symbols chosen from your watchlists and holdings (Edit → click `+ SYMBOL`). Tiles are live (LTP, % change, day-range, VWAP/volume for Day Trader, P&L or yield/mcap for Retail). Focus symbols are subscribed first on the relay feed.

## 5. Off-market data

Closed market = the last real prices and real previous-session bars from Yahoo Finance (delayed); nothing is simulated and there are no synthetic events.

## Tick persistence (optional)
1. Run `docs/MARKET_TICKS.sql` in the Supabase SQL editor (RLS on, no policies).
2. Set `SUPABASE_SERVICE_ROLE_KEY` as a server-only env var (never `NEXT_PUBLIC_`).
3. Without it `/api/market/*` answer 501 and the terminal replays real 1-minute bars instead. Prune with the `delete … trading_date < …` line at the bottom of the SQL file.
