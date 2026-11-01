'use client';

import { useMemo, useState } from 'react';
import { MIN_BARS, NET_BIAS, scan, type Bar, type Bias, type Group, type Signal } from '@/lib/chartScanner';

export const BIAS: Record<Bias, string> = { bullish: 'border-up/40 bg-up/10 text-up', bearish: 'border-down/40 bg-down/10 text-down', neutral: 'border-line bg-bg text-muted' };
const GROUPS: (Group | 'All')[] = ['All', 'Candlestick', 'Momentum & Trend', 'Breakout'];
const age = (a: number) => (a === 0 ? 'latest bar' : a === 1 ? '1 bar ago' : `${a} bars ago`);

/** Skill 01 · Scanner — pattern detections for the selected scrip (series comes from useDailyBars). */
export function ChartScanner({ series, err, live, stamp }: { series: Bar[] | null; err: string; live: boolean; stamp: number }) {
  const [group, setGroup] = useState<Group | 'All'>('All');
  const sigs: Signal[] = useMemo(() => (series ? scan(series) : []), [series]);
  const shown = group === 'All' ? sigs : sigs.filter((s) => s.group === group);
  return (
    <div data-testid="chart-scanner" data-count={sigs.length} data-net={NET_BIAS(sigs)}>
      <div className="mb-2 flex flex-wrap items-center gap-1" role="group" aria-label="Pattern group">
        {GROUPS.map((g) => <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)} data-testid={`scan-filter-${g.split(' ')[0].toLowerCase()}`} className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${group === g ? 'border-accent bg-accent/15 text-ink' : 'border-line text-muted hover:text-ink'}`}>{g}</button>)}
        {series && <span className={`ml-auto rounded border px-1.5 py-px text-[10px] font-bold uppercase ${BIAS[NET_BIAS(sigs)]}`} data-testid="scan-net">{sigs.length ? `net ${NET_BIAS(sigs)}` : 'no signals'}</span>}
      </div>
      {err ? <p className="py-3 text-center text-[12px] text-muted" data-testid="scan-na">N/A — {err}</p>
        : !series ? <p className="py-3 text-center text-[12px] text-muted">Loading daily history…</p>
        : series.length < MIN_BARS ? <p className="py-3 text-center text-[12px] text-muted" data-testid="scan-na">N/A — needs {MIN_BARS}+ daily bars (have {series.length}).</p>
        : shown.length === 0 ? <p className="py-3 text-center text-[12px] text-muted" data-testid="scan-none">No {group === 'All' ? '' : `${group.toLowerCase()} `}patterns completed in the last 3 daily bars.</p>
        : <ul className="divide-y divide-line">{shown.map((s) => (
            <li key={`${s.id}-${s.at}`} data-testid="scan-signal" data-id={s.id} data-bias={s.bias} className="flex items-start gap-2 py-2">
              <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-px text-[10px] font-bold uppercase ${BIAS[s.bias]}`}>{s.bias}</span>
              <div className="min-w-0"><div className="text-[12px] font-semibold text-ink">{s.name} <span className="font-normal text-muted">· {s.group} · {age(s.age)}</span></div><div className="num text-[11px] text-muted">{s.detail}</div></div>
            </li>))}</ul>}
      <p className="mt-2 text-[10px] text-muted">Daily bars (Yahoo, 1Y){live ? ' + live SmartAPI LTP in today’s bar' : ''}{stamp ? ` · refreshed ${new Date(stamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST` : ''}. Patterns describe past price action — they are not predictions or advice.</p>
    </div>
  );
}
