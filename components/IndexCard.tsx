import { TickPriceFlash } from './TickPriceFlash';
import type { IndexQuote } from '@/lib/types';
import { fmt, fmtPct, fmtSigned, tone } from '@/lib/format';

export function IndexCard({ ix, onOpen }: { ix: IndexQuote; onOpen?: (id: string) => void }) {
  const dir = ix.pct > 0 ? '▲' : ix.pct < 0 ? '▼' : '■';
  return (
    <button type="button" onClick={() => onOpen?.(ix.id)} aria-label={`Open ${ix.label} chart`} className="flex min-w-[148px] shrink-0 flex-col justify-center border-r border-line px-3 py-1 text-left last:border-r-0 hover:bg-line/40">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{ix.label}</span>
        <span className={`text-[8px] ${tone(ix.pct)}`}>{dir}</span>
      </div>
      <div className="num flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-ink">{ix.loaded === false ? '—' : <TickPriceFlash value={ix.value}>{fmt(ix.value)}</TickPriceFlash>}</span>
        <span className={`text-[11px] ${tone(ix.pct)}`}>{ix.loaded === false ? 'loading' : `${fmtSigned(ix.change)} (${fmtPct(ix.pct)})`}</span>
      </div>
    </button>
  );
}
