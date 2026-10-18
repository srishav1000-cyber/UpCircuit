// Angel One SmartAPI — SmartWebSocketV2 binary decoding + subscribe-message helpers.
// Pure functions (DataView only), shared by the relay (scripts/angel-relay.ts) and the unit tests.
//
// UNVERIFIED against a live session: layouts follow Angel One's published SmartWebSocketV2 docs / SDKs
// (little-endian; prices in paise). Validate with a real feed token before relying on them.

export const ExchangeType = { NSE_CM: 1, NSE_FO: 2, BSE_CM: 3, BSE_FO: 4, MCX_FO: 5, NCX_FO: 7, CDE_FO: 13 } as const;
export const Mode = { LTP: 1, QUOTE: 2, SNAP_QUOTE: 3 } as const;

export interface SmartDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface SmartTick {
  mode: 1 | 2 | 3;
  exchangeType: number;
  token: string;
  seq: number;
  /** exchange timestamp, epoch ms */
  exchangeTs: number;
  /** ₹ */
  ltp: number;
  // QUOTE and above
  lastQty?: number;
  avgPrice?: number;
  volume?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  // SNAP_QUOTE
  lastTradeTs?: number;
  oi?: number;
  bids?: SmartDepthLevel[];
  asks?: SmartDepthLevel[];
  upperCircuit?: number;
  lowerCircuit?: number;
  high52?: number;
  low52?: number;
}

export const PACKET_SIZE = { 1: 51, 2: 123, 3: 379 } as const;

const paise = (n: number) => n / 100;

/** Decode one binary tick. Returns null for packets that are too short or have an unknown mode. */
export function parseTick(buf: ArrayBuffer | Uint8Array): SmartTick | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < PACKET_SIZE[1]) return null;
  const mode = dv.getUint8(0) as 1 | 2 | 3;
  if (mode !== 1 && mode !== 2 && mode !== 3) return null;
  if (u8.byteLength < PACKET_SIZE[mode]) return null;

  let token = '';
  for (let i = 2; i < 27; i++) {
    const c = dv.getUint8(i);
    if (c === 0) break;
    token += String.fromCharCode(c);
  }
  const i64 = (o: number) => Number(dv.getBigInt64(o, true));
  const t: SmartTick = {
    mode,
    exchangeType: dv.getUint8(1),
    token,
    seq: i64(27),
    exchangeTs: i64(35),
    ltp: paise(i64(43)),
  };
  if (mode >= 2) {
    t.lastQty = i64(51);
    t.avgPrice = paise(i64(59));
    t.volume = i64(67);
    t.totalBuyQty = dv.getFloat64(75, true);
    t.totalSellQty = dv.getFloat64(83, true);
    t.open = paise(i64(91));
    t.high = paise(i64(99));
    t.low = paise(i64(107));
    t.close = paise(i64(115));
  }
  if (mode === 3) {
    t.lastTradeTs = i64(123);
    t.oi = i64(131);
    const bids: SmartDepthLevel[] = [];
    const asks: SmartDepthLevel[] = [];
    // 10 packets of 20 bytes from offset 147: flag(2) qty(8) price(8) orders(2); flag 1 = buy, 0 = sell
    for (let i = 0; i < 10; i++) {
      const o = 147 + i * 20;
      const lvl = { qty: i64(o + 2), price: paise(i64(o + 10)), orders: dv.getUint16(o + 18, true) };
      (dv.getUint16(o, true) === 1 ? bids : asks).push(lvl);
    }
    t.bids = bids;
    t.asks = asks;
    t.upperCircuit = paise(i64(347));
    t.lowerCircuit = paise(i64(355));
    t.high52 = paise(i64(363));
    t.low52 = paise(i64(371));
  }
  return t;
}

/** Build a subscribe / unsubscribe request for SmartWebSocketV2. */
export function subscribeMessage(tokens: { exchangeType: number; tokens: string[] }[], mode: 1 | 2 | 3 = 3, action: 1 | 2 = 1, correlationID = 'upcircuit') {
  return { correlationID, action, params: { mode, tokenList: tokens } };
}

/** Encode a tick (used by tests and the mock feed) — the inverse of parseTick for the supported modes. */
export function encodeTick(t: SmartTick): Uint8Array {
  const size = PACKET_SIZE[t.mode];
  const u8 = new Uint8Array(size);
  const dv = new DataView(u8.buffer);
  dv.setUint8(0, t.mode);
  dv.setUint8(1, t.exchangeType);
  for (let i = 0; i < t.token.length && i < 24; i++) dv.setUint8(2 + i, t.token.charCodeAt(i));
  const w = (o: number, n: number) => dv.setBigInt64(o, BigInt(Math.round(n)), true);
  w(27, t.seq);
  w(35, t.exchangeTs);
  w(43, t.ltp * 100);
  if (t.mode >= 2) {
    w(51, t.lastQty ?? 0);
    w(59, (t.avgPrice ?? 0) * 100);
    w(67, t.volume ?? 0);
    dv.setFloat64(75, t.totalBuyQty ?? 0, true);
    dv.setFloat64(83, t.totalSellQty ?? 0, true);
    w(91, (t.open ?? 0) * 100);
    w(99, (t.high ?? 0) * 100);
    w(107, (t.low ?? 0) * 100);
    w(115, (t.close ?? 0) * 100);
  }
  if (t.mode === 3) {
    w(123, t.lastTradeTs ?? 0);
    w(131, t.oi ?? 0);
    const levels = [...(t.bids ?? []).slice(0, 5).map((l) => [1, l] as const), ...(t.asks ?? []).slice(0, 5).map((l) => [0, l] as const)];
    levels.forEach(([flag, l], i) => {
      const o = 147 + i * 20;
      dv.setUint16(o, flag, true);
      w(o + 2, l.qty);
      w(o + 10, l.price * 100);
      dv.setUint16(o + 18, l.orders, true);
    });
    w(347, (t.upperCircuit ?? 0) * 100);
    w(355, (t.lowerCircuit ?? 0) * 100);
    w(363, (t.high52 ?? 0) * 100);
    w(371, (t.low52 ?? 0) * 100);
  }
  return u8;
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret — SmartAPI login needs one. Uses WebCrypto (Node ≥ 18). */
export async function totp(secretBase32: string, nowMs = Date.now()): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/[=\s]/g, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('Invalid base32 TOTP secret');
    bits += v.toString(2).padStart(5, '0');
  }
  const key = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Math.floor(nowMs / 1000 / 30);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** Index tokens on the NSE/BSE index segments (exchangeType 1 = NSE_CM for NSE indices, 3 = BSE_CM for SENSEX). UNVERIFIED. */
export const INDEX_TOKENS: { id: string; exchangeType: number; token: string }[] = [
  { id: 'NIFTY', exchangeType: 1, token: '99926000' },
  { id: 'BANKNIFTY', exchangeType: 1, token: '99926009' },
  { id: 'INDIAVIX', exchangeType: 1, token: '99926017' },
  { id: 'SENSEX', exchangeType: 3, token: '99919000' },
];
