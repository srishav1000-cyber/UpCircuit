import type { Holding } from './types';

export const validHolding = (x: unknown): x is Holding =>
  !!x && typeof (x as Holding).symbol === 'string' && Number.isFinite((x as Holding).qty) && (x as Holding).qty > 0 && Number.isFinite((x as Holding).avg) && (x as Holding).avg > 0;

/** Parse a stored portfolio (JSON array of {symbol, qty, avg}); [] when missing or corrupt. Accepts {quantity, buy_price} / {buyPrice} spellings too. */
export function parseHoldings(raw: string | null): Holding[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: Holding[] = [];
    for (const r of v as Record<string, unknown>[]) {
      const h = { symbol: String(r?.symbol ?? '').trim().toUpperCase(), qty: Number(r?.qty ?? r?.quantity), avg: Number(r?.avg ?? r?.buy_price ?? r?.buyPrice) };
      if (validHolding(h) && h.symbol && !out.some((o) => o.symbol === h.symbol)) out.push(h);
    }
    return out;
  } catch {
    return [];
  }
}

/** logical localStorage key of the cached portfolio (the app scopes it per user) */
export const HOLDINGS_BASE = 'upcircuit:holdings:v1';

/** Add a purchase to a portfolio: a symbol already held is merged at the weighted-average buy price; invalid input returns the list unchanged. */
export function mergeHolding(list: Holding[], add: Holding): Holding[] {
  if (!validHolding(add) || !(add.qty > 0) || !(add.avg > 0)) return list;
  const i = list.findIndex((h) => h.symbol === add.symbol);
  if (i < 0) return [...list, { symbol: add.symbol, qty: add.qty, avg: Math.round(add.avg * 100) / 100 }];
  const cur = list[i];
  const qty = cur.qty + add.qty;
  const avg = cur.avg > 0 ? Math.round(((cur.qty * cur.avg + add.qty * add.avg) / qty) * 100) / 100 : add.avg; // a demo holding has no buy price yet
  return list.map((h, j) => (j === i ? { symbol: h.symbol, qty, avg } : h));
}
