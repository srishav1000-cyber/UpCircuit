// Portfolio concentration (HHI on sector weights) and deterministic ₹ macro-shock scenarios.
//
// HHI = Σ sᵢ², with sᵢ = sector weight in PERCENT (0–100) → range 0…10 000.
// Bands: < 1 500 diversified (green) · 1 500–2 500 moderate (yellow) · > 2 500 high (red).
//
// SHOCK FACTORS ARE ILLUSTRATIVE, NOT FORECASTS. They are fixed sector sensitivities (a stress-test convention), not
// estimated from data, and they are the single place to edit if your risk team uses different numbers. ΔValue = Σ Valueⱼ × Shockⱼ.

export interface Position {
  symbol: string;
  sector: string;
  /** current market value in ₹ (qty × LTP) */
  value: number;
}

export interface SectorWeight {
  sector: string;
  value: number;
  weightPct: number;
}

export type HhiZone = 'green' | 'yellow' | 'red';
export interface HhiBand {
  zone: HhiZone;
  label: 'Diversified' | 'Moderate concentration' | 'High concentration';
}

export const HHI_MODERATE = 1500;
export const HHI_HIGH = 2500;

export function sectorWeights(positions: Position[]): SectorWeight[] {
  const by = new Map<string, number>();
  for (const p of positions) if (p.value > 0 && Number.isFinite(p.value)) by.set(p.sector || 'Others', (by.get(p.sector || 'Others') ?? 0) + p.value);
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  return [...by.entries()].map(([sector, value]) => ({ sector, value, weightPct: (value / total) * 100 })).sort((a, b) => b.value - a.value);
}

/** Σ sᵢ² on percent weights. Empty / zero input → 0. */
export function hhiPct(weightsPct: number[]): number {
  return weightsPct.reduce((a, s) => a + (Number.isFinite(s) && s > 0 ? s * s : 0), 0);
}

export function hhiBand(h: number): HhiBand {
  if (h > HHI_HIGH) return { zone: 'red', label: 'High concentration' };
  if (h >= HHI_MODERATE) return { zone: 'yellow', label: 'Moderate concentration' };
  return { zone: 'green', label: 'Diversified' };
}

export const sectorHhi = (positions: Position[]): number => hhiPct(sectorWeights(positions).map((w) => w.weightPct));

/* ───────────── scenarios ───────────── */

export type ScenarioId = 'rate50' | 'rate100' | 'crash3' | 'crash5' | 'crash10' | 'crude15';
export interface Scenario {
  id: ScenarioId;
  label: string;
  group: 'Rates' | 'Equity crash' | 'Commodity';
  note: string;
}

export const SCENARIOS: Scenario[] = [
  { id: 'rate50', label: 'RBI hike +50 bps', group: 'Rates', note: 'half of the +100 bps sector shock' },
  { id: 'rate100', label: 'RBI hike +100 bps', group: 'Rates', note: 'Banking/NBFC −1.8%, Realty −3.2%, IT −0.5% …' },
  { id: 'crash3', label: 'Nifty −3%', group: 'Equity crash', note: 'sector β × −3%' },
  { id: 'crash5', label: 'Nifty −5%', group: 'Equity crash', note: 'sector β × −5%' },
  { id: 'crash10', label: 'Nifty −10%', group: 'Equity crash', note: 'sector β × −10%' },
  { id: 'crude15', label: 'Crude oil +15%', group: 'Commodity', note: 'Paints/Aviation −4.5%, Energy/Upstream +3.2%' },
];

/** % price impact of a +100 bps policy-rate hike, by sector (illustrative). */
export const RATE_100BPS_PCT: Record<string, number> = {
  Banking: -1.8, Financials: -1.8, Realty: -3.2, IT: -0.5, Auto: -1.5, Infra: -2.0, Cement: -1.2, Consumer: -0.8,
  FMCG: -0.4, Pharma: -0.3, Metals: -1.0, Energy: -0.6, Telecom: -0.9, Chemicals: -0.8, Others: -1.0,
};
/** Sector beta to the Nifty 50 (illustrative). */
export const SECTOR_BETA: Record<string, number> = {
  Banking: 1.15, Financials: 1.25, IT: 0.85, Energy: 1.0, Auto: 1.1, FMCG: 0.6, Pharma: 0.7, Metals: 1.4, Infra: 1.2,
  Telecom: 0.8, Consumer: 0.9, Cement: 1.0, Realty: 1.5, Chemicals: 1.0, Others: 1.0,
};
/** % price impact of crude +15%, by sector (illustrative). */
export const CRUDE_15_PCT: Record<string, number> = {
  Energy: 3.2, Auto: -1.5, Chemicals: -2.0, Consumer: -1.0, Cement: -1.2, Metals: -0.5, Infra: -0.5, Others: -1.0,
  Banking: -0.3, Financials: -0.3, IT: 0, FMCG: -0.6, Pharma: -0.3, Telecom: -0.2, Realty: -0.4,
};
/** Name-level overrides where the sector bucket is too coarse. */
export const CRUDE_SYMBOL_PCT: Record<string, number> = {
  ASIANPAINT: -4.5, BERGEPAINT: -4.5, KANSAINER: -4.5, INDIGO: -4.5, SPICEJET: -4.5,
  ONGC: 3.2, OIL: 3.2, BPCL: -3, IOC: -3, HINDPETRO: -3,
};

const CRASH: Partial<Record<ScenarioId, number>> = { crash3: -3, crash5: -5, crash10: -10 };

/** Fractional price shock (−0.018 = −1.8 %) for a position under a scenario. */
export function shockFactor(id: ScenarioId, sector: string, symbol = ''): number {
  const sec = sector in RATE_100BPS_PCT ? sector : 'Others';
  switch (id) {
    case 'rate100': return RATE_100BPS_PCT[sec] / 100;
    case 'rate50': return RATE_100BPS_PCT[sec] / 200;
    case 'crude15': return (CRUDE_SYMBOL_PCT[symbol.toUpperCase()] ?? CRUDE_15_PCT[sec]) / 100;
    default: return ((CRASH[id] ?? 0) * SECTOR_BETA[sec]) / 100;
  }
}

export interface ScenarioResult {
  id: ScenarioId;
  label: string;
  group: Scenario['group'];
  /** ΔValue in ₹ (negative = loss) */
  delta: number;
  deltaPct: number;
  /** biggest contributor to the loss (or gain when nothing loses) */
  worst: { sector: string; delta: number } | null;
}

export function runScenario(positions: Position[], s: Scenario): ScenarioResult {
  const total = positions.reduce((a, p) => a + (p.value > 0 ? p.value : 0), 0);
  const bySector = new Map<string, number>();
  let delta = 0;
  for (const p of positions) {
    if (!(p.value > 0)) continue;
    const d = p.value * shockFactor(s.id, p.sector, p.symbol);
    delta += d;
    bySector.set(p.sector || 'Others', (bySector.get(p.sector || 'Others') ?? 0) + d);
  }
  const ranked = [...bySector.entries()].sort((a, b) => a[1] - b[1]);
  const w = ranked.length ? ranked[0] : null;
  return { id: s.id, label: s.label, group: s.group, delta, deltaPct: total > 0 ? (delta / total) * 100 : 0, worst: w ? { sector: w[0], delta: w[1] } : null };
}

export const runAllScenarios = (positions: Position[]): ScenarioResult[] => SCENARIOS.map((s) => runScenario(positions, s));
