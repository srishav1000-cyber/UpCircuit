'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/authBus';
import { backtest, type BtResult } from '@/lib/backtest';
import type { Candle } from '@/lib/types';

const pct = (x: number | null) => (x === null ? 'N/A' : `${(x * 100).toFixed(1)}%`);

/** Runs the circuit-proximity rule over real daily history (1 year, Yahoo via /api/bars) for the symbols you give it — never over synthetic data. */
export function PredictionBacktest({ defaultSymbols }: { defaultSymbols: string[] }) {
  const [text, setText] = useState(defaultSymbols.join(', '));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [res, setRes] = useState<{ r: BtResult; missing: string[] } | null>(null);
  async function run() {
    const syms = [...new Set(text.split(/[\s,]+/).map((s) => s.toUpperCase()).filter((s) => /^[A-Z0-9&._-]{1,24}$/.test(s)))].slice(0, 40);
    if (!syms.length) return;
    setBusy(true); setRes(null);
    const series: Record<string, Candle[]> = {}; const missing: string[] = []; let done = 0;
    const queue = [...syms];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const s = queue.shift() as string;
        try {
          const r = await apiFetch(`/api/bars/${encodeURIComponent(s)}?tf=1Y`); const j = (await r.json()) as { ok?: boolean; bars?: Candle[] };
          if (j.ok && j.bars && j.bars.length > 30) series[s] = j.bars; else missing.push(s);
        } catch { missing.push(s); }
        setProgress(`${++done}/${syms.length} symbols`);
      }
    }));
    setRes({ r: backtest(series), missing }); setBusy(false); setProgress('');
  }
  return (
    <section data-testid="backtest" aria-label="Prediction back-test">
      <p className="mb-2 text-[11px] text-muted">How often did a stock that closed within 1.5 % of its (inferred) 5 / 10 / 20 % band touch the same band again the next day, versus the unconditional rate? Uses real daily bars; no parameters are fitted.</p>
      <div className="mb-3 flex flex-wrap gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Symbols (comma separated, up to 40)" data-testid="bt-symbols" className="h-9 min-w-[240px] flex-1 rounded-md border border-line bg-transparent px-2 text-[13px] text-ink outline-none focus:border-accent" />
        <button onClick={() => void run()} disabled={busy} data-testid="bt-run" className="h-9 rounded-md bg-accent px-4 text-[13px] font-bold text-white disabled:opacity-50">{busy ? `Running… ${progress}` : 'Run back-test'}</button>
      </div>
      {res && (
        <div data-testid="bt-result">
          <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-5 text-[12px]">
            {[['Stocks', String(res.r.symbols)], ['Stock-days', res.r.days.toLocaleString('en-IN')], ['Signals', String(res.r.signals)], ['Precision', pct(res.r.precision)], ['Lift vs baseline', res.r.lift === null ? 'N/A' : `${res.r.lift.toFixed(1)}×`]].map(([k, v]) => <div key={k} className="rounded-lg border border-line bg-panel px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted">{k}</div><div className="num text-base font-bold text-ink">{v}</div></div>)}
          </div>
          {!res.r.enough && <p role="note" data-testid="bt-thin" className="mb-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">Only {res.r.signals} signals — too few to say anything reliable (need ≥ 30). Add more, more volatile stocks (small / mid caps).</p>}
          <table className="w-full text-left text-[12px]"><thead className="text-[11px] uppercase tracking-wide text-muted"><tr>{['Band', 'Signals', 'Next-day touch', 'Locked at close', 'Precision', 'Baseline', 'Lift'].map((h) => <th key={h} className="py-1 pr-3 font-semibold">{h}</th>)}</tr></thead>
            <tbody>{res.r.byBand.map((b) => <tr key={b.band} className="border-t border-line"><td className="py-1 pr-3 font-semibold text-ink">{b.band}%</td><td className="num pr-3">{b.signals}</td><td className="num pr-3">{b.hits}</td><td className="num pr-3">{b.locks}</td><td className="num pr-3">{pct(b.precision)}</td><td className="num pr-3 text-muted">{pct(b.baseline)}</td><td className="num pr-3">{b.lift === null ? 'N/A' : `${b.lift.toFixed(1)}×`}</td></tr>)}</tbody></table>
          {res.missing.length > 0 && <p className="mt-2 text-[11px] text-muted">No history for: {res.missing.join(', ')}</p>}
          <p className="mt-2 text-[10px] text-muted">Caveats: daily bars hide intraday proximity; a stock’s true band (2/5/10/20 %) is inferred from its move; “touch” is not a halt; one year of history is a small sample and survivorship applies to the symbols you choose.</p>
        </div>
      )}
    </section>
  );
}
