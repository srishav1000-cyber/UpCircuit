'use client';
// Signal Attribution & Ablation Matrix: standalone vs combined contribution of each detection signal on the published backtest benchmark.
import { useMemo } from 'react';
import { buildAttribution, type AblationRowIn } from '@/lib/signalAttribution';

const GOLD = '#d4a64a', TEAL = '#2dd4bf';
const pct = (x: number | null) => (x === null ? 'N/A' : `${(x * 100).toFixed(1)} %`);
const pts = (x: number | null) => (x === null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`);

export function SignalAttributionCard({ data, className = '' }: { data: { data?: { snapshots?: number }; ablation?: AblationRowIn[] } | null | undefined; className?: string }) {
  const a = useMemo(() => buildAttribution(data), [data]);
  const th = 'px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-muted';
  return (
    <section id="desk-sec-ablation" className={`rounded-xl border border-white/10 bg-white/[0.03] ${className}`} data-testid="signal-attribution" aria-label="Signal attribution and ablation matrix">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <h3 className="text-[13px] font-bold text-ink">Signal attribution &amp; ablation matrix</h3>
        <span className="num text-[11px] text-muted" data-testid="ablation-snapshots">{a?.snapshots ? `${a.snapshots.toLocaleString('en-IN')} synthetic snapshots` : 'benchmark N/A'}</span>
      </header>
      <div className="overflow-x-auto p-3">
        {!a ? (
          <p data-testid="ablation-na" className="text-[12px] text-muted">N/A — the published backtest has no ablation block. Run <code className="text-ink">npm run backtest</code>.</p>
        ) : (
          <>
            <table className="w-full min-w-[640px] text-[12px]" data-testid="ablation-table">
              <thead><tr><th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted">Detector</th><th className={th}>Precision</th><th className={th}>Recall</th><th className={th}>F1</th><th className={th}>Flags</th><th className={th}>FP</th><th className={th}>FP reduction</th><th className={th}>Δ precision (pts)</th></tr></thead>
              <tbody>
                {a.rows.map((r) => (
                  <tr key={r.id} data-testid="ablation-row" data-id={r.id} className={`border-t border-white/10 ${r.id === 'composite' ? 'bg-white/[0.04]' : ''}`}>
                    <td className="px-2 py-1.5"><div className="font-semibold text-ink">{r.label}</div><div className="text-[10px] text-muted">{r.signals}</div></td>
                    <td className="num px-2 text-right" style={r.best.precision ? { color: TEAL, fontWeight: 700 } : undefined}>{pct(r.precision)}</td>
                    <td className="num px-2 text-right">{pct(r.recall)}</td>
                    <td className="num px-2 text-right" style={r.best.f1 ? { color: GOLD, fontWeight: 700 } : undefined}>{pct(r.f1)}</td>
                    <td className="num px-2 text-right text-muted">{r.flags}</td>
                    <td className="num px-2 text-right text-muted">{r.fp}</td>
                    <td className="num px-2 text-right">{r.fpReductionPct === null ? '—' : `${r.fpReductionPct.toFixed(1)} %`}</td>
                    <td className="num px-2 text-right text-muted">{pts(r.precisionLiftPts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-muted">Best precision in teal, best F1 in gold.</p>
            <ul className="mt-1 space-y-1 text-[11px] text-muted" data-testid="ablation-notes">{a.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </>
        )}
        <p className="mt-2 text-[10px] text-muted">Synthetic benchmark — agreement with generator labels, not evidence about real-market manipulation. Not investment advice.</p>
      </div>
    </section>
  );
}
