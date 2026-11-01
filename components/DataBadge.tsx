import type { SourceKind } from '@/lib/methodology';
import type { FeedMode } from '@/lib/market';
import { useEffect, useState } from 'react';
import { baselineLabel } from '@/lib/dataLabel';

const STYLE: Record<SourceKind, { label: string; cls: string; tip: string }> = {
  smartapi: { label: 'SmartAPI Live', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400', tip: 'Streamed from the exchange through Angel One SmartAPI' },
  yahoo: { label: 'Yahoo Delayed', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-400', tip: 'Yahoo Finance data, delayed and not tick-by-tick' },
  computed: { label: 'Computed Math', cls: 'border-blue-500/40 bg-blue-500/10 text-blue-400', tip: 'Calculated in the browser from the inputs above; formula in Methodology' },
  baseline: { label: 'EOD Historical Baseline', cls: 'border-blue-500/40 bg-blue-500/10 text-blue-400', tip: 'Risk statistics use 1Y end-of-day closes. In the NSE session (09:15–15:30 IST, Mon–Fri) live prices come from SmartAPI when the feed is live; if it is not, the header badge shows the delayed fallback.' },
  na: { label: 'N/A', cls: 'border-slate-600/60 bg-slate-500/10 text-slate-400', tip: 'Not available from the current feed; nothing is estimated' },
};

/** Inline provenance tag: [SmartAPI Live] · [Yahoo Delayed] · [Computed Math] · [N/A]. */
export function DataBadge({ kind, label }: { kind: SourceKind; label?: string }) {
  const s = STYLE[kind];
  const [now, setNow] = useState<number | null>(null); // client-only clock → no SSR/hydration mismatch
  useEffect(() => { if (kind !== 'baseline') return; setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, [kind]);
  if (kind === 'baseline') label = label ?? (now === null ? s.label : baselineLabel(now));
  return (
    <span data-testid={`badge-${kind}`} title={s.tip} className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border px-1 py-px text-[9px] font-semibold normal-case tracking-normal ${s.cls}`}>
      [{label ?? s.label}]
    </span>
  );
}

export function DataBadges({ kinds }: { kinds: SourceKind[] }) {
  return <span className="inline-flex flex-wrap items-center gap-1">{kinds.map((k) => <DataBadge key={k} kind={k} />)}</span>;
}

/** Live-stream-derived values are SmartAPI only while the feed is live; otherwise they come from Yahoo. */
export const liveKind = (mode: FeedMode): SourceKind => (mode === 'live' ? 'smartapi' : 'yahoo');
