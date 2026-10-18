'use client';

import type { IndexQuote, Quote, Timeframe } from '@/lib/types';
import { fmt, fmtInt, fmtPct, fmtSigned, tone } from '@/lib/format';
import { AnalysisActions } from './AnalysisActions';
import { PriceChart } from './PriceChart';
import { Badge } from './ui';

interface Props {
  quote: Quote;
  tf: Timeframe;
  onTf: (tf: Timeframe) => void;
  /** 🔍 Deep Research → opens the research page */
  onResearch: () => void;
  /** ⭐ watchlist = favourites */
  favorite: boolean;
  onToggleFavorite: () => void;
  /** 🔔 Set Price Alert */
  onSetAlert: () => void;
  activeAlerts: number;
  /** when set, the workspace charts this index instead of `quote` (no watchlist / alert / research actions) */
  index?: IndexQuote | null;
  /** off-market only: ▶ Replay last session control (undefined = market open / live feed → hidden) */
  replay?: { active: boolean; real: boolean; progress: number; busy: boolean; onToggle: () => void };
}

export function ChartWorkspace({ quote, tf, onTf, onResearch, favorite, onToggleFavorite, onSetAlert, activeAlerts, index, replay }: Props) {
  if (index) return <IndexWorkspace index={index} tf={tf} onTf={onTf} />;
  const chg = quote.ltp - quote.prevClose;
  const pct = (chg / quote.prevClose) * 100;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* symbol strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-3 py-2">
        <button onClick={onToggleFavorite} aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'} className={`text-lg leading-none ${favorite ? 'text-warn' : 'text-muted hover:text-ink'}`}>
          {favorite ? '★' : '☆'}
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold text-ink">{quote.symbol}</span>
            <Badge>{quote.exch ?? 'NSE'} · EQ</Badge>
            <button onClick={onResearch} className="rounded border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent hover:bg-accent/10">
              Research ↗
            </button>
          </div>
          <div className="truncate text-[11px] text-muted">{quote.name}</div>
        </div>
        <div className="num flex items-baseline gap-2">
          <span className={`text-2xl font-semibold ${tone(chg)}`}>{fmt(quote.ltp)}</span>
          <span className={`text-[13px] ${tone(chg)}`}>
            {fmtSigned(chg)} ({fmtPct(pct)})
          </span>
        </div>
        {replay && (
          <button
            onClick={replay.onToggle}
            disabled={replay.busy}
            aria-pressed={replay.active}
            data-testid="session-replay"
            title={replay.active ? 'Stop the replay and return to the last close' : 'Market closed — replay the previous session of this stock at 1 minute per second (real exchange bars when available)'}
            className={`flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition disabled:cursor-wait disabled:opacity-60 ${replay.active ? 'border-warn/60 bg-warn/10 text-warn' : 'border-line text-ink hover:bg-line'}`}
          >
            <span aria-hidden>{replay.active ? '■' : '▶'}</span>
            {replay.active ? `Replaying ${replay.real ? 'real bars' : 'session'} · ${Math.round(replay.progress * 100)}%` : replay.busy ? 'Loading…' : 'Replay last session'}
          </button>
        )}
        <div className={`num ${replay ? '' : 'ml-auto'} hidden gap-4 text-[11px] text-muted lg:flex`}>
          <span>O <b className="text-ink">{fmt(quote.open)}</b></span>
          <span>H <b className="text-ink">{fmt(quote.high)}</b></span>
          <span>L <b className="text-ink">{fmt(quote.low)}</b></span>
          <span>PC <b className="text-ink">{fmt(quote.prevClose)}</b></span>
          <span>Vol <b className="text-ink">{fmtInt(quote.volume)}</b></span>
          <span title="Lower / upper circuit">Band <b className="text-ink">{fmt(quote.lowerCircuit)}–{fmt(quote.upperCircuit)}</b></span>
        </div>
      </div>

      <PriceChart symbol={quote.symbol} ltp={quote.ltp} volume={quote.volume} tf={tf} onTf={onTf} className="min-h-[520px] flex-1" />

      {/* analytical actions */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-panel px-3 py-2.5">
        <AnalysisActions symbol={quote.symbol} watchlisted={favorite} activeAlerts={activeAlerts} onDeepResearch={onResearch} onToggleWatchlist={onToggleFavorite} onSetAlert={onSetAlert} variant="full" />
        <p className="num ml-auto hidden text-[11px] text-muted md:block">
          Day range <b className="text-ink">{fmt(quote.low)}–{fmt(quote.high)}</b> · Circuit ±{quote.circuitBand}%
        </p>
      </div>
    </div>
  );
}

function IndexWorkspace({ index, tf, onTf }: { index: IndexQuote; tf: Timeframe; onTf: (tf: Timeframe) => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="index-workspace">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold text-ink">{index.label}</span>
            <Badge>INDEX</Badge>
          </div>
          <div className="truncate text-[11px] text-muted">Prices are synthesised for the chart — indices carry no volume or depth</div>
        </div>
        <div className="num flex items-baseline gap-2">
          <span className={`text-2xl font-semibold ${tone(index.change)}`}>{fmt(index.value)}</span>
          <span className={`text-[13px] ${tone(index.change)}`}>
            {fmtSigned(index.change)} ({fmtPct(index.pct)})
          </span>
        </div>
        <div className="num ml-auto hidden text-[11px] text-muted lg:flex">
          <span>PC <b className="text-ink">{fmt(index.prev)}</b></span>
        </div>
      </div>
      <PriceChart symbol={index.label} ltp={index.value} volume={0} tf={tf} onTf={onTf} className="min-h-[520px] flex-1" />
    </div>
  );
}
