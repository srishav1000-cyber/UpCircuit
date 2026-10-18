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
Env vars: see `.env.example` (`GEMINI_API_KEY`, `GEMINI_MODEL`, `NEWS_RSS_URLS`, `GEMINI_API_BASE`, `NSE_EQUITY_CSV_URL`, `NEXT_PUBLIC_FEED_WS_URL`, `SMARTAPI_*`, `RELAY_*`).

## Features
- **Navbar**: NIFTY/SENSEX/VIX ticker, fuzzy universal search (`public/data/instruments.json`), persona switcher, CSV upload (`symbol,quantity,buy_price`), Light/Dark/System theme.
- **Circuit banner**: volume/price surges ≥3×, upper/lower circuit breaches.
- **Home**: market summary, gainers/losers/volume leaders, Large/Mid/Small cap filter, RSS news with Bullish/Bearish/Neutral badges.
- **Research modal**: 10 timeframes, Screener-style ratios, R1/R2/S1/S2, short vs long-term outlook, AI Copilot (Gemini → local VADER/rules fallback, 5-min TTL cache).
- **✨ Ask UpCircuit**: slide-over drawer (Navbar + terminal header) for free-text market / portfolio Q&A; `/api/ask` → Gemini, local rules fallback, 5-min cache; conversation persists.
- **Portfolio import**: CSV, PNG/JPG (in-browser Tesseract OCR; optional Gemini-vision re-read), PDF (text layer, OCR fallback). Editable review table + diagnostics (concentration, diversification score, sector exposure, rebalancing) before replacing.
- **Feed status badge**: `🔴 LIVE MARKET` (market open + relay streaming) · `🟡 OFF-MARKET REPLAY` (closed) · `🟠 SIMULATED · FEED OFFLINE` (open, no relay).
- **Personas** (`lib/analytics.ts`): Retail (allocation donut, dividend forecast, return vs NIFTY, RSI heat), Trader (5-level depth, tick-volume histogram, VWAP ± kσ bands, intraday σ, hotkeys B/S/C), Institutional (4×4 Pearson heatmap, A/D gauge, liquidity ratio, Sharpe), Executive (market-cap trend, weighted risk, HHI, news-sentiment meter).

## Analysis-only workspace
UpCircuit has **no order placement**. Every stock offers 🔍 Deep Research (research page; from inside it, a written deep-dive in Ask UpCircuit), ⭐ Add to Watchlist (same list as ★ favourites) and 🔔 Set Price Alert (stored in the browser, fires a toast while the app is open — no push/SMS). The app opens on the Discovery Hub; the four persona lenses live in the Navbar dropdown, and every dashboard plus the research page has a 🖥️ Full Screen Dashboard toggle (Esc exits).

## Connection status
The Navbar pill shows AI (Gemini key accepted / rejected / not set → local rules) and the market feed (SmartAPI live / relay ready / offline / simulated / replay). `/api/status` returns booleans and variable names only; Gemini is validated with a metadata call (no generation quota). Keys are never entered in the browser.

## Instrument master (NSE + BSE)
`scripts/sync-instruments.mjs` reads Angel One's scrip master (`exch_seg` = NSE: `-EQ/-BE/-BZ/-SM/-ST` cash rows; `exch_seg` = BSE: cash rows with a ticker-style symbol), enriches NSE names from `EQUITY_L.csv`, and de-dupes by ticker (NSE wins; BSE-only names carry `exch: "BSE"`). Expect roughly 7,500+ names; check the printed NSE / BSE-only counts after the first run — the BSE row filter is unverified against the live file.

## Live feed (Angel One SmartAPI)
Browsers can't set SmartWebSocketV2's auth headers and must not hold your API key/TOTP secret, so `scripts/angel-relay.ts` logs in server-side, subscribes via SmartWebSocketV2, decodes the binary ticks (`lib/smartapi.ts`) and forwards JSON to the browser adapter `SmartApiFeed` in `lib/market.ts` (ticks → LTP, 1-minute OHLCV candles, 5-level depth, circuit limits). Host it on a long-lived service with TLS and set `NEXT_PUBLIC_FEED_WS_URL`. Market hours: Mon–Fri 09:15–15:30 IST (exchange holidays are not modelled).

## Caveats
- Prices, depth, history and fundamentals are **simulated** (deterministic PRNG). Not investment advice.
- `RA_analytics.xlsx` was not provided; persona metrics follow the formulas in the brief.
- **The SmartAPI relay and packet layouts are UNVERIFIED against a live Angel One account** (codec is round-trip tested only; endpoints, token numbers and byte offsets follow public docs — validate with your credentials).
- OCR of screenshots can misread digits; always review the table before importing. Vision re-read sends the image to Gemini.
- Gemini was tested only against a mock server; the default model name and RSS URLs are unverified.
- Uploaded buy prices are compared against simulated LTPs, so P&L is illustrative.
- Most BSE-only names have no sector in the seed, so they show as `Others` in sector views; prices for them are simulated like the rest.
- Market-cap buckets use approximate AMFI cut-offs.

## Hotkeys
R deep research · W/F watchlist · A price alert · 1/2/3 timeframe · `/` search · Esc close / exit full screen
