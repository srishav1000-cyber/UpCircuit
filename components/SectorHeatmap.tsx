'use client';

import type { HeatBand, SectorId, SectorStat } from '@/lib/sectors';
import { fmtPct } from '@/lib/format';

const BAND: Record<HeatBand, { cls: string; label: string }> = {
  'deep-red': { cls: 'border-down bg-down text-white', label: 'Deep red · below −2%' },
  'light-red': { cls: 'border-down/40 bg-down/20 text-ink', label: 'Light red · −2% to 0%' },
  'light-green': { cls: 'border-up/40 bg-up/20 text-ink', label: 'Light green · 0% to +2%' },
  'deep-green': { cls: 'border-up bg-up text-white', label: 'Deep green · above +2%' },
  none: { cls: 'border-line bg-panel text-muted', label: 'Waiting for prices' },
};

interface Props {
  stats: SectorStat[];
  active: SectorId | null;
  /** click a tile to filter the discovery grid; click the active tile again to clear */
  onSelect: (id: SectorId | null) => void;
}

/** Sector performance heatmap: colour = equal-weighted average 1D change of the sector's stocks, plus gainers vs losers. */
export function SectorHeatmap({ stats, active, onSelect }: Props) {
  return (
    <section aria-label="Sector performance heatmap" data-testid="sector-heatmap" className="rounded-md border border-line bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold text-ink">Sector performance</h2>
        <span className="text-[10px] text-muted">avg 1D change · click a tile to filter the stocks below</span>
        {active && (
          <button onClick={() => onSelect(null)} data-testid="sector-clear" className="ml-auto rounded-full border border-line px-2.5 py-0.5 text-[11px] font-semibold text-muted hover:text-ink">
            Clear filter ✕
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {stats.map((s) => {
          const b = BAND[s.band];
          const on = active === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(on ? null : s.id)}
              aria-pressed={on}
              title={`${s.label}: ${b.label}`}
              data-testid={`sector-tile-${s.id}`}
              data-band={s.band}
              data-avg={s.avgPct === null ? '' : s.avgPct.toFixed(4)}
              className={`rounded-md border p-2 text-left transition-[background-color,color,box-shadow] duration-[250ms] ease-in-out ${b.cls} ${on ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg' : 'hover:brightness-110'}`}
            >
              <div className="truncate text-[11px] font-semibold opacity-90">{s.label}</div>
              <div className="num text-[17px] font-bold leading-tight">{s.avgPct === null ? 'N/A' : fmtPct(s.avgPct)}</div>
              <div className="num mt-0.5 flex items-center gap-2 text-[10px] opacity-90">
                <span title="Gainers">▲ {s.gainers}</span>
                <span title="Losers">▼ {s.losers}</span>
                <span className="ml-auto" title="Stocks priced">{s.count}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
