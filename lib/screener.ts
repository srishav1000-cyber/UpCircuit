import type { Instrument, Quote } from './types';
import { basePrice, generateHistory, hashStr, mulberry32, sharesCr } from './market';
import { getFundamentals, sectorTypicalPe } from './fundamentals';

/**
 * Screener.in / Angel One-style stock snapshot for ANY instrument (all 8,100+ NSE + BSE names).
 * SIMULATED, deterministic per symbol and consistent with the live quote: market cap, P/E, EPS, book value, ROE / ROCE and
 * D/E come from getFundamentals(); revenue, profit and shareholding are scaled from market cap, P/E and the sector's margins,
 * so the last four quarters' net profit sums to ≈ market cap ÷ P/E and EPS ≈ price ÷ P/E. Replace with a licensed data feed
 * (exchange filings / vendor) returning the same `Screener` shape for real numbers.
 */

export interface QuarterRow {
  /** e.g. "Sep 2026" */
  label: string;
  sales: number;
  expenses: number;
  operatingProfit: number;
  opmPct: number;
  netProfit: number;
  eps: number;
}

export interface Screener {
  marketCapCr: number;
  pe: number;
  industryPe: number;
  bookValue: number;
  dividendYield: number;
  roce: number;
  roe: number;
  faceValue: number;
  debtToEquity: number | null;
  eps: number;
  high52: number;
  low52: number;
  quarters: QuarterRow[];
  holding: { promoters: number; fiis: number; diis: number; public: number };
  /** provenance: `live` = at least some figures are real (Yahoo Finance); `estimated` lists what is still simulated */
  source: { live: boolean; quarters: boolean; holding: boolean; estimated: string[]; asOf?: number };
}

const OPM: Record<string, [number, number]> = {
  Banking: [30, 50], IT: [20, 28], Energy: [12, 28], Auto: [9, 17], FMCG: [16, 28], Pharma: [18, 30], Metals: [14, 28], Financials: [35, 60],
  Infra: [10, 20], Telecom: [30, 50], Consumer: [10, 20], Cement: [15, 25], Realty: [20, 35], Chemicals: [16, 26], Others: [10, 22],
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const lerp = (a: number, b: number, r: number) => a + (b - a) * r;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The latest 5 quarter-end labels (oldest → newest) completed before `now`. */
export function quarterLabels(now = new Date(), n = 5): string[] {
  let y = now.getUTCFullYear();
  let m = Math.floor(now.getUTCMonth() / 3) * 3 - 1; // last completed quarter-end month
  if (m < 0) {
    m += 12;
    y -= 1;
  }
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${MONTHS[m]} ${y}`);
    m -= 3;
    if (m < 0) {
      m += 12;
      y -= 1;
    }
  }
  return out;
}

type Q = Pick<Quote, 'symbol' | 'sector' | 'ltp' | 'prevClose' | 'mcapCr' | 'dividendYield' | 'high' | 'low'>;

function computeScreener(q: Q, now: Date): Screener {
  const f = getFundamentals(q);
  const r = mulberry32(hashStr(q.symbol + ':scr'));
  const [oLo, oHi] = OPM[q.sector] ?? OPM.Others;
  const opm = lerp(oLo, oHi, r());
  const conv = lerp(0.45, 0.75, r()); // net profit ÷ operating profit
  const growth = lerp(-0.04, 0.28, r()); // annual growth, spread over quarters
  const ttmPat = q.mcapCr / Math.max(f.pe, 0.1); // ₹ Cr
  const shares = q.mcapCr / q.ltp; // Cr shares

  // growth + seasonality weights → scale so the latest four quarters sum to TTM
  const w = Array.from({ length: 5 }, (_, i) => (1 + growth / 4) ** (i - 4) * (1 + (r() - 0.5) * 0.14));
  const k = ttmPat / (w[1] + w[2] + w[3] + w[4]);
  const labels = quarterLabels(now);
  const quarters: QuarterRow[] = w.map((wi, i) => {
    const pat = wi * k;
    const op = pat / conv;
    const jitter = 1 + (r() - 0.5) * 0.06;
    const opmQ = opm * jitter;
    // realistic bound: a quarter's revenue is 5–25 % of market cap (never ×100 for a small scrip); profit stays as derived from P/E
    const sales = Math.min(Math.max(op / (opmQ / 100), q.mcapCr * 0.05), q.mcapCr * 0.25);
    const opB = Math.min(sales * 0.95, Math.max(sales * (opmQ / 100), pat * 1.1));
    return { label: labels[i], sales: r1(sales), expenses: r1(sales - opB), operatingProfit: r1(opB), opmPct: r1((opB / sales) * 100), netProfit: r1(pat), eps: r2(pat / shares) };
  });

  // 52-week range from the same deterministic 1Y series the chart uses (anchored on the previous close → stable while LTP ticks)
  const hist = generateHistory(q.symbol, '1Y', q.prevClose, now.getTime(), q.sector);
  let hi = Math.max(q.ltp, q.high, ...hist.map((c) => c.high));
  let lo = Math.min(q.ltp, q.low, ...hist.map((c) => c.low));
  hi = r2(hi);
  lo = r2(lo);

  // shareholding: promoters from the fundamentals, remainder split deterministically
  const promoters = f.promoterHolding;
  const rest = 100 - promoters;
  const fiis = r1(rest * lerp(0.15, 0.4, r()));
  const diis = r1(rest * lerp(0.1, 0.3, r()));
  const pub = r1(100 - promoters - fiis - diis);

  return {
    marketCapCr: q.mcapCr,
    pe: f.pe,
    industryPe: sectorTypicalPe(q.sector),
    bookValue: f.bookValue,
    dividendYield: f.dividendYield,
    roce: f.roce,
    roe: f.roe,
    faceValue: [1, 2, 5, 10, 10][hashStr(q.symbol + ':fv') % 5],
    debtToEquity: f.debtToEquity,
    eps: f.eps,
    high52: hi,
    low52: lo,
    quarters,
    holding: { promoters, fiis, diis, public: pub },
    source: { live: false, quarters: false, holding: false, estimated: ['all figures'] },
  };
}

const fin = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pos = (v: unknown, d: number): number => {
  const n = fin(v, NaN);
  return n > 0 ? n : d;
};

/** Sector-neutral defaults used when any input / field is missing (never renders blank widgets or throws). */
function fallbackQuarters(now: Date, ltp: number, mcap: number): QuarterRow[] {
  const pat = Math.max(1, mcap / 15.2 / 4);
  return quarterLabels(now).map((label) => ({ label, sales: r1(pat * 6), expenses: r1(pat * 4.8), operatingProfit: r1(pat * 1.2 * 1.4), opmPct: 20, netProfit: r1(pat), eps: r2(pat / Math.max(mcap / Math.max(ltp, 1), 0.01)) }));
}

/** Merge a possibly partial / NaN-laden Screener with safe defaults. */
function fillScreener(x: Partial<Screener> | undefined, q: Partial<Q> | undefined, now: Date): Screener {
  const ltp = pos(q?.ltp, 100);
  const mcap = pos(x?.marketCapCr ?? q?.mcapCr, 1000);
  const hold = x?.holding;
  const promoters = Math.min(100, Math.max(0, fin(hold?.promoters, 50)));
  const fiis = Math.min(100 - promoters, Math.max(0, fin(hold?.fiis, 12)));
  const diis = Math.min(100 - promoters - fiis, Math.max(0, fin(hold?.diis, 10)));
  const quarters = (Array.isArray(x?.quarters) && x!.quarters.length ? x!.quarters : fallbackQuarters(now, ltp, mcap)).map((r, i) => ({
    label: r?.label || quarterLabels(now)[i] || '—',
    sales: fin(r?.sales, 0),
    expenses: fin(r?.expenses, 0),
    operatingProfit: fin(r?.operatingProfit, 0),
    opmPct: fin(r?.opmPct, 0),
    netProfit: fin(r?.netProfit, 0),
    eps: fin(r?.eps, 0),
  }));
  const hi = pos(x?.high52, ltp * 1.2);
  const lo = pos(x?.low52, ltp * 0.8);
  return {
    marketCapCr: mcap,
    pe: pos(x?.pe, 15.2),
    industryPe: pos(x?.industryPe, 20),
    bookValue: pos(x?.bookValue, ltp / 2.5),
    dividendYield: fin(x?.dividendYield, 0),
    roce: fin(x?.roce, 12),
    roe: fin(x?.roe, 12),
    faceValue: pos(x?.faceValue, 10),
    debtToEquity: x?.debtToEquity == null ? null : fin(x.debtToEquity, 0),
    eps: fin(x?.eps, ltp / 15.2),
    high52: Math.max(hi, lo, ltp),
    low52: Math.min(hi, lo, ltp),
    quarters,
    holding: { promoters, fiis, diis, public: Math.max(0, Math.round((100 - promoters - fiis - diis) * 10) / 10) },
    source: x?.source ?? { live: false, quarters: false, holding: false, estimated: ['all figures'] },
  };
}

/** Never throws, never returns NaN / empty arrays — safe for any of the 8,100+ instruments, even with missing quote fields. */
export function getScreener(q: Q | null | undefined, now = new Date()): Screener {
  let raw: Screener | undefined;
  try {
    if (q && q.symbol) {
      const safe: Q = { ...q, sector: q.sector || 'Others', ltp: pos(q.ltp, 100), prevClose: pos(q.prevClose, pos(q.ltp, 100)), mcapCr: pos(q.mcapCr, 1000), dividendYield: fin(q.dividendYield, 0), high: pos(q.high, pos(q.ltp, 100)), low: pos(q.low, pos(q.ltp, 100)) };
      raw = computeScreener(safe, now);
    }
  } catch {
    raw = undefined;
  }
  return fillScreener(raw, q ?? undefined, now);
}

/** Where `v` sits between lo and hi, 0–100 (clamped). */
export const rangePct = (v: number, lo: number, hi: number) => (hi > lo ? Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)) : 50);

/**
 * Top-N same-sector peers by (static) market-cap proxy — computed WITHOUT creating engine quotes for the whole sector,
 * so only the returned handful need `engine.touch()`.
 */
export function peerCandidates(instruments: Instrument[] | null | undefined, symbol: string, sector: string, n = 5): Instrument[] {
  if (!Array.isArray(instruments)) return [];
  const scored: { i: Instrument; cap: number }[] = [];
  for (const i of instruments) {
    if (i.symbol === symbol || (i.sector ?? 'Others') !== sector) continue;
    scored.push({ i, cap: basePrice(i.symbol) * sharesCr(i.symbol) });
  }
  scored.sort((a, b) => b.cap - a.cap || (a.i.symbol < b.i.symbol ? -1 : 1));
  return scored.slice(0, n).map((x) => x.i);
}
