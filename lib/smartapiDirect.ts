// Direct browser → Angel One market-data socket (no relay). The browser holds only the public API key + the short-lived FEED token
// (fetched from our /api/smartapi/session, which logs in server-side); the password and TOTP secret never reach it.
//
// UNVERIFIED against a live session: browsers cannot set WebSocket headers, so credentials go in the query string
// (wss://smartapisocket.angelone.in/smart-stream?clientCode=…&feedToken=…&apiKey=…) as in Angel's browser SDK, and packet layouts follow
// lib/smartapi.ts. Validate with a real feed token during market hours.
import { INDEX_TOKENS, Mode, parseTick, subscribeMessage, type SmartTick } from './smartapi';
import type { FeedConn, Tick } from './market';
import type { DepthLevel } from './types';

export const SMART_STREAM_URL = 'wss://smartapisocket.angelone.in/smart-stream';

/** Normalised tick. The five core fields are always present; the rest are optional extras the engine uses when the packet carries them. */
export interface MarketTick {
  /** ticker (RELIANCE) or index id (NIFTY) */
  symbol: string;
  lastPrice: number;
  /** vs previous close, %; 0 when the packet carries no previous close */
  changePercent: number;
  /** cumulative traded volume for the day */
  volume: number;
  /** exchange timestamp, epoch ms */
  timestamp: number;
  isIndex?: boolean;
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  avgPrice?: number;
  lastQty?: number;
  upperCircuit?: number;
  lowerCircuit?: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
}

export interface Listing {
  symbol: string;
  token: string;
  exchangeType: number;
}

export interface StreamError {
  reason: 'retries_exhausted' | 'server_error' | 'unsupported';
  message: string;
  /** reconnect attempts made before giving up */
  attempts: number;
}

export interface DirectStreamOptions {
  apiKey: string;
  clientCode: string;
  feedToken: string;
  onTick: (t: MarketTick) => void;
  /** called once, after `maxRetries` reconnects have failed (or on a server-reported auth error) */
  onError: (e: StreamError) => void;
  onOpen?: () => void;
  onStatus?: (s: FeedConn) => void;
  /** heartbeat interval, ms (default 30 000) */
  pingMs?: number;
  /** reconnects before onError (default 3) */
  maxRetries?: number;
  /** first backoff delay, ms; doubles each retry: 1 s, 2 s, 4 s (default 1000) */
  baseDelayMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

const keyOf = (exchangeType: number, token: string) => `${exchangeType}:${token}`;

export class DirectSmartApiStream {
  status: FeedConn = 'idle';
  ticks = 0;
  /** last time a price / index tick arrived (heartbeat replies don't count) */
  lastTickAt = 0;
  /** reconnects used since the last tick */
  retries = 0;

  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failed = false;
  private bySym = new Map<string, Listing>();
  private byKey = new Map<string, string>(); // exchangeType:token → symbol
  private indexIds = new Set<string>(INDEX_TOKENS.map((i) => i.id));
  private sent = new Set<string>();
  private prevClose = new Map<string, number>();
  private readonly o: Required<Pick<DirectStreamOptions, 'pingMs' | 'maxRetries' | 'baseDelayMs'>> & DirectStreamOptions;

  constructor(opts: DirectStreamOptions) {
    this.o = { pingMs: 30_000, maxRetries: 3, baseDelayMs: 1000, ...opts };
    for (const i of INDEX_TOKENS) {
      this.byKey.set(keyOf(i.exchangeType, i.token), i.id);
      this.bySym.set(i.id, { symbol: i.id, token: i.token, exchangeType: i.exchangeType });
    }
  }

  get url(): string {
    const { apiKey, clientCode, feedToken } = this.o;
    return `${SMART_STREAM_URL}?clientCode=${encodeURIComponent(clientCode)}&feedToken=${encodeURIComponent(feedToken)}&apiKey=${encodeURIComponent(apiKey)}`;
  }

  private set(s: FeedConn) {
    if (this.status !== s) {
      this.status = s;
      this.o.onStatus?.(s);
    }
  }

  connect() {
    if (this.stopped || this.ws) return;
    const WS = this.o.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    if (!WS) return this.fail('unsupported', 'WebSocket is not available in this environment.');
    this.set('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(this.url);
    } catch {
      return this.retryOrFail('Could not open the SmartAPI socket.');
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.sent.clear();
      this.set('open');
      this.startPing();
      this.o.onOpen?.();
      this.flush();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      /* onclose always follows */
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.stopPing();
      if (this.stopped || this.failed) return;
      this.set('closed');
      this.retryOrFail('SmartAPI socket closed.');
    };
  }

  private startPing() {
    this.stopPing();
    this.ping = setInterval(() => {
      if (this.ws?.readyState === 1) this.ws.send('ping');
    }, this.o.pingMs);
  }
  private stopPing() {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }

  private retryOrFail(message: string) {
    if (this.stopped || this.failed || this.timer) return;
    if (this.retries >= this.o.maxRetries) return this.fail('retries_exhausted', message);
    const delay = this.o.baseDelayMs * 2 ** this.retries++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private fail(reason: StreamError['reason'], message: string) {
    if (this.failed) return;
    this.failed = true;
    this.stopPing();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    this.set('closed');
    this.o.onError({ reason, message, attempts: this.retries });
  }

  /** Declare the instruments to stream (diff-sent; re-sent automatically after a reconnect). Indices are always included. */
  subscribe(listings: Listing[]) {
    for (const l of listings) {
      if (!l.token || !l.symbol) continue;
      this.bySym.set(l.symbol, l);
      this.byKey.set(keyOf(l.exchangeType, l.token), l.symbol);
    }
    this.flush();
  }

  private flush() {
    if (this.status !== 'open' || this.ws?.readyState !== 1) return;
    const groups = new Map<number, string[]>();
    for (const l of this.bySym.values()) {
      const k = keyOf(l.exchangeType, l.token);
      if (this.sent.has(k)) continue;
      this.sent.add(k);
      groups.set(l.exchangeType, [...(groups.get(l.exchangeType) ?? []), l.token]);
    }
    groups.forEach((tokens, exchangeType) => {
      for (let i = 0; i < tokens.length; i += 200) this.ws?.send(JSON.stringify(subscribeMessage([{ exchangeType, tokens: tokens.slice(i, i + 200) }], Mode.SNAP_QUOTE)));
    });
  }

  private onMessage(data: unknown) {
    if (typeof data === 'string') {
      if (data === 'pong') return;
      try {
        const j = JSON.parse(data) as { errorCode?: string; errorMessage?: string; message?: string };
        if (j.errorCode || j.errorMessage) return this.fail('server_error', j.errorMessage ?? j.message ?? `SmartAPI error ${j.errorCode}`);
      } catch {
        /* non-JSON text — ignore */
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
    const t = parseTick(data instanceof ArrayBuffer ? data : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength));
    if (!t) return;
    const m = this.format(t);
    if (!m) return;
    this.ticks++;
    this.lastTickAt = Date.now();
    this.retries = 0; // a flowing feed resets the backoff
    this.o.onTick(m);
  }

  private format(t: SmartTick): MarketTick | null {
    const symbol = this.byKey.get(keyOf(t.exchangeType, t.token));
    if (!symbol || !(t.ltp > 0)) return null;
    const isIndex = this.indexIds.has(symbol);
    const close = t.close && t.close > 0 ? t.close : this.prevClose.get(symbol);
    if (close) this.prevClose.set(symbol, close);
    return {
      symbol,
      lastPrice: t.ltp,
      changePercent: close ? (t.ltp / close - 1) * 100 : 0,
      volume: t.volume ?? 0,
      timestamp: t.exchangeTs > 0 ? t.exchangeTs : Date.now(),
      isIndex,
      prevClose: close,
      open: t.open,
      high: t.high,
      low: t.low,
      avgPrice: t.avgPrice,
      lastQty: t.lastQty,
      upperCircuit: t.upperCircuit,
      lowerCircuit: t.lowerCircuit,
      depth: t.bids && t.asks ? { bids: t.bids, asks: t.asks } : undefined,
    };
  }

  close() {
    this.stopped = true;
    this.stopPing();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    this.set('idle');
  }
}

/** MarketTick → the engine's Tick (stocks only; indices go through engine.applyIndexTick). */
export function toEngineTick(m: MarketTick): Tick {
  return {
    symbol: m.symbol,
    ltp: m.lastPrice,
    volume: m.volume || undefined,
    lastQty: m.lastQty,
    avgPrice: m.avgPrice,
    open: m.open,
    high: m.high,
    low: m.low,
    close: m.prevClose,
    upperCircuit: m.upperCircuit,
    lowerCircuit: m.lowerCircuit,
    depth: m.depth,
    ts: m.timestamp,
  };
}
