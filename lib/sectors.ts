// Sector performance: live 1D % aggregated over the stocks the engine has real quotes for.
// The nine desks of the heatmap are derived from the master's `sector` field; "PSU Bank" is split out of Banking by ticker.
export type SectorId = 'bank' | 'it' | 'auto' | 'pharma' | 'fmcg' | 'metal' | 'energy' | 'realty' | 'psubank';
export const SECTORS: { id: SectorId; label: string }[] = [
  { id: 'bank', label: 'Bank' },
  { id: 'it', label: 'IT' },
  { id: 'auto', label: 'Auto' },
  { id: 'pharma', label: 'Pharma' },
  { id: 'fmcg', label: 'FMCG' },
  { id: 'metal', label: 'Metal' },
  { id: 'energy', label: 'Energy' },
  { id: 'realty', label: 'Realty' },
  { id: 'psubank', label: 'PSU Bank' },
];

export const PSU_BANKS = new Set(['SBIN', 'BANKBARODA', 'PNB', 'CANBK', 'UNIONBANK', 'INDIANB', 'BANKINDIA', 'UCOBANK', 'CENTRALBK', 'IOB', 'MAHABANK', 'PSB']);
const BY_MASTER_SECTOR: Record<string, SectorId> = { it: 'it', auto: 'auto', pharma: 'pharma', fmcg: 'fmcg', metals: 'metal', metal: 'metal', energy: 'energy', realty: 'realty' };

/** which heatmap desk a stock belongs to (null → not part of the nine) */
export function sectorOf(symbol: string, masterSector: string | undefined): SectorId | null {
  const k = (masterSector ?? '').trim().toLowerCase();
  if (k === 'banking' || k === 'bank') return PSU_BANKS.has(symbol) ? 'psubank' : 'bank';
  return BY_MASTER_SECTOR[k] ?? null;
}

export type HeatBand = 'deep-red' | 'light-red' | 'light-green' | 'deep-green' | 'none';
/** < −2 deep red · −2…0 light red · 0…+2 light green · > +2 deep green */
export function heatBand(avgPct: number | null): HeatBand {
  if (avgPct === null || !Number.isFinite(avgPct)) return 'none';
  if (avgPct < -2) return 'deep-red';
  if (avgPct < 0) return 'light-red';
  if (avgPct <= 2) return 'light-green';
  return 'deep-green';
}

export interface SectorStat { id: SectorId; label: string; avgPct: number | null; gainers: number; losers: number; unchanged: number; count: number; band: HeatBand; symbols: string[] }

export function aggregateSectors(rows: Iterable<{ symbol: string; sector?: string; pct: number }>): SectorStat[] {
  const acc = new Map<SectorId, { sum: number; g: number; l: number; u: number; symbols: string[] }>();
  for (const r of rows) {
    if (!Number.isFinite(r.pct)) continue;
    const id = sectorOf(r.symbol, r.sector);
    if (!id) continue;
    const a = acc.get(id) ?? { sum: 0, g: 0, l: 0, u: 0, symbols: [] };
    a.sum += r.pct;
    if (r.pct > 0) a.g++; else if (r.pct < 0) a.l++; else a.u++;
    a.symbols.push(r.symbol);
    acc.set(id, a);
  }
  return SECTORS.map(({ id, label }) => {
    const a = acc.get(id);
    const count = a ? a.symbols.length : 0;
    // rounded to the 0.01 % the tile displays, so a −0.004 % average reads (and colours) as 0.00 % instead of "−0.00 %"
    const avgPct = a && count ? Math.round((a.sum / count) * 100) / 100 + 0 : null;
    return { id, label, avgPct, gainers: a?.g ?? 0, losers: a?.l ?? 0, unchanged: a?.u ?? 0, count, band: heatBand(avgPct), symbols: a?.symbols ?? [] };
  });
}
