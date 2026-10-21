'use client';

import { useMemo } from 'react';
import { Card } from '../ui';
import { alpha } from '@/lib/theme';
import { annualVolPct } from '@/lib/analytics/varMath';
import { sharpeParts } from '@/lib/analytics/correlation';
import { rsi14 } from '@/lib/analytics/rsi';
import { summariseDrawdown } from '@/lib/analytics/drawdown';
import { ownPriceStat, peerStat } from '@/lib/analytics/peers';
import { buildPeerTable, type PeerInput, type PeerMetric } from '@/lib/peerTable';
import { buildResearchNote } from '@/lib/researchNote';
import { usePeerFundamentals } from '@/hooks/usePeerFundamentals';
import type { MarketEngine } from '@/lib/market';
import type { Quote } from '@/lib/types';

const MAX_PEERS = 6;
const QTINT: Record<number, string> = { 1: alpha('up', 0.35), 2: alpha('up', 0.14), 3: alpha('down', 0.14), 4: alpha('down', 0.35) };

const download = (name: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Sector peer matrix with quartile ranks, peer-relative valuation percentile / z-score, and the research-note exporter. */
export function PeerMatrix({ engine, quote, live, onSelect, className = '' }: { engine: MarketEngine; quote: Quote; live: boolean; onSelect: (s: string) => void; className?: string }) {
  const symbols = useMemo(() => {
    const same = [...engine.quotes.values()].filter((q) => q.sector === quote.sector && q.symbol !== quote.symbol).sort((a, b) => b.mcapCr - a.mcapCr).slice(0, MAX_PEERS - 1).map((q) => q.symbol);
    return [quote.symbol, ...same];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote.symbol, quote.sector, engine, engine.lastQuotesAt]);
  const { data: fund, loading } = usePeerFundamentals(symbols);

  const built = useMemo(() => {
    const inputs: PeerInput[] = symbols.map((s) => {
      const q = engine.quotes.get(s);
      const closes = engine.closes(s);
      const f = fund[s];
      const sp = sharpeParts(closes);
      const ret = closes.length >= 30 ? (closes[closes.length - 1] / closes[0] - 1) * 100 : null;
      return { symbol: s, mcapCr: q?.mcapCr ?? null, pe: f?.pe ?? null, roe: f?.roe ?? null, de: f?.debtToEquity ?? null, dy: f?.dividendYield ?? (q && q.dividendYield > 0 ? q.dividendYield : null), retPct: ret, volPct: closes.length >= 30 ? annualVolPct(closes) : null, sharpe: sp?.sharpe ?? null };
    });
    return { inputs, rows: buildPeerTable(inputs) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols, fund, engine, engine.histVer, engine.lastQuotesAt]);

  const self = built.inputs[0];
  const pes = built.inputs.map((i) => i.pe).filter((x): x is number => x !== null);
  const peStat = self?.pe != null && pes.length >= 3 ? peerStat(pes, self.pe) : null;
  const closes = engine.closes(quote.symbol);
  const px = closes.length ? ownPriceStat(closes, quote.ltp) : null;

  const exportNote = () => {
    const now = new Date();
    const f = fund[quote.symbol];
    const src = f ? 'Yahoo Delayed' : 'N/A';
    const fmtN = (v: number | null | undefined, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : v.toFixed(dp));
    const sp = sharpeParts(closes);
    const dd = summariseDrawdown(closes);
    const note = buildResearchNote({
      symbol: quote.symbol, name: quote.name, sector: quote.sector, ltp: quote.ltp, changePct: ((quote.ltp - quote.prevClose) / quote.prevClose) * 100, feed: live ? 'SmartAPI Live' : 'Yahoo Delayed', now,
      fundamentals: [
        { label: 'Market cap (₹ Cr)', value: fmtN(quote.mcapCr, 0), source: live ? 'SmartAPI Live × shares' : 'Yahoo Delayed' },
        { label: 'P/E', value: fmtN(f?.pe), source: src }, { label: 'ROE (%)', value: fmtN(f?.roe), source: src }, { label: 'Debt / equity', value: fmtN(f?.debtToEquity, 2), source: src }, { label: 'Dividend yield (%)', value: fmtN(f?.dividendYield ?? null, 2), source: src },
      ],
      peers: built.rows,
      valuation: [
        { label: `P/E percentile vs ${pes.length} sector peers`, value: peStat?.percentile != null ? `${peStat.percentile.toFixed(0)}th` : 'N/A (needs ≥ 3 peers with P/E)', source: 'Computed Math' },
        { label: 'P/E z-score vs peers', value: peStat?.z != null ? peStat.z.toFixed(2) : 'N/A', source: 'Computed Math' },
        { label: 'Price percentile vs own 1Y closes', value: px ? `${px.percentile.toFixed(0)}th` : 'N/A', source: 'Computed Math (Yahoo Delayed closes)' },
        { label: 'Price z-score vs own 1Y closes', value: px?.z != null ? px.z.toFixed(2) : 'N/A', source: 'Computed Math (Yahoo Delayed closes)' },
      ],
      risk: [
        { label: 'RSI (14)', value: fmtN(rsi14(closes)), source: 'Computed Math (Yahoo Delayed closes)' },
        { label: '1Y return (%)', value: closes.length >= 30 ? fmtN((closes[closes.length - 1] / closes[0] - 1) * 100) : 'N/A', source: 'Computed Math (Yahoo Delayed closes)' },
        { label: 'Annualised volatility (%)', value: closes.length >= 30 ? fmtN(annualVolPct(closes)) : 'N/A', source: 'Computed Math (Yahoo Delayed closes)' },
        { label: 'Sharpe (Rf 6.5 %)', value: fmtN(sp?.sharpe, 2), source: 'Computed Math (Yahoo Delayed closes)' },
        { label: 'Max drawdown, 1Y (%)', value: dd ? fmtN(dd.maxPct) : 'N/A', source: 'Computed Math (Yahoo Delayed closes)' },
      ],
    });
    download(`UpCircuit_${quote.symbol.replace(/[^A-Za-z0-9_-]/g, '')}_research_note_${now.toISOString().slice(0, 10)}.md`, note, 'text/markdown;charset=utf-8');
  };

  const cols: { k: keyof (typeof built.rows)[number]['cells']; q?: PeerMetric; h: string }[] = [
    { k: 'mcap', h: 'Mkt cap ₹Cr' }, { k: 'pe', q: 'pe', h: 'P/E ↓' }, { k: 'roe', q: 'roe', h: 'ROE % ↑' }, { k: 'de', q: 'de', h: 'D/E ↓' }, { k: 'dy', q: 'dy', h: 'Yield % ↑' }, { k: 'ret', q: 'retPct', h: '1Y ret % ↑' }, { k: 'vol', q: 'volPct', h: '1Y vol % ↓' }, { k: 'sharpe', q: 'sharpe', h: 'Sharpe ↑' },
  ];
  return (
    <Card title={`Peer comparison · ${quote.sector}`} badges={['yahoo', 'computed']} className={className} right={<button type="button" onClick={exportNote} data-testid="note-export" className="rounded border border-accent/60 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/20">📝 Research note (.md)</button>}>
      <div data-testid="peer-matrix" data-peers={built.rows.length}>
        {built.rows.length < 2 ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="peer-na">N/A — fewer than two tracked stocks in {quote.sector}.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="num w-full border-separate border-spacing-0.5 text-center text-[11px]">
                <thead>
                  <tr>
                    <th className="pr-2 text-left font-semibold text-muted">Stock</th>
                    {cols.map((c) => <th key={c.h} className="px-1 pb-1 font-semibold text-muted">{c.h}</th>)}
                    <th className="px-1 pb-1 font-semibold text-muted">Value rank</th>
                  </tr>
                </thead>
                <tbody>
                  {built.rows.map((r) => (
                    <tr key={r.symbol} data-testid="peer-row">
                      <th scope="row" className="pr-2 text-left"><button onClick={() => onSelect(r.symbol)} className={`font-semibold hover:underline ${r.symbol === quote.symbol ? 'text-accent' : 'text-ink'}`}>{r.symbol}</button></th>
                      {cols.map((c) => {
                        const q = c.q ? r.q[c.q] : null;
                        const na = r.cells[c.k] === 'N/A';
                        return <td key={c.k} title={q ? `Quartile ${q} among peers with data (1 = best)` : na ? 'Not available from the data source' : undefined} className={`rounded py-1.5 ${na ? 'text-muted' : 'text-ink'}`} style={{ background: q ? QTINT[q] : undefined }}>{r.cells[c.k]}</td>;
                      })}
                      <td className="rounded py-1.5 font-semibold text-ink" data-testid="peer-valrank">{r.valueQuartile ?? 'N/A'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4" data-testid="valuation-block" data-pe-pct={peStat?.percentile != null ? peStat.percentile.toFixed(0) : 'na'}>
              <div className="rounded border border-line bg-bg px-2 py-1.5"><div className="text-[9px] uppercase tracking-wider text-muted">P/E percentile vs peers</div><b className="num text-[14px] text-ink">{peStat?.percentile != null ? `${peStat.percentile.toFixed(0)}th` : 'N/A'}</b></div>
              <div className="rounded border border-line bg-bg px-2 py-1.5"><div className="text-[9px] uppercase tracking-wider text-muted">P/E z-score vs peers</div><b className="num text-[14px] text-ink">{peStat?.z != null ? peStat.z.toFixed(2) : 'N/A'}</b></div>
              <div className="rounded border border-line bg-bg px-2 py-1.5"><div className="text-[9px] uppercase tracking-wider text-muted">Price percentile · own 1Y</div><b className="num text-[14px] text-ink">{px ? `${px.percentile.toFixed(0)}th` : 'N/A'}</b></div>
              <div className="rounded border border-line bg-bg px-2 py-1.5"><div className="text-[9px] uppercase tracking-wider text-muted">Price z-score · own 1Y</div><b className="num text-[14px] text-ink">{px?.z != null ? px.z.toFixed(2) : 'N/A'}</b></div>
            </div>
            <p className="mt-2 text-[10px] text-muted">
              Shading = quartile among peers with real data (green best → red worst); ↑ higher is better, ↓ lower is better. With fewer than 4 ranked peers only a rank (#1 of 3) is shown. {loading && 'Loading peer fundamentals… '}
              Valuation percentile = share of other peers with a lower P/E (≥ 3 peers needed); historical P/E is not supplied by the data provider, so there is no own-history P/E percentile. N/A is never estimated.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
