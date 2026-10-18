import type { Holding } from './types';

// Sector-allocation rebalance simulator. Pure + deterministic. Educational what-if only — ignores tax, brokerage, impact cost and liquidity.

export interface QuoteLite {
  ltp: number;
  sector: string;
  mcapCr?: number;
  name?: string;
}

export interface SectorRow {
  sector: string;
  currentPct: number;
  targetPct: number;
  currentValue: number;
  targetValue: number;
  /** targetValue − currentValue (₹): + needs buying, − needs trimming */
  delta: number;
}

export interface Trade {
  symbol: string;
  sector: string;
  side: 'TRIM' | 'ADD';
  shares: number;
  price: number;
  /** ₹ value of the shares moved */
  value: number;
  qtyBefore: number;
  qtyAfter: number;
  /** portfolio weight, % */
  wBefore: number;
  wAfter: number;
  /** a stock the user does not hold yet (added to fill an empty target sector) */
  isNew: boolean;
}

export interface RebalancePlan {
  total: number;
  rows: SectorRow[];
  trades: Trade[];
  cashReleased: number;
  cashRequired: number;
  /** cashRequired − cashReleased: fresh money needed (+) or left over (−) */
  netCash: number;
  /** Σ trimmed shares × (price − avg) */
  realisedPnl: number;
  after: Holding[];
  afterPct: Record<string, number>;
  /** holdings without a price are left untouched and excluded from the maths */
  skipped: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function sectorWeights(holdings: Holding[], quoteOf: (s: string) => QuoteLite | undefined): { weights: Record<string, number>; total: number } {
  const val: Record<string, number> = {};
  let total = 0;
  for (const h of holdings) {
    const q = quoteOf(h.symbol);
    if (!q || !(q.ltp > 0)) continue;
    const v = h.qty * q.ltp;
    val[q.sector] = (val[q.sector] ?? 0) + v;
    total += v;
  }
  const weights: Record<string, number> = {};
  for (const [s, v] of Object.entries(val)) weights[s] = total > 0 ? (v / total) * 100 : 0;
  return { weights, total };
}

/** Move one slider; the other sectors are rescaled proportionally so the targets always sum to exactly 100. */
export function setTarget(targets: Record<string, number>, sector: string, value: number): Record<string, number> {
  const keys = Object.keys(targets);
  const v = Math.min(100, Math.max(0, r1(value)));
  const others = keys.filter((k) => k !== sector);
  if (others.length === 0) return { [sector]: 100 };
  const rest = 100 - v;
  const sum = others.reduce((a, k) => a + targets[k], 0);
  const out: Record<string, number> = { [sector]: v };
  let acc = 0;
  others.forEach((k) => {
    out[k] = r1(sum > 0 ? (targets[k] / sum) * rest : rest / others.length);
    acc += out[k];
  });
  // put the rounding residue on the largest other sector
  const big = others.reduce((a, k) => (out[k] > out[a] ? k : a), others[0]);
  out[big] = r1(Math.max(0, out[big] + (rest - acc)));
  return out;
}

export interface PlanInput {
  holdings: Holding[];
  quoteOf: (symbol: string) => QuoteLite | undefined;
  /** stocks to buy when a target sector has no holding (best first) */
  candidates: (sector: string) => { symbol: string; ltp: number; sector: string }[];
  /** target allocation, % per sector (should sum to 100) */
  targets: Record<string, number>;
  /** extra money to invest on top of the current value (default 0 = self-financing) */
  freshCash?: number;
}

export function planRebalance({ holdings, quoteOf, candidates, targets, freshCash = 0 }: PlanInput): RebalancePlan {
  const priced = holdings.filter((h) => {
    const q = quoteOf(h.symbol);
    return q && q.ltp > 0;
  });
  const skipped = holdings.filter((h) => !priced.includes(h)).map((h) => h.symbol);
  const { total } = sectorWeights(priced, quoteOf);
  const base = total + Math.max(0, freshCash);
  const tsum = Object.values(targets).reduce((a, b) => a + b, 0) || 1;

  const bySector = new Map<string, Holding[]>();
  for (const h of priced) {
    const s = quoteOf(h.symbol)!.sector;
    bySector.set(s, [...(bySector.get(s) ?? []), h]);
  }
  const sectors = Array.from(new Set([...bySector.keys(), ...Object.keys(targets)]));
  const curVal = (s: string) => (bySector.get(s) ?? []).reduce((a, h) => a + h.qty * quoteOf(h.symbol)!.ltp, 0);

  const rows: SectorRow[] = sectors.map((s) => {
    const cv = curVal(s);
    const tv = ((targets[s] ?? 0) / tsum) * base;
    return { sector: s, currentPct: total > 0 ? (cv / total) * 100 : 0, targetPct: ((targets[s] ?? 0) / tsum) * 100, currentValue: cv, targetValue: tv, delta: tv - cv };
  });

  const trades: Trade[] = [];
  const afterQty = new Map(holdings.map((h) => [h.symbol, h.qty]));
  const newHold: Holding[] = [];
  const wOf = (value: number) => (base > 0 ? (value / base) * 100 : 0);

  for (const row of rows) {
    const hs = bySector.get(row.sector) ?? [];
    if (Math.abs(row.delta) < 1) continue;
    if (row.delta < 0) {
      // TRIM — pro-rata to each holding's value; a 0 % target exits the sector completely
      for (const h of hs) {
        const q = quoteOf(h.symbol)!;
        const share = (h.qty * q.ltp) / row.currentValue;
        const shares = row.targetPct <= 0 ? h.qty : Math.min(h.qty, Math.round((-row.delta * share) / q.ltp));
        if (shares < 1) continue;
        afterQty.set(h.symbol, h.qty - shares);
        trades.push({ symbol: h.symbol, sector: row.sector, side: 'TRIM', shares, price: q.ltp, value: shares * q.ltp, qtyBefore: h.qty, qtyAfter: h.qty - shares, wBefore: wOf(h.qty * q.ltp), wAfter: wOf((h.qty - shares) * q.ltp), isNew: false });
      }
    } else {
      // ADD — pro-rata across existing holdings in the sector, else the top candidate(s)
      const picks: { symbol: string; ltp: number; weight: number; held?: Holding }[] =
        hs.length > 0
          ? hs.map((h) => ({ symbol: h.symbol, ltp: quoteOf(h.symbol)!.ltp, weight: (h.qty * quoteOf(h.symbol)!.ltp) / row.currentValue, held: h }))
          : candidates(row.sector).filter((c) => c.ltp > 0).slice(0, 2).map((c, _i, a) => ({ symbol: c.symbol, ltp: c.ltp, weight: 1 / a.length }));
      for (const p of picks) {
        const shares = Math.round((row.delta * p.weight) / p.ltp);
        if (shares < 1) continue;
        const before = p.held?.qty ?? 0;
        afterQty.set(p.symbol, before + shares);
        if (!p.held) newHold.push({ symbol: p.symbol, qty: shares, avg: r2(p.ltp) });
        trades.push({ symbol: p.symbol, sector: row.sector, side: 'ADD', shares, price: p.ltp, value: shares * p.ltp, qtyBefore: before, qtyAfter: before + shares, wBefore: wOf(before * p.ltp), wAfter: wOf((before + shares) * p.ltp), isNew: !p.held });
      }
    }
  }

  const after = applyTrades(holdings, trades);
  const cashReleased = trades.filter((t) => t.side === 'TRIM').reduce((a, t) => a + t.value, 0);
  const cashRequired = trades.filter((t) => t.side === 'ADD').reduce((a, t) => a + t.value, 0);
  const realisedPnl = trades.filter((t) => t.side === 'TRIM').reduce((a, t) => a + t.shares * (t.price - (holdings.find((h) => h.symbol === t.symbol)?.avg ?? t.price)), 0);
  const afterPct = sectorWeights(after.filter((h) => quoteOf(h.symbol)), quoteOf).weights;
  return { total, rows: rows.sort((a, b) => b.currentPct - a.currentPct || b.targetPct - a.targetPct), trades: trades.sort((a, b) => Number(a.side === 'ADD') - Number(b.side === 'ADD') || b.value - a.value), cashReleased, cashRequired, netCash: cashRequired - cashReleased, realisedPnl, after, afterPct, skipped };
}

/** Apply trades to the holdings: trims keep the average cost; adds blend into a new weighted-average cost; empty lines are dropped. */
export function applyTrades(holdings: Holding[], trades: Trade[]): Holding[] {
  const map = new Map(holdings.map((h) => [h.symbol, { ...h }]));
  for (const t of trades) {
    const cur = map.get(t.symbol);
    if (t.side === 'TRIM') {
      if (cur) cur.qty -= t.shares;
    } else if (cur) {
      cur.avg = r2((cur.qty * cur.avg + t.shares * t.price) / (cur.qty + t.shares));
      cur.qty += t.shares;
    } else map.set(t.symbol, { symbol: t.symbol, qty: t.shares, avg: r2(t.price) });
  }
  return Array.from(map.values()).filter((h) => h.qty > 0);
}
