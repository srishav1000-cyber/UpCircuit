import type { Fundamentals, Quote } from './types';
import { hashStr, mulberry32 } from './market';

/**
 * Screener.in-style ratios. SIMULATED: Screener.in has no public API and its terms don't permit scraping,
 * so ratios are generated per symbol, sector-aware and internally consistent (EPS is fixed, P/E moves with the
 * live price, book value = EPS ÷ ROE). To use real data, replace `getFundamentals` with a call to a licensed
 * source (exchange filings or a data vendor) that returns the same `Fundamentals` shape.
 */

interface Profile {
  pe: [number, number];
  roe: [number, number];
  de: [number, number] | null;
  promoter: [number, number];
}

const PROFILES: Record<string, Profile> = {
  Banking: { pe: [8, 22], roe: [9, 18], de: null, promoter: [0, 75] },
  IT: { pe: [18, 38], roe: [18, 38], de: [0, 0.15], promoter: [30, 75] },
  Energy: { pe: [6, 18], roe: [8, 20], de: [0.3, 1.5], promoter: [40, 75] },
  Auto: { pe: [14, 40], roe: [12, 28], de: [0, 0.8], promoter: [30, 70] },
  FMCG: { pe: [30, 70], roe: [20, 60], de: [0, 0.3], promoter: [40, 75] },
  Pharma: { pe: [20, 45], roe: [12, 25], de: [0, 0.6], promoter: [30, 75] },
  Metals: { pe: [6, 16], roe: [8, 24], de: [0.3, 1.3], promoter: [30, 75] },
  Financials: { pe: [12, 35], roe: [10, 22], de: null, promoter: [20, 75] },
  Infra: { pe: [18, 50], roe: [10, 24], de: [0.2, 1.8], promoter: [25, 70] },
  Telecom: { pe: [15, 60], roe: [6, 22], de: [0.3, 2], promoter: [30, 75] },
  Consumer: { pe: [30, 90], roe: [10, 30], de: [0, 0.8], promoter: [20, 75] },
  Cement: { pe: [18, 40], roe: [8, 18], de: [0, 0.6], promoter: [45, 75] },
  Realty: { pe: [25, 60], roe: [8, 20], de: [0.3, 1.5], promoter: [40, 75] },
  Chemicals: { pe: [20, 55], roe: [10, 24], de: [0, 0.8], promoter: [30, 75] },
  Others: { pe: [10, 40], roe: [8, 22], de: [0, 1.2], promoter: [20, 75] },
};

export const sectorProfile = (sector: string): Profile => PROFILES[sector] ?? PROFILES.Others;
/** Mid-point P/E typical for the sector — used for premium / discount commentary. */
export const sectorTypicalPe = (sector: string): number => {
  const [a, b] = sectorProfile(sector).pe;
  return Math.round((a + b) / 2);
};

const lerp = ([a, b]: [number, number], r: number) => a + (b - a) * r;
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

export function getFundamentals(q: Pick<Quote, 'symbol' | 'sector' | 'ltp' | 'prevClose' | 'mcapCr' | 'dividendYield'>): Fundamentals {
  const p = sectorProfile(q.sector);
  const r = mulberry32(hashStr(q.symbol + ':fund'));
  const pe0 = lerp(p.pe, r());
  const roe = lerp(p.roe, r());
  const roce = roe * (0.85 + r() * 0.5);
  const de = p.de ? lerp(p.de, r()) : null;
  const promoter = lerp(p.promoter, r());
  const eps = q.prevClose / pe0; // fixed fundamental; P/E floats with the live price
  return {
    marketCapCr: q.mcapCr,
    pe: round(q.ltp / eps, 1),
    bookValue: round(eps / (roe / 100)),
    dividendYield: q.dividendYield,
    roce: round(roce, 1),
    roe: round(roe, 1),
    debtToEquity: de === null ? null : round(de),
    promoterHolding: round(promoter, 1),
    eps: round(eps),
  };
}

export type Tone = 'good' | 'ok' | 'bad' | 'na';
/** Screener-style traffic lights for each ratio. */
export function ratioTone(key: keyof Fundamentals, f: Fundamentals, sector: string): Tone {
  switch (key) {
    case 'roce':
      return f.roce >= 15 ? 'good' : f.roce >= 10 ? 'ok' : 'bad';
    case 'roe':
      return f.roe >= 15 ? 'good' : f.roe >= 10 ? 'ok' : 'bad';
    case 'debtToEquity':
      return f.debtToEquity === null ? 'na' : f.debtToEquity <= 0.5 ? 'good' : f.debtToEquity <= 1 ? 'ok' : 'bad';
    case 'pe': {
      const t = sectorTypicalPe(sector);
      return f.pe <= t * 0.85 ? 'good' : f.pe <= t * 1.3 ? 'ok' : 'bad';
    }
    case 'promoterHolding':
      return f.promoterHolding >= 50 ? 'good' : f.promoterHolding >= 25 ? 'ok' : 'bad';
    case 'dividendYield':
      return f.dividendYield >= 2 ? 'good' : f.dividendYield >= 0.5 ? 'ok' : 'na';
    default:
      return 'na';
  }
}
