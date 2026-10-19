// TEST-ONLY: stands in for a Yahoo /api/quotes payload so engine consumers can be unit-tested offline. Never imported by the app.
import { MarketEngine } from '../lib/market';
import { SEED_INSTRUMENTS } from '../lib/instruments';
import { hashStr, mulberry32 } from '../lib/estimate';
import type { Candle } from '../lib/types';

export function fixtureRows() {
  return SEED_INSTRUMENTS.map((i) => {
    const r = mulberry32(hashStr(i.symbol));
    const prev = Math.round((20 + r() * 4000) * 20) / 20;
    const ltp = Math.round(prev * (1 + (r() - 0.5) * 0.04) * 20) / 20;
    return { symbol: i.symbol, ltp, prevClose: prev, high: Math.max(ltp, prev) * 1.005, low: Math.min(ltp, prev) * 0.995, volume: 50_000 + Math.floor(r() * 5e6), avgVolume: 1e6, sharesCr: 1 + r() * 400 };
  });
}
export function fixtureCloses(symbol: string, n = 252): number[] {
  const r = mulberry32(hashStr('c' + symbol));
  let p = 100 + r() * 1000;
  return Array.from({ length: n }, () => (p *= 1 + (r() - 0.48) * 0.02));
}
export function fixtureCandles(symbol: string, n = 252): Candle[] {
  const c = fixtureCloses(symbol, n);
  return c.map((close, i) => ({ time: 1_700_000_000 + i * 86400, open: c[i - 1] ?? close, high: Math.max(close, c[i - 1] ?? close) * 1.005, low: Math.min(close, c[i - 1] ?? close) * 0.995, close, volume: 1e5 }));
}
export function ingestFixture(e: MarketEngine): MarketEngine {
  e.ingestRows(fixtureRows());
  return e;
}
