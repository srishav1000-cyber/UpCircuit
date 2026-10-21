// Policy limit and circuit breach monitor.
// Each rule compares an actual exposure with a user-set limit:
//   status = breach when actual > limit · near when actual ≥ 90 % of limit · pass otherwise.
// Rules: largest single stock % of portfolio · largest sector % · HHI (sector, points) · circuit exposure = % of portfolio value sitting in
// holdings that are locked at, or within 1.5 % of, a price limit.

export type LimitId = 'stock' | 'sector' | 'hhi' | 'circuit';
export type LimitStatus = 'pass' | 'near' | 'breach';

export interface Limits {
  stock: number;
  sector: number;
  hhi: number;
  circuit: number;
}

export const DEFAULT_LIMITS: Limits = { stock: 20, sector: 40, hhi: 2500, circuit: 20 };
export const NEAR_FRACTION = 0.9;

export interface LimitInputs {
  /** per holding market value (₹), with the sector label, and whether it is at / near a circuit limit */
  positions: { symbol: string; sector: string; value: number; nearCircuit: boolean }[];
}

export interface LimitRow {
  id: LimitId;
  label: string;
  unit: '%' | 'pts';
  limit: number;
  actual: number;
  status: LimitStatus;
  detail: string;
}

export function statusOf(actual: number, limit: number): LimitStatus {
  return actual > limit ? 'breach' : actual >= limit * NEAR_FRACTION ? 'near' : 'pass';
}

export function sanitiseLimits(x: unknown): Limits {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<Record<LimitId, unknown>>;
  const pick = (k: LimitId, lo: number, hi: number) => (typeof o[k] === 'number' && Number.isFinite(o[k] as number) && (o[k] as number) >= lo && (o[k] as number) <= hi ? (o[k] as number) : DEFAULT_LIMITS[k]);
  return { stock: pick('stock', 1, 100), sector: pick('sector', 1, 100), hhi: pick('hhi', 100, 10000), circuit: pick('circuit', 1, 100) };
}

export function evaluateLimits(inp: LimitInputs, limits: Limits): LimitRow[] | null {
  const pos = inp.positions.filter((p) => p.value > 0 && Number.isFinite(p.value));
  const total = pos.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return null;
  const top = [...pos].sort((a, b) => b.value - a.value)[0];
  const by = new Map<string, number>();
  for (const p of pos) by.set(p.sector || 'Others', (by.get(p.sector || 'Others') ?? 0) + p.value);
  const topSec = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  const hhi = [...by.values()].reduce((a, v) => a + ((v / total) * 100) ** 2, 0);
  const circ = pos.filter((p) => p.nearCircuit);
  const circPct = (circ.reduce((a, p) => a + p.value, 0) / total) * 100;
  const stockPct = (top.value / total) * 100;
  const secPct = (topSec[1] / total) * 100;
  return [
    { id: 'stock', label: 'Largest single stock', unit: '%', limit: limits.stock, actual: stockPct, status: statusOf(stockPct, limits.stock), detail: top.symbol },
    { id: 'sector', label: 'Largest sector', unit: '%', limit: limits.sector, actual: secPct, status: statusOf(secPct, limits.sector), detail: topSec[0] },
    { id: 'hhi', label: 'Sector concentration (HHI)', unit: 'pts', limit: limits.hhi, actual: hhi, status: statusOf(hhi, limits.hhi), detail: `${by.size} sector${by.size === 1 ? '' : 's'}` },
    { id: 'circuit', label: 'Circuit exposure', unit: '%', limit: limits.circuit, actual: circPct, status: statusOf(circPct, limits.circuit), detail: circ.length ? circ.map((p) => p.symbol).join(', ') : 'none at a limit' },
  ];
}

export interface BreachEntry {
  ts: number;
  day: string;
  id: LimitId;
  actual: number;
  limit: number;
}

/** One log row per rule per day (re-breaching the same day updates nothing); returns the new log and whether anything was added. */
export function logBreaches(log: BreachEntry[], rows: LimitRow[], now: number, day: string, keep = 100): { log: BreachEntry[]; added: BreachEntry[] } {
  const added: BreachEntry[] = [];
  for (const r of rows) {
    if (r.status !== 'breach') continue;
    if (log.some((e) => e.day === day && e.id === r.id) || added.some((e) => e.id === r.id)) continue;
    added.push({ ts: now, day, id: r.id, actual: r.actual, limit: r.limit });
  }
  return { log: [...added, ...log].slice(0, keep), added };
}
