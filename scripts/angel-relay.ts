/**
 * Angel One SmartAPI → browser relay.
 *
 *   npm run relay
 *
 * Logs in server-side (API key, client code, PIN/password, TOTP secret never reach the browser), opens
 * SmartWebSocketV2, decodes the binary ticks and fans them out as JSON to UpCircuit clients (see SmartApiFeed in lib/market.ts).
 * Needs a long-lived process (Fly.io / Render / a VPS) — NOT Vercel serverless. Put it behind TLS and set
 * NEXT_PUBLIC_FEED_WS_URL=wss://your-relay.example.com in the web app.
 *
 * Fallback: when SmartAPI is not configured, fails to log in, or goes silent, the relay polls Yahoo Finance (SYMBOL.NS, else .BO)
 * and emits the same tick / index messages, tagged src:'yahoo' (YAHOO_POLL_MS=6000, YAHOO_MAX_SYMBOLS=30, YAHOO_BASE for tests).
 *
 * Env: SMARTAPI_API_KEY, SMARTAPI_CLIENT_CODE, SMARTAPI_PASSWORD, SMARTAPI_TOTP_SECRET, [RELAY_PORT=8787 | PORT], [RELAY_ALLOWED_ORIGIN=* | comma-separated list]
 * UNVERIFIED against a live Angel One account: endpoints/headers follow their public docs — test with your credentials.
 */
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { INDEX_TOKENS, Mode, ExchangeType, parseTick, subscribeMessage, totp, type SmartTick } from '../lib/smartapi';
import { YAHOO_INDEX, fetchYahooQuote, toYahooSymbol } from '../lib/yahoo';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};

const LOGIN_URL = 'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword';
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';

/** session handed over by the app's /api/smartapi/callback (publisher login) — preferred over the TOTP login while present */
let handed: { jwt: string; feed: string } | null = null;

async function login() {
  const apiKey = env('SMARTAPI_API_KEY');
  const clientCode = process.env.SMARTAPI_CLIENT_CODE ?? '';
  if (handed) return { apiKey, clientCode, jwt: handed.jwt, feed: handed.feed };
  if (!clientCode) throw new Error('SMARTAPI_CLIENT_CODE missing');
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': apiKey,
    },
    body: JSON.stringify({ clientcode: clientCode, password: env('SMARTAPI_PASSWORD'), totp: await totp(env('SMARTAPI_TOTP_SECRET')) }),
  });
  const j = (await res.json()) as { status?: boolean; message?: string; data?: { jwtToken: string; feedToken: string } };
  if (!j.status || !j.data) throw new Error('SmartAPI login failed: ' + (j.message ?? res.status));
  return { apiKey, clientCode, jwt: j.data.jwtToken, feed: j.data.feedToken };
}

interface Listing {
  token: string;
  exchangeType: number;
}

/**
 * Ticker → { token, exchangeType } from Angel's scrip master. Mirrors scripts/sync-instruments.mjs: NSE cash rows
 * ("RELIANCE-EQ", keyed by `name`) win; BSE cash rows (keyed by `symbol`) are added for BSE-only names.
 * BSE token layout is UNVERIFIED against a live feed.
 */
async function loadTokens(): Promise<Map<string, Listing>> {
  const rows = (await (await fetch(SCRIP_MASTER_URL)).json()) as { token: string; symbol: string; exch_seg: string; name: string; instrumenttype?: string }[];
  const m = new Map<string, Listing>();
  for (const r of rows) if (r.exch_seg === 'NSE' && /-(EQ|BE|BZ|SM|ST)$/.test(r.symbol) && !r.instrumenttype) m.set(r.name.toUpperCase(), { token: r.token, exchangeType: ExchangeType.NSE_CM });
  for (const r of rows) if (r.exch_seg === 'BSE' && !r.instrumenttype && /^[A-Z][A-Z0-9&-]{0,19}$/.test(r.symbol) && !m.has(r.symbol)) m.set(r.symbol, { token: r.token, exchangeType: ExchangeType.BSE_CM });
  return m;
}

async function main() {
  let tokens = new Map<string, Listing>();
  try {
    tokens = await loadTokens();
  } catch (e) {
    console.error('[relay] scrip master unavailable (', (e as Error).message, ') — Yahoo fallback will use .NS symbols');
  }
  const bySymbol = (sym: string) => tokens.get(sym);
  const key = (exchangeType: number, token: string) => `${exchangeType}:${token}`;
  const tokenToSymbol = new Map<string, string>();
  tokens.forEach((l, sym) => tokenToSymbol.set(key(l.exchangeType, l.token), sym));
  const indexByToken = new Map(INDEX_TOKENS.map((i) => [i.token, i]));
  console.log(`[relay] scrip master: ${tokens.size} NSE + BSE equities`);

  // hosts (Render, Railway, Fly, Koyeb …) inject PORT; RELAY_PORT still wins for local use
  const port = Number(process.env.RELAY_PORT ?? process.env.PORT ?? 8787);
  // one origin or a comma-separated list, e.g. https://app.vercel.app,https://upcircuit.example.com
  const allowedList = (process.env.RELAY_ALLOWED_ORIGIN ?? '*').split(',').map((x) => x.trim()).filter(Boolean);
  const allowOrigin = (o: string) => allowedList.includes('*') || allowedList.includes(o);
  // plain HTTP side: /health for the host's health check and uptime pingers; everything else must be a WebSocket upgrade
  const http = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, source: lastSrc, clients: wss.clients.size, uptimeSec: Math.round(process.uptime()) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/session') {
      // app → relay token handoff, guarded by RELAY_ADMIN_SECRET
      const secret = process.env.RELAY_ADMIN_SECRET;
      let body = '';
      req.on('data', (c) => (body += c) && body.length > 8192 && req.destroy());
      req.on('end', () => {
        try {
          const j = JSON.parse(body) as { jwt?: string; feed?: string };
          if (!secret || req.headers['x-relay-secret'] !== secret) throw new Error('forbidden');
          if (!j.jwt || !j.feed) throw new Error('bad');
          handed = { jwt: j.jwt, feed: j.feed };
          upstream?.close(); // reconnect with the new session
          res.writeHead(200).end('{"ok":true}');
        } catch (e) {
          res.writeHead((e as Error).message === 'forbidden' ? 403 : 400).end('{"ok":false}');
        }
      });
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('Upgrade Required');
  });
  const wss = new WebSocketServer({
    server: http,
    verifyClient: ({ origin }: { origin: string }) => allowOrigin(origin),
  });
  const subscribed = new Set<string>(); // tokens already requested upstream
  let upstream: WebSocket | null = null;
  let hbTimer: ReturnType<typeof setInterval> | null = null;

  let lastAngelTickAt = 0;
  const angelHealthy = () => upstream?.readyState === WebSocket.OPEN && Date.now() - lastAngelTickAt < 30_000;
  let lastSrc: 'angel' | 'yahoo' | 'none' = 'none';

  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(s));
  };

  const subscribeUpstream = (toks: { exchangeType: number; tokens: string[] }[]) => {
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(subscribeMessage(toks, Mode.SNAP_QUOTE)));
  };

  const connectUpstream = async () => {
    const s = await login();
    console.log('[relay] logged in as', s.clientCode);
    const ws = new WebSocket(WS_URL, { headers: { Authorization: s.jwt, 'x-api-key': s.apiKey, 'x-client-code': s.clientCode, 'x-feed-token': s.feed } });
    upstream = ws;
    ws.on('open', () => {
      console.log('[relay] SmartWebSocketV2 connected');
      subscribed.clear();
      subscribeUpstream(INDEX_TOKENS.reduce<{ exchangeType: number; tokens: string[] }[]>((a, i) => {
        const g = a.find((x) => x.exchangeType === i.exchangeType);
        g ? g.tokens.push(i.token) : a.push({ exchangeType: i.exchangeType, tokens: [i.token] });
        return a;
      }, []));
      hbTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 10_000);
      clientSyms.forEach((syms) => syms.forEach((sym) => ensureSub(sym)));
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return; // 'pong' or JSON error frames
      const t = parseTick(new Uint8Array(data));
      if (t) {
        lastAngelTickAt = Date.now();
        lastSrc = 'angel';
        forward(t);
      }
    });
    const restart = () => {
      if (hbTimer) clearInterval(hbTimer);
      upstream = null;
      setTimeout(() => connectUpstream().catch((e) => (console.error('[relay]', e.message), restart())), 5000);
    };
    ws.on('close', restart);
    ws.on('error', (e) => console.error('[relay] upstream error', e.message));
  };

  const prevClose = new Map<string, number>();
  const forward = (t: SmartTick) => {
    const ix = indexByToken.get(t.token);
    if (ix) {
      const prev = t.close ?? prevClose.get(ix.id);
      if (prev) prevClose.set(ix.id, prev);
      return broadcast({ t: 'index', id: ix.id, value: t.ltp, prev, src: 'angel' });
    }
    const symbol = tokenToSymbol.get(key(t.exchangeType, t.token));
    if (!symbol) return;
    broadcast({
      t: 'tick',
      src: 'angel',
      symbol,
      ltp: t.ltp,
      volume: t.volume,
      lastQty: t.lastQty,
      avgPrice: t.avgPrice,
      open: t.open,
      high: t.high,
      low: t.low,
      close: t.close,
      upperCircuit: t.upperCircuit,
      lowerCircuit: t.lowerCircuit,
      depth: t.bids && t.asks ? { bids: t.bids, asks: t.asks } : undefined,
      ts: t.exchangeTs,
    });
  };

  const ensureSub = (sym: string) => {
    const l = bySymbol(sym);
    if (!l || subscribed.has(key(l.exchangeType, l.token))) return;
    subscribed.add(key(l.exchangeType, l.token));
    subscribeUpstream([{ exchangeType: l.exchangeType, tokens: [l.token] }]);
  };

  const clientSyms = new Map<WebSocket, Set<string>>();
  wss.on('connection', (c: WebSocket) => {
    const set = new Set<string>();
    clientSyms.set(c, set);
    c.on('message', (d: Buffer) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.t === 'sub' && Array.isArray(m.symbols)) {
          for (const sym of m.symbols.slice(0, 200)) if (typeof sym === 'string' && sym.length <= 24) (set.add(sym), ensureSub(sym));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    c.on('close', () => clientSyms.delete(c));
  });
  setInterval(() => broadcast({ t: 'hb', src: lastSrc }), 5_000);

  /* ───── Yahoo Finance fallback: polls only while SmartAPI is not delivering ───── */
  const recent = new Map<string, true>(); // symbols clients asked for, most recent last
  wss.on('connection', (c: WebSocket) =>
    c.on('message', (d: Buffer) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.t === 'sub' && Array.isArray(m.symbols)) // the client lists the most important symbols first (selected, watchlist, holdings) — insert in reverse so they stay the most recent
        for (const sym of (m.symbols.slice(0, 200) as unknown[]).reverse()) if (typeof sym === 'string' && sym.length <= 24) (recent.delete(sym), recent.set(sym, true));
      } catch {
        /* ignore */
      }
    }),
  );
  const pollMs = Number(process.env.YAHOO_POLL_MS ?? 6000);
  const maxSyms = Number(process.env.YAHOO_MAX_SYMBOLS ?? 30);
  const yahooAlt = new Map<string, string>(); // symbol → working Yahoo ticker (e.g. fell back to .BO)
  let backoff = 0;
  let yahooBusy = false;
  const pollYahoo = async () => {
    if (yahooBusy || angelHealthy() || wss.clients.size === 0) return;
    if (backoff > Date.now()) return;
    yahooBusy = true;
    let limited = false;
    try {
      const syms = Array.from(recent.keys()).slice(-maxSyms);
      const jobs: (() => Promise<void>)[] = [];
      for (const [id, y] of Object.entries(YAHOO_INDEX))
        jobs.push(async () => {
          const r = await fetchYahooQuote(id, y);
          if (r.ok) (lastSrc = 'yahoo', broadcast({ t: 'index', id, value: r.tick.ltp, prev: r.tick.close, src: 'yahoo' }));
          else if (r.status === 429) limited = true;
        });
      for (const sym of syms)
        jobs.push(async () => {
          const l = bySymbol(sym);
          const first = yahooAlt.get(sym) ?? toYahooSymbol(sym, l?.exchangeType === ExchangeType.BSE_CM ? 'BSE' : 'NSE');
          let r = await fetchYahooQuote(sym, first);
          if (!r.ok && r.status === 404 && first.endsWith('.NS')) {
            r = await fetchYahooQuote(sym, toYahooSymbol(sym, 'BSE'));
            if (r.ok) yahooAlt.set(sym, toYahooSymbol(sym, 'BSE'));
          }
          if (r.ok) {
            lastSrc = 'yahoo';
            const { symbol, ts, ...rest } = r.tick;
            broadcast({ t: 'tick', src: 'yahoo', symbol, ts, ...rest });
          } else if (r.status === 429) limited = true;
        });
      // small worker pool — be polite to the public endpoint
      let next = 0;
      await Promise.all(Array.from({ length: 5 }, async () => { while (next < jobs.length) await jobs[next++](); }));
    } finally {
      yahooBusy = false;
      if (limited) {
        backoff = Date.now() + 60_000;
        console.error('[relay] Yahoo rate-limited (429) — pausing 60 s');
      }
    }
  };
  setInterval(() => void pollYahoo(), pollMs);

  http.listen(port, '0.0.0.0', () => console.log(`[relay] listening on :${port} (ws + /health)`));
  const creds = ['SMARTAPI_API_KEY', 'SMARTAPI_CLIENT_CODE', 'SMARTAPI_PASSWORD', 'SMARTAPI_TOTP_SECRET'];
  if (creds.some((k) => !process.env[k])) {
    console.warn(`[relay] SmartAPI not configured (missing ${creds.filter((k) => !process.env[k]).join(', ')}) — running on the Yahoo Finance fallback`);
    return;
  }
  const retry = (e: Error) => {
    console.error('[relay] SmartAPI unavailable:', e.message, '— Yahoo fallback active; retrying in 30 s');
    setTimeout(() => connectUpstream().catch(retry), 30_000);
  };
  await connectUpstream().catch(retry);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
