import type { ReactNode } from 'react';
import { C, alpha } from '@/lib/theme';
import { DataBadges } from './DataBadge';
import type { SourceKind } from '@/lib/methodology';

export function Card({ title, right, children, className = '', badges }: { title?: string; right?: ReactNode; children: ReactNode; className?: string; badges?: SourceKind[] }) {
  return (
    <section className={`rounded-md border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h3 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold uppercase tracking-wider text-muted"><span>{title}</span>{badges && <DataBadges kinds={badges} />}</h3>
          {right}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, valueClass = 'text-ink', hint }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string; hint?: string }) {
  return (
    <div className="rounded border border-line bg-bg px-3 py-2" title={hint}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`num mt-0.5 text-lg font-semibold leading-tight ${valueClass}`}>{value}</div>
      {sub && <div className="num mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function Sparkline({ data, up, height = 48 }: { data: number[]; up?: boolean; height?: number }) {
  if (data.length < 2) return <div style={{ height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const w = 100;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(2)},${(height - 4 - ((v - min) / span) * (height - 8)).toFixed(2)}`);
  const isUp = up ?? data[data.length - 1] >= data[0];
  const color = isUp ? C.up : C.down;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="trend">
      <polygon points={`0,${height} ${pts.join(' ')} ${w},${height}`} style={{ fill: color, opacity: 0.12 }} />
      <polyline points={pts.join(' ')} style={{ fill: 'none', stroke: color }} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export const ZONE = {
  up: alpha('up', 0.6),
  down: alpha('down', 0.6),
  warn: alpha('warn', 0.6),
  muted: alpha('muted', 0.5),
};

/** Horizontal meter. `value` and the zones are on the same scale (min…max). */
export function Meter({ value, min = 0, max = 100, zones }: { value: number; min?: number; max?: number; zones: { to: number; color: string }[] }) {
  const pos = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  let prev = min;
  return (
    <div className="relative h-2 w-full rounded-full bg-line" role="meter" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}>
      <div className="flex h-full w-full overflow-hidden rounded-full">
        {zones.map((z, i) => {
          const w = ((z.to - prev) / (max - min)) * 100;
          prev = z.to;
          return <div key={i} style={{ width: `${w}%`, background: z.color }} />;
        })}
      </div>
      <div className="absolute top-[-2px] h-3 w-[3px] rounded bg-ink shadow" style={{ left: `calc(${pos}% - 1.5px)` }} />
    </div>
  );
}

export function Badge({ children, tone = 'muted', className = '' }: { children: ReactNode; tone?: 'up' | 'down' | 'warn' | 'accent' | 'muted'; className?: string }) {
  const cls = {
    up: 'bg-up/15 text-up',
    down: 'bg-down/15 text-down',
    warn: 'bg-warn/15 text-warn',
    accent: 'bg-accent/15 text-accent',
    muted: 'bg-line text-muted',
  }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls} ${className}`}>{children}</span>;
}

export const sentimentTone = (label: 'Bullish' | 'Bearish' | 'Neutral') => (label === 'Bullish' ? 'up' : label === 'Bearish' ? 'down' : 'muted');
