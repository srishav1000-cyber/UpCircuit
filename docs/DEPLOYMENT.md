# UpCircuit — hosting, accounts, plans

## 1. Public WebSocket relay for SmartAPI

The browser cannot talk to SmartAPI directly (credentials + TOTP). It connects to the relay (`scripts/angel-relay.ts`), which logs in server-side and fans ticks out over WebSocket. Replace `ws://localhost:8787` with a public `wss://` URL.

| Host | Cost (check current pricing) | Fit |
|---|---|---|
| Render free web service | $0, but sleeps after ~15 min idle ([docs](https://render.com/docs/free)) | demos only — first connect after a nap is slow |
| Fly.io | no free tier; a shared-cpu-1x 256 MB machine is about $2/mo ([pricing](https://fly.io/docs/about/pricing/)) | cheap, always-on, good WebSocket support |
| Railway Hobby | about $5/mo | simplest UX, always-on |
| Small VPS (any) | about $4/mo | never sleeps; you manage TLS (Caddy/nginx) |

Recommendation: Render free for the capstone demo, Fly.io (or a $4 VPS) once it must stay awake through market hours (09:15–15:30 IST).

**Steps (Render example)**
1. Push the repo; **New → Blueprint**; it reads `render.yaml` + `Dockerfile.relay`.
2. In the dashboard set secrets `SMARTAPI_API_KEY`, `SMARTAPI_CLIENT_CODE`, `SMARTAPI_PASSWORD`, `SMARTAPI_TOTP_SECRET`, and `RELAY_ALLOWED_ORIGIN=https://<your-app-domain>` (comma-separate several). Never put these in the web app or the browser.
3. Check `https://<relay>.onrender.com/health` → `{"ok":true,"source":"angel"|"yahoo"|"none",…}`.
4. In the **web app's** host (Vercel etc.) set `NEXT_PUBLIC_FEED_WS_URL=wss://<relay>.onrender.com` and **redeploy** — it is baked in at build time. `ws://` is blocked on an https page.
5. The header status pill shows the feed state; `LIVE MARKET` appears once ticks flow.

Notes
- The relay honours `PORT` (Render/Railway/Fly set it) and falls back to Yahoo polling when SmartAPI is not configured.
- Use `/health` for an uptime pinger if you want to keep a free instance warm (against the host's fair-use terms — use at your own risk).
- SmartAPI's static-IP requirement applies to **order placement**; UpCircuit places no orders. I could not confirm any IP rule for market-data WebSockets, so verify with Angel One before relying on a host with a changing IP ([Angel One notice](https://oga-prod.angelone.in/news/market-updates/what-s-changing-in-angel-one-s-smartapi-access-from-april-1-2026)).

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

Closed market = frozen prices, no synthetic events. **▶ Replay last session** (chart header) replays the previous session's 1-minute bars at 1 bar/second — real Yahoo bars via `/api/session/[symbol]` when available, otherwise a deterministic series scaled to the last close — then rests at the close.
