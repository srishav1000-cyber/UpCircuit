'use client';

import { useMemo, useState } from 'react';
import type { MarketEngine } from '@/lib/market';
import { BANDS, SURGE_MULTIPLE, classifyAnomalies, withBursts, type AnomalyRow } from '@/lib/anomalies';
import { fmt, fmtPct, tone } from '@/lib/format';
import { Badge, Card } from './ui';

type Tab = 'upper' | 'lower' | 'surge';

/** ⚡ Circuit & Anomaly Desk — live view of every active instrument near its upper / lower price band, or trading > 3× its average volume. */
export function CircuitTracker({ engine, onOpenChart }: { engine: MarketEngine; onOpenChart: (symbol: string) => void }) {
  const [tab, setTab] = useState<Tab>('upper');
  const [band, setBand] = useState<number | undefined>(undefined);
  // recomputed on every dashboard render (the market hook re-renders ~2×/s)
  const quotes = Array.from(engine.quotes.values());
  const res = useMemo(() => classifyAnomalies(quotes, band), [quotes.length, engine.alerts, band, Math.floor(Date.now() / 500)]); // eslint-disable-line react-hooks/exhaustive-deps
  const surge = withBursts(res.surge, engine.alerts, (s) => engine.quotes.get(s));
  const rows: AnomalyRow[] = tab === 'surge' ? surge : res[tab];
  const tabs: { id: Tab; label: string; n: number; tone: 'up' | 'down' | 'warn' }[] = [
    { id: 'upper', label: 'Upper Circuit Hits', n: res.upper.length, tone: 'up' },
    { id: 'lower', label: 'Lower Circuit Hits', n: res.lower.length, tone: 'down' },
    { id: 'surge', label: 'Volume Surges', n: surge.length, tone: 'warn' },
  ];
  const empty = { upper: 'No stocks are near their upper band right now.', lower: 'No stocks are near their lower band right now.', surge: `No stock is trading above ${SURGE_MULTIPLE}× its average volume.` }[tab];

  return (
    <Card
      title="⚡ Circuit & Anomaly Desk"
      className="sm:col-span-2"
      right={<span className="num text-[10px] text-muted">{quotes.length} active · live</span>}
    >
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Circuit and anomaly filters" data-testid="circuit-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`circuit-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold transition ${tab === t.id ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted hover:text-ink'}`}
          >
            {t.label}
            <span className={`num rounded px-1.5 text-[10px] ${t.n > 0 ? (t.tone === 'up' ? 'bg-up/15 text-up' : t.tone === 'down' ? 'bg-down/15 text-down' : 'bg-warn/15 text-warn') : 'bg-line text-muted'}`}>{t.n}</span>
          </button>
        ))}
        {tab !== 'surge' && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Price band">
            {[undefined, ...BANDS].map((b) => (
              <button key={b ?? 'all'} onClick={() => setBand(b)} aria-pressed={band === b} data-testid={`circuit-band-${b ?? 'all'}`} className={`cursor-pointer rounded px-2 py-0.5 text-[11px] font-semibold ${band === b ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}>
                {b === undefined ? 'All bands' : `${tab === 'lower' ? '−' : '+'}${b}%`}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full min-w-[420px] border-collapse" data-testid="circuit-table" data-tab={tab}>
          <thead>
            <tr className="text-right text-[10px] font-semibold uppercase tracking-wider text-muted">
              <th className="px-2 py-1.5 text-left">Symbol</th>
              <th className="px-2 py-1.5">LTP</th>
              <th className="px-2 py-1.5">% Chg</th>
              <th className="px-2 py-1.5">Vol ×</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} data-testid="circuit-row" data-symbol={r.symbol} className="border-t border-line/60 text-right hover:bg-line/40">
                <td className="px-2 py-1.5 text-left">
                  <span className="text-[13px] font-semibold text-ink">{r.symbol}</span>
                  {tab === 'surge' && r.burst && <Badge tone="warn" className="ml-1.5">Burst</Badge>}
                  {tab !== 'surge' && <Badge tone={tab === 'upper' ? 'up' : 'down'} className="ml-1.5">{r.locked ? 'Locked' : 'Near'} · {tab === 'lower' ? '−' : '+'}{r.band}%</Badge>}
                  <div className="max-w-[180px] truncate text-[10px] text-muted">{r.name}</div>
                </td>
                <td className="num px-2 py-1.5 text-[12px] text-ink">₹{fmt(r.ltp)}</td>
                <td className={`num px-2 py-1.5 text-[12px] font-semibold ${tone(r.pct)}`}>{fmtPct(r.pct)}</td>
                <td className={`num px-2 py-1.5 text-[12px] ${r.volMultiple > SURGE_MULTIPLE ? 'font-semibold text-warn' : 'text-muted'}`}>{r.volMultiple.toFixed(1)}×</td>
                <td className="px-2 py-1.5">
                  <button onClick={() => onOpenChart(r.symbol)} data-testid="circuit-open" className="cursor-pointer whitespace-nowrap rounded border border-line px-2 py-1 text-[11px] font-semibold text-accent hover:border-accent hover:bg-accent/10">Open Chart</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-[12px] text-muted" data-testid="circuit-empty">{empty}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] text-muted">Near = ≥ 90 % of the stock&apos;s band used (Locked = at the band price). Volume × = today&apos;s volume ÷ average full-day volume; surges are above {SURGE_MULTIPLE}×. “Burst” = the live feed just flagged volume running ≥ {SURGE_MULTIPLE}× its normal rate.</p>
    </Card>
  );
}
