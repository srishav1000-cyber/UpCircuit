'use client';

import { C, alpha } from '@/lib/theme';

/** Dependency-free SVG charts that follow the theme tokens (see lib/theme.ts). viewBox-based, so they never overflow. */

export const PALETTE = [C.accent, C.up, C.warn, C.down, alpha('accent', 0.55), alpha('up', 0.55), alpha('warn', 0.55), alpha('muted', 0.75)];

export interface Slice {
  label: string;
  value: number;
  color?: string;
}

/** Donut with a legend; the biggest `max` slices are shown, the rest roll into "Others". */
export function Donut({ slices, max = 7, centre, sub }: { slices: Slice[]; max?: number; centre?: string; sub?: string }) {
  const sorted = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, max);
  const rest = sorted.slice(max).reduce((a, s) => a + s.value, 0);
  const data = rest > 0 ? [...head, { label: 'Others', value: rest }] : head;
  const total = data.reduce((a, s) => a + s.value, 0) || 1;
  const R = 42;
  const CIRC = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row">
      <svg viewBox="0 0 120 120" className="h-36 w-36 shrink-0" role="img" aria-label="Allocation donut chart">
        <circle cx="60" cy="60" r={R} fill="none" style={{ stroke: C.line }} strokeWidth="16" />
        {data.map((s, i) => {
          const len = (s.value / total) * CIRC;
          const el = (
            <circle
              key={s.label}
              cx="60"
              cy="60"
              r={R}
              fill="none"
              strokeWidth="16"
              strokeDasharray={`${Math.max(0, len - 0.8)} ${CIRC - Math.max(0, len - 0.8)}`}
              strokeDashoffset={-acc}
              transform="rotate(-90 60 60)"
              style={{ stroke: s.color ?? PALETTE[i % PALETTE.length] }}
            >
              <title>{`${s.label}: ${((s.value / total) * 100).toFixed(1)}%`}</title>
            </circle>
          );
          acc += len;
          return el;
        })}
        {centre && (
          <text x="60" y={sub ? 58 : 64} textAnchor="middle" className="num" style={{ fill: C.ink, fontSize: 13, fontWeight: 700 }}>
            {centre}
          </text>
        )}
        {sub && (
          <text x="60" y="72" textAnchor="middle" style={{ fill: C.muted, fontSize: 7 }}>
            {sub}
          </text>
        )}
      </svg>
      <ul className="num grid min-w-0 flex-1 grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-1">
        {data.map((s, i) => (
          <li key={s.label} className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color ?? PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0 flex-1 truncate text-ink">{s.label}</span>
            <span className="text-muted">{((s.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface Series {
  name: string;
  color: string;
  data: number[];
}

/** Multi-line chart sharing one x index (e.g. cumulative % return of portfolio vs benchmark). */
export function LineChart({ series, height = 150, unit = '%', xLabels }: { series: Series[]; height?: number; unit?: string; xLabels?: [string, string] }) {
  const W = 320;
  const padL = 30;
  const padR = 6;
  const padT = 8;
  const padB = 14;
  const all = series.flatMap((s) => s.data).filter(Number.isFinite);
  if (all.length < 2) return <div style={{ height }} className="flex items-center justify-center text-[12px] text-muted">Not enough data</div>;
  let lo = Math.min(...all, 0);
  let hi = Math.max(...all, 0);
  if (hi - lo < 1e-6) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const n = Math.max(...series.map((s) => s.data.length));
  const x = (i: number, len: number) => padL + (i / Math.max(1, len - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height: 'auto', aspectRatio: `${W} / ${height}` }} role="img" aria-label={series.map((s) => s.name).join(' vs ')}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} style={{ stroke: C.line }} strokeWidth="0.6" />
          <text x={padL - 3} y={y(t) + 3} textAnchor="end" style={{ fill: C.muted, fontSize: 8 }} className="num">{t.toFixed(0)}{unit}</text>
        </g>
      ))}
      <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} style={{ stroke: C.muted }} strokeWidth="0.6" strokeDasharray="2 2" />
      {series.map((s) => (
        <polyline key={s.name} fill="none" strokeWidth="1.6" strokeLinejoin="round" style={{ stroke: s.color }} points={s.data.map((v, i) => `${x(i, s.data.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
      ))}
      {xLabels && (
        <>
          <text x={padL} y={height - 2} style={{ fill: C.muted, fontSize: 8 }}>{xLabels[0]}</text>
          <text x={W - padR} y={height - 2} textAnchor="end" style={{ fill: C.muted, fontSize: 8 }}>{xLabels[1]}</text>
        </>
      )}
      <title>{`${n} points`}</title>
    </svg>
  );
}

export interface Bar {
  label: string;
  value: number;
  color?: string;
  title?: string;
}

/** Vertical bars. `showEvery` thins out the x labels for dense histograms. */
export function BarChart({ bars, height = 120, showEvery = 1, fmtValue }: { bars: Bar[]; height?: number; showEvery?: number; fmtValue?: (n: number) => string }) {
  const W = 320;
  const padB = 14;
  const padT = 10;
  const max = Math.max(1e-9, ...bars.map((b) => b.value));
  const bw = W / bars.length;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height: 'auto', aspectRatio: `${W} / ${height}` }} role="img" aria-label="Bar chart">
      <line x1="0" x2={W} y1={height - padB} y2={height - padB} style={{ stroke: C.line }} strokeWidth="0.8" />
      {bars.map((b, i) => {
        const h = (b.value / max) * (height - padB - padT);
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.14} y={height - padB - h} width={bw * 0.72} height={Math.max(h, b.value > 0 ? 1 : 0)} rx="1.5" style={{ fill: b.color ?? C.accent }}>
              <title>{b.title ?? `${b.label}: ${fmtValue ? fmtValue(b.value) : b.value.toFixed(0)}`}</title>
            </rect>
            {i % showEvery === 0 && (
              <text x={i * bw + bw / 2} y={height - 3} textAnchor="middle" style={{ fill: C.muted, fontSize: 7.5 }}>{b.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Filled area chart with min / max labels (aggregated market-cap trend etc.). */
export function AreaChart({ data, height = 130, fmtY, xLabels }: { data: number[]; height?: number; fmtY?: (n: number) => string; xLabels?: [string, string] }) {
  const W = 320;
  const padL = 44;
  const padR = 6;
  const padT = 8;
  const padB = 14;
  if (data.length < 2) return <div style={{ height }} />;
  let lo = Math.min(...data);
  let hi = Math.max(...data);
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  const x = (i: number) => padL + (i / (data.length - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);
  const up = data[data.length - 1] >= data[0];
  const col = up ? C.up : C.down;
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const f = fmtY ?? ((n: number) => n.toFixed(0));
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height: 'auto', aspectRatio: `${W} / ${height}` }} role="img" aria-label="Area chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} style={{ stroke: C.line }} strokeWidth="0.6" />
          <text x={padL - 3} y={y(t) + 3} textAnchor="end" style={{ fill: C.muted, fontSize: 8 }} className="num">{f(t)}</text>
        </g>
      ))}
      <polygon points={`${x(0)},${height - padB} ${pts.join(' ')} ${x(data.length - 1)},${height - padB}`} style={{ fill: col, opacity: 0.16 }} />
      <polyline points={pts.join(' ')} fill="none" strokeWidth="1.7" strokeLinejoin="round" style={{ stroke: col }} />
      {xLabels && (
        <>
          <text x={padL} y={height - 2} style={{ fill: C.muted, fontSize: 8 }}>{xLabels[0]}</text>
          <text x={W - padR} y={height - 2} textAnchor="end" style={{ fill: C.muted, fontSize: 8 }}>{xLabels[1]}</text>
        </>
      )}
    </svg>
  );
}

/** Semicircle gauge. `zones` are on the value scale; the needle sits at `value`. */
export function Gauge({ value, min = 0, max = 100, zones, label, sub }: { value: number; min?: number; max?: number; zones: { to: number; color: string }[]; label: string; sub?: string }) {
  const cx = 100;
  const cy = 92;
  const r = 74;
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min)));
  const pt = (f: number, rad = r) => [cx + rad * Math.cos(Math.PI * (1 - f)), cy - rad * Math.sin(Math.PI * (1 - f))];
  let prev = min;
  const arcs = zones.map((z) => {
    const [x1, y1] = pt(frac(prev));
    const [x2, y2] = pt(frac(z.to));
    prev = z.to;
    return { d: `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`, color: z.color };
  });
  const [nx, ny] = pt(frac(value), r - 10);
  return (
    <svg viewBox="0 0 200 112" className="mx-auto w-full max-w-[260px]" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}>
      {arcs.map((a, i) => (
        <path key={i} d={a.d} fill="none" strokeWidth="14" style={{ stroke: a.color }} />
      ))}
      <line x1={cx} y1={cy} x2={nx} y2={ny} strokeWidth="2.5" strokeLinecap="round" style={{ stroke: C.ink }} />
      <circle cx={cx} cy={cy} r="4.5" style={{ fill: C.ink }} />
      <text x={cx} y={cy + 17} textAnchor="middle" className="num" style={{ fill: C.ink, fontSize: 15, fontWeight: 700 }}>{label}</text>
      {sub && <text x={cx} y={cy + 28} textAnchor="middle" style={{ fill: C.muted, fontSize: 8 }}>{sub}</text>}
      <text x={cx - r} y={cy + 12} textAnchor="middle" style={{ fill: C.muted, fontSize: 8 }}>{min}</text>
      <text x={cx + r} y={cy + 12} textAnchor="middle" style={{ fill: C.muted, fontSize: 8 }}>{max}</text>
    </svg>
  );
}

/** Price line with VWAP and ±kσ bands (day-trader card). */
export function BandChart({ price, vwap, upper, lower, upper1, lower1, height = 120 }: { price: number[]; vwap: number; upper: number; lower: number; upper1?: number; lower1?: number; height?: number }) {
  const W = 320;
  const padL = 44;
  const padR = 6;
  const padT = 8;
  const padB = 8;
  if (price.length < 2) return <div style={{ height }} className="flex items-center justify-center text-[12px] text-muted">Collecting trades…</div>;
  let lo = Math.min(lower, ...price);
  let hi = Math.max(upper, ...price);
  const pad = (hi - lo) * 0.1 || 0.1;
  lo -= pad;
  hi += pad;
  const x = (i: number) => padL + (i / (price.length - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);
  const line = (v: number, col: string, dash?: string) => (
    <g key={col + v}>
      <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} strokeWidth="1" strokeDasharray={dash} style={{ stroke: col }} />
      <text x={padL - 3} y={y(v) + 3} textAnchor="end" className="num" style={{ fill: col, fontSize: 8 }}>{v.toFixed(2)}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height: 'auto', aspectRatio: `${W} / ${height}` }} role="img" aria-label="Price with VWAP bands">
      <rect x={padL} y={y(upper)} width={W - padL - padR} height={Math.max(0, y(lower) - y(upper))} style={{ fill: C.accent, opacity: 0.07 }} />
      {line(upper, C.down, '3 2')}
      {upper1 !== undefined && line(upper1, C.down, '1 3')}
      {lower1 !== undefined && line(lower1, C.up, '1 3')}
      {line(vwap, C.warn)}
      {line(lower, C.up, '3 2')}
      <polyline fill="none" strokeWidth="1.5" strokeLinejoin="round" style={{ stroke: C.ink }} points={price.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
    </svg>
  );
}

/** Responsive card grid used by every persona: 1 col in the narrow terminal side-pane, 2 cols when the pane is wide. */
/** minmax(0,1fr) columns: wide children (matrices, tables) scroll inside their card instead of stretching the grid */
export const CARD_GRID =
  'grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[repeat(2,minmax(0,1fr))] lg:grid-cols-[minmax(0,1fr)] min-[1900px]:grid-cols-[repeat(2,minmax(0,1fr))] [.fs_&]:lg:grid-cols-[repeat(2,minmax(0,1fr))] [.fs_&]:min-[1400px]:grid-cols-[repeat(3,minmax(0,1fr))]';
/** spans the full row; `.fs` is set on the full-screen dashboard container (see app/page.tsx) */
export const WIDE = 'md:col-span-2 lg:col-span-1 min-[1900px]:col-span-2 [.fs_&]:lg:col-span-2 [.fs_&]:min-[1400px]:col-span-3';
