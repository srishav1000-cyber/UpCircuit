# UpCircuit — Angel One + Screener.in style trading terminal

Next.js 14 · Tailwind · TypeScript · TradingView Lightweight Charts · next-themes. Edge API routes, no native binaries (Vercel-ready).

## Run
```
npm i
npm run sync:instruments   # NSE + BSE equity master via Angel One scrip master (exch_seg NSE/BSE); needs network access, else the 229-symbol seed is used
npm run dev
npm test                   # 52 analytics / engine / SmartAPI-codec / import / alert / sync checks
npm run build
```
Env vars: see `.env.example` (`GEMINI_API_KEY`, `GEMINI_MODEL`, `NEWS_RSS_URLS`, `GEMINI_API_BASE`, `NSE_EQUITY_CSV_URL`, `NEXT_PUBLIC_SMARTAPI_API_KEY`, `SMARTAPI_*`).

## Features
- **Navbar**: NIFTY/SENSEX/VIX ticker, fuzzy universal search (`public/data/instruments.json`), persona switcher, CSV upload (`symbol,quantity,buy_price`), Light/Dark/System theme.
- **Circuit banner**: volume/price surges ≥3×, upper/lower circuit breaches.
- **Home**: market summary, gainers/losers/volume leaders, Large/Mid/Small cap filter, RSS news with Bullish/Bearish/Neutral badges.
- **Research modal**: 10 timeframes, Screener-style ratios, R1/R2/S1/S2, short vs long-term outlook, AI Copilot (Gemini → local VADER/rules fallback, 5-min TTL cache).
- **✨ Ask UpCircuit**: slide-over drawer (Navbar + terminal header) for free-text market / portfolio Q&A; `/api/ask` → Gemini, local rules fallback, 5-min cache; conversation persists.
- **Portfolio import**: CSV, PNG/JPG (in-browser Tesseract OCR; optional Gemini-vision re-read), PDF (text layer, OCR fallback). Editable review table + diagnostics (concentration, diversification score, sector exposure, rebalancing) before replacing.
- **Feed status badge**: `● SMARTAPI LIVE` (market open + direct SmartAPI ticks flowing) · `● REAL YAHOO DATA (DELAYED)` (default and automatic fallback).
- **Personas** (`lib/analytics.ts`): Retail (allocation donut, dividend forecast, return vs NIFTY, RSI heat), Trader (5-level depth, tick-volume histogram, VWAP ± kσ bands, intraday σ, hotkeys B/S/C), Institutional (4×4 Pearson heatmap, A/D gauge, liquidity ratio, Sharpe), Executive (market-cap trend, weighted risk, HHI, news-sentiment meter).

## Analysis-only workspace
UpCircuit has **no order placement**. Every stock offers 🔍 Deep Research (research page; from inside it, a written deep-dive in Ask UpCircuit), ⭐ Add to Watchlist (same list as ★ favourites) and 🔔 Set Price Alert (stored in the browser, fires a toast while the app is open — no push/SMS). The app opens on the Discovery Hub; the four persona lenses live in the Navbar dropdown, and every dashboard plus the research page has a 🖥️ Full Screen Dashboard toggle (Esc exits).

## Connection status
The Navbar pill shows AI (Gemini key accepted / rejected / not set → local rules) and the market feed (SmartAPI live / offline session, with the reason). `/api/status` returns booleans and variable names only; Gemini is validated with a metadata call (no generation quota). Keys are never entered in the browser.

## Instrument master (NSE + BSE)
`scripts/sync-instruments.mjs` reads Angel One's scrip master (`exch_seg` = NSE: `-EQ/-BE/-BZ/-SM/-ST` cash rows; `exch_seg` = BSE: cash rows with a ticker-style symbol), enriches NSE names from `EQUITY_L.csv`, and de-dupes by ticker (NSE wins; BSE-only names carry `exch: "BSE"`). Expect roughly 7,500+ names; check the printed NSE / BSE-only counts after the first run — the BSE row filter is unverified against the live file.

## Live feed (Angel One SmartAPI)
No relay server: the browser connects directly to `wss://smartapisocket.angelone.in/smart-stream` (`lib/smartapiDirect.ts`: 30 s ping, exponential-backoff reconnect ×3, binary decode via `lib/smartapi.ts`). Tokens come from `/api/smartapi/session` (server-side login; only the feed token + client code are returned, to verified Supabase users) and `/api/smartapi/tokens`. Any failure falls back to Yahoo (`/api/quotes`, `/api/bars/[symbol]`). See `docs/DEPLOYMENT.md` §1.

## Caveats
- Prices and bars are real (Yahoo, delayed ~15 min, or SmartAPI ticks); fundamentals come from the data provider where available and otherwise show **N/A** (no simulated ratios). Not investment advice.
- `RA_analytics.xlsx` was not provided; persona metrics follow the formulas in the brief.
- **The direct SmartAPI socket (query-string auth), packet layouts and token numbers are UNVERIFIED against a live Angel One account** — validate with your credentials during market hours.
- OCR of screenshots can misread digits; always review the table before importing. Vision re-read sends the image to Gemini.
- Gemini was tested only against a mock server; the default model name and RSS URLs are unverified.
- Uploaded buy prices are compared against simulated LTPs, so P&L is illustrative.
- Most BSE-only names have no sector in the seed, so they show as `Others` in sector views; prices for them are simulated like the rest.
- Market-cap buckets use approximate AMFI cut-offs.

## Hotkeys
R deep research · W/F watchlist · A price alert · 1/2/3 timeframe · `/` search · Esc close / exit full screen


## Round 19 additions
- **Tick persistence + off-market replay** — `docs/MARKET_TICKS.sql`, `lib/offmarketSimulation.ts`, `/api/market/{ticks,replay,export-csv}`. While the market is open the browser logs ≤1 real SmartAPI tick / symbol / 15 s (09:15–15:30 IST) to Supabase (`SUPABASE_SERVICE_ROLE_KEY`, server only). Off-hours it replays the closing stretch of those ticks → real 1-minute bars → (only if neither exists) a deterministic ±0.05 % wobble inside the session High/Low. Replay never raises circuit alerts. Account menu → "Export session ticks (CSV)".
- **Portfolio risk** (Institutional + Executive): sector HHI (<1,500 green, 1,500–2,500 yellow, >2,500 red) and ₹ macro-shock table (`lib/analytics/hhi.ts`). Sensitivities/betas are illustrative constants — edit them there.
- **Alert dedupe** (`lib/circuitDedupe.ts`): one chime/overlay/e-mail per symbol·direction per IST day; re-fires only on escalation 5→10→20 %. Circuit alerts are active only 09:15–15:30 IST.
- **Screener audit**: no hash/PRNG estimates. P/E, ROE, ROCE, book value, EPS, 52W range, quarterly P&L and shareholding are real provider values or `N/A`. The SmartAPI scrip master has no fundamentals.
