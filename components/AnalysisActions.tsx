'use client';

interface Props {
  symbol: string;
  watchlisted: boolean;
  activeAlerts: number;
  onDeepResearch: () => void;
  onToggleWatchlist: () => void;
  onSetAlert: () => void;
  /** when set, the watchlist button opens the Watchlist drawer instead of toggling this symbol */
  onOpenWatchlist?: () => void;
  /** which buttons to show; the research modal already *is* the research page, so it re-labels Deep Research (see `deepLabel`) */
  deepLabel?: string;
  /** full = text labels; icons = icon-only (labels in tooltip / aria); responsive = icons, short text from xl, full text from 2xl */
  variant?: 'full' | 'icons' | 'responsive';
  className?: string;
}

const base = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12px] font-semibold transition active:scale-95';

function Label({ icon, full, short, variant }: { icon: string; full: string; short: string; variant: NonNullable<Props['variant']> }) {
  return (
    <>
      <span aria-hidden>{icon}</span>
      {variant === 'full' && <span>{full}</span>}
      {variant === 'responsive' && (
        <>
          <span className="hidden min-[1600px]:inline">{full}</span>
          <span className="hidden min-[1400px]:inline min-[1600px]:hidden">{short}</span>
          <span className="sr-only min-[1400px]:hidden">{full}</span>
        </>
      )}
      {variant === 'icons' && <span className="sr-only">{full}</span>}
    </>
  );
}

/** Analytical action triggers shared by the Navbar, chart panel and research modal. No order placement anywhere. */
export function AnalysisActions({ symbol, watchlisted, activeAlerts, onDeepResearch, onToggleWatchlist, onSetAlert, onOpenWatchlist, deepLabel = 'Deep Research', variant = 'full', className = '' }: Props) {
  const iconOnly = variant !== 'full';
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`} role="group" aria-label={`Actions for ${symbol}`}>
      <button onClick={onDeepResearch} title={`${deepLabel} · ${symbol}`} data-testid="act-research" className={`${base} border-accent bg-accent/10 text-accent hover:bg-accent/20 ${iconOnly ? 'min-w-8' : ''}`}>
        <Label icon="🔍" full={deepLabel} short="Research" variant={variant} />
      </button>
      <button onClick={onOpenWatchlist ?? onToggleWatchlist} aria-pressed={watchlisted} title={onOpenWatchlist ? 'Open watchlist (W)' : watchlisted ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`} data-testid="act-watchlist" className={`${base} ${watchlisted ? 'border-warn/60 bg-warn/10 text-warn' : 'border-line text-ink hover:bg-line'} ${iconOnly ? 'min-w-8' : ''}`}>
        <Label icon="⭐" full={onOpenWatchlist ? 'Watchlist' : watchlisted ? 'In Watchlist' : 'Add to Watchlist'} short={onOpenWatchlist ? 'Watchlist' : watchlisted ? 'Watching' : 'Watchlist'} variant={variant} />
      </button>
      <button onClick={onSetAlert} title={`Set a price alert on ${symbol}`} data-testid="act-alert" className={`${base} relative border-line text-ink hover:bg-line ${iconOnly ? 'min-w-8' : ''}`}>
        <Label icon="🔔" full="Set Price Alert" short="Alert" variant={variant} />
        {activeAlerts > 0 && <span className="num rounded-full bg-accent px-1.5 text-[10px] font-bold leading-4 text-white" aria-label={`${activeAlerts} active alerts`}>{activeAlerts}</span>}
      </button>
    </div>
  );
}
