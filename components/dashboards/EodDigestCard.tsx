'use client';
// "Daily Market Surveillance Digest": top R(t) outliers, highest order-book imbalance events, circuit-band touches and the multi-signal suppression ratio.
// Shows this session's data when there is any; outside market hours with nothing recorded it shows the labelled deterministic replay instead.
import { useEffect, useMemo, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { chooseDigest, type DigestInput, type EodDigest } from '@/lib/eodDigest';

const GOLD = '#d4a64a', TEAL = '#2dd4bf';
const ist = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const signed = (v: number | null) => (v === null ? 'N/A' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`);

export function EodDigestCard({ input, marketOpen, onDigest, className = '' }: { input: DigestInput | null; marketOpen: boolean; onDigest?: (d: EodDigest) => void; className?: string }) {
  const [replay, setReplay] = useState(false);
  const d = useMemo(() => chooseDigest(input, marketOpen, replay), [input, marketOpen, replay]);
  useEffect(() => { onDigest?.(d); }, [d, onDigest]);        // hand the shown digest to the audit pack
  const sup = d.suppression;
  const th = 'pb-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted';
  return (
    <section className={`rounded-xl border border-white/10 bg-white/[0.03] ${className}`} data-testid="eod-digest" data-source={d.source} data-status={d.status} aria-label="Daily market surveillance digest">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <CalendarCheck size={14} aria-hidden /> <h3 className="text-[13px] font-bold text-ink">Daily Market Surveillance Digest</h3>
        <span className="num text-[11px] text-muted">{d.date || '—'}</span>
        <span data-testid="eod-source" className="rounded border px-1.5 text-[10px] font-bold uppercase" style={{ borderColor: d.source === 'replay' ? GOLD : TEAL, color: d.source === 'replay' ? GOLD : TEAL }}>{d.source === 'replay' ? 'Replay' : 'Live data'}</span>
        <button type="button" data-testid="eod-toggle" onClick={() => setReplay((x) => !x)} className="ml-auto rounded border border-white/15 px-2 py-0.5 text-[11px] text-ink hover:bg-white/[0.06]">{replay ? 'Back to session data' : 'Show replay digest'}</button>
      </header>
      <div className="p-3 text-[12px]">
        <p data-testid="eod-banner" className="mb-2 text-[11px] text-muted">{d.status === 'na' ? 'N/A — nothing recorded yet this session. Outside market hours this card shows the replay digest.' : d.banner}</p>
        {d.status === 'ok' && (
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="mb-1 text-[11px] font-semibold text-ink">Top volume-surge outliers · R(t)</h4>
              <table className="w-full"><thead><tr><th className={th}>Symbol</th><th className={th}>Peak R(t)</th><th className={th}>At (IST)</th></tr></thead><tbody data-testid="eod-surges">
                {d.topSurges.length ? d.topSurges.map((x) => <tr key={x.symbol}><td className="font-bold text-ink">{x.symbol}</td><td className="num">{x.peakRt.toFixed(2)}×</td><td className="num text-muted">{ist(x.at)}</td></tr>) : <tr><td colSpan={3} className="text-muted">N/A</td></tr>}
              </tbody></table>
            </div>
            <div>
              <h4 className="mb-1 text-[11px] font-semibold text-ink">Highest order-book imbalance · OBI_λ</h4>
              <table className="w-full"><thead><tr><th className={th}>Symbol</th><th className={th}>OBI</th><th className={th}>At (IST)</th></tr></thead><tbody data-testid="eod-obi">
                {d.topObi.length ? d.topObi.map((x) => <tr key={x.symbol}><td className="font-bold text-ink">{x.symbol}</td><td className="num" title={x.basis === 'flag_corroboration_only' ? 'A flag was corroborated by OBI; the reading itself is not persisted' : undefined}>{signed(x.obi)}</td><td className="num text-muted">{ist(x.at)}</td></tr>) : <tr><td colSpan={3} className="text-muted">N/A — depth snapshots are not persisted</td></tr>}
              </tbody></table>
            </div>
            <div>
              <h4 className="mb-1 text-[11px] font-semibold text-ink">Circuit-band touches</h4>
              <ul data-testid="eod-circuit" className="space-y-0.5">
                {d.circuitTouches.length ? d.circuitTouches.map((c) => <li key={`${c.symbol}${c.direction}`}><span className="font-bold text-ink">{c.symbol}</span> <span className="text-muted">{c.direction === 'UPPER' ? 'upper' : 'lower'} circuit{c.price !== null ? ` ₹${c.price.toFixed(2)}` : ''} · {ist(c.at)} IST</span></li>) : <li className="text-muted">None</li>}
              </ul>
            </div>
            <div>
              <h4 className="mb-1 text-[11px] font-semibold text-ink">False-positive suppression ratio</h4>
              <p className="num text-xl font-semibold" data-testid="eod-suppression" style={{ color: TEAL }}>{sup.suppressedPct === null ? 'N/A' : `${sup.suppressedPct.toFixed(1)} %`}</p>
              <p className="text-[11px] text-muted"><span data-testid="eod-flag-counts">{sup.total} flags · {sup.confirmed} Multi-Signal Confirmed · {sup.baselineOnly} Baseline-only</span></p>
              <p className="mt-1 text-[10px] text-muted">{sup.note}</p>
            </div>
          </div>
        )}
        <p className="mt-2 text-[10px] text-muted">Heuristic patterns in resting orders — not proof of manipulation, not investment advice.</p>
      </div>
    </section>
  );
}
