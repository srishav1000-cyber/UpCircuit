'use client';

import { useMemo, useState } from 'react';

// Threshold & Sensitivity Explorer: reads the pre-computed sweep in public/backtest-heuristics.json (scripts/backtest-heuristics.ts) and lets the viewer move
// the three thresholds that matter. Nothing is recomputed in the browser and nothing is invented: every number shown is a cell of the published grid.
const GOLD = '#d4a64a', TEAL = '#2dd4bf', HI = '#f8fafc', LO = '#cbd5e1';

export interface SweepMetrics { flags: number; tp: number; fp: number; precision: number | null; recallSpoof: number | null; recallFlicker: number | null; recall: number | null; f1: number | null; per1000: number }
export interface SweepCell { lambda: number; wallMultiple: number; surge: number; baseline: SweepMetrics; composite: SweepMetrics; fpReductionPct: number | null }
export interface ExplorerData {
  schemaVersion?: number;
  modes?: { baseline: SweepMetrics; confirmed_composite: SweepMetrics & { params?: Record<string, number> }; comparison?: Record<string, number | null> };
  sweep?: { axes: { lambda: number[]; wallMultiple: number[]; surge: number[] }; fixed: { obiMin: number; spreadMult: number; minSignals: number }; cells: SweepCell[] };
  sensitivity?: { volumeCouplingOff: SweepMetrics; volumeSignalDisabled: SweepMetrics };
  assumptions?: { volumeCoupling?: Record<string, number>; note?: string };
}

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? 'N/A' : `${(x * 100).toFixed(d)}%`);
const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? 'N/A' : x.toFixed(d));
const closest = (xs: number[], v: number) => Math.max(0, xs.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(xs[best] - v) ? i : best), 0));

function Slider({ label, values, idx, onChange, testid, fmt = (v: number) => String(v) }: { label: string; values: number[]; idx: number; onChange: (i: number) => void; testid: string; fmt?: (v: number) => string }) {
  return (
    <label className="block text-[11px]" style={{ color: LO }}>
      <span className="flex justify-between"><span>{label}</span><b className="num" style={{ color: HI }} data-testid={`${testid}-value`}>{fmt(values[idx])}</b></span>
      <input type="range" min={0} max={values.length - 1} step={1} value={idx} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} data-testid={testid} className="mt-1 w-full accent-teal-400" />
      <span className="num flex justify-between text-[9px]">{values.map((v) => <span key={v}>{fmt(v)}</span>)}</span>
    </label>
  );
}

function Row({ label, a, b, better }: { label: string; a: string; b: string; better?: 'up' | 'down' | null }) {
  return (
    <tr className="border-t border-white/5">
      <th scope="row" className="py-1 pr-2 text-left font-normal" style={{ color: LO }}>{label}</th>
      <td className="num py-1 text-right font-semibold" style={{ color: GOLD }}>{a}</td>
      <td className="num py-1 text-right font-semibold" style={{ color: better === 'up' ? TEAL : HI }}>{b}</td>
    </tr>
  );
}

/** compact SVG precision–recall plane: every composite cell of the grid, the baseline at each wall multiple, and the selected cell with its R(t) path */
function PRCurve({ cells, sel, walls }: { cells: SweepCell[]; sel: SweepCell; walls: number[] }) {
  const W = 260, H = 170, L = 30, B = 22, T = 8, Rm = 8;
  const pts = cells.filter((c) => c.composite.precision !== null && c.composite.recall !== null);
  const yMax = Math.min(1, Math.max(0.3, Math.ceil(Math.max(...pts.map((c) => c.composite.precision as number), ...cells.map((c) => c.baseline.precision ?? 0)) * 10) / 10 + 0.1));
  const x = (r: number) => L + r * (W - L - Rm), y = (p: number) => H - B - (p / yMax) * (H - B - T);
  const path = cells.filter((c) => c.lambda === sel.lambda && c.wallMultiple === sel.wallMultiple && c.composite.precision !== null && c.composite.recall !== null).sort((a, b) => a.surge - b.surge);
  const base = walls.map((w) => cells.find((c) => c.wallMultiple === w)?.baseline).filter((m): m is SweepMetrics => !!m && m.precision !== null && m.recall !== null);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Precision versus recall for every threshold combination in the grid" data-testid="explorer-pr">
      {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={T} y2={H - B} stroke="rgb(255 255 255 / 0.07)" /><text x={x(t)} y={H - 8} fontSize="8" textAnchor="middle" fill={LO}>{Math.round(t * 100)}</text></g>)}
      {[0, 0.5, 1].map((f) => { const p = f * yMax; return <g key={f}><line x1={L} x2={W - Rm} y1={y(p)} y2={y(p)} stroke="rgb(255 255 255 / 0.07)" /><text x={L - 4} y={y(p) + 3} fontSize="8" textAnchor="end" fill={LO}>{Math.round(p * 100)}</text></g>; })}
      <text x={(L + W) / 2} y={H - 0.5} fontSize="8" textAnchor="middle" fill={LO}>recall % →</text>
      <text x={8} y={T + 6} fontSize="8" fill={LO}>precision %</text>
      {pts.map((c, i) => <circle key={i} cx={x(c.composite.recall as number)} cy={y(c.composite.precision as number)} r="2" fill={TEAL} opacity="0.35"><title>{`λ ${c.lambda} · wall ×${c.wallMultiple} · R ≥ ${c.surge}: precision ${pct(c.composite.precision)}, recall ${pct(c.composite.recall)}`}</title></circle>)}
      {base.map((m, i) => <rect key={i} x={x(m.recall as number) - 2.5} y={y(m.precision as number) - 2.5} width="5" height="5" fill={GOLD}><title>{`Baseline: precision ${pct(m.precision)}, recall ${pct(m.recall)}`}</title></rect>)}
      {path.length > 1 && <polyline fill="none" stroke={TEAL} strokeWidth="1.5" points={path.map((c) => `${x(c.composite.recall as number).toFixed(1)},${y(c.composite.precision as number).toFixed(1)}`).join(' ')} />}
      {sel.composite.precision !== null && sel.composite.recall !== null && <circle cx={x(sel.composite.recall)} cy={y(sel.composite.precision)} r="5" fill="none" stroke="#fff" strokeWidth="1.5" data-testid="explorer-pr-selected" />}
    </svg>
  );
}

export function ThresholdExplorer({ data }: { data: ExplorerData }) {
  const sw = data.sweep;
  const [li, setLi] = useState(() => (sw ? closest(sw.axes.lambda, 0.5) : 0));
  const [wi, setWi] = useState(() => (sw ? closest(sw.axes.wallMultiple, 4) : 0));
  const [ri, setRi] = useState(() => (sw ? closest(sw.axes.surge, 1.8) : 0));
  const sel = useMemo(() => (sw ? sw.cells.find((c) => c.lambda === sw.axes.lambda[li] && c.wallMultiple === sw.axes.wallMultiple[wi] && c.surge === sw.axes.surge[ri]) ?? null : null), [sw, li, wi, ri]);

  if (!sw || !sw.cells.length) {
    return <p data-testid="explorer-na" className="py-3 text-[12px]" style={{ color: LO }}>N/A — the published backtest has no multi-signal sweep. Run <code style={{ color: HI }}>npx tsx scripts/backtest-heuristics.ts --out public/backtest-heuristics.json</code>.</p>;
  }
  const b = sel?.baseline, c = sel?.composite;
  const f1Up = b && c && b.f1 !== null && c.f1 !== null ? (c.f1 > b.f1 ? 'up' : null) : null;
  return (
    <div data-testid="threshold-explorer" className="mt-3 border-t border-white/10 pt-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h4 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: HI }}>Threshold &amp; sensitivity explorer</h4>
        <span className="text-[10px]" style={{ color: LO }}>pre-computed grid · {sw.cells.length} cells · confirmation needs ≥ {sw.fixed.minSignals} of: |OBI<sub>λ</sub>| ≥ {sw.fixed.obiMin}, R(t) ≥ slider, spread ≥ {sw.fixed.spreadMult}× rolling median</span>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Slider label="Decay λ (OBI level weights)" values={sw.axes.lambda} idx={li} onChange={setLi} testid="explorer-lambda" />
          <Slider label="Wall multiple (× median of other levels)" values={sw.axes.wallMultiple} idx={wi} onChange={setWi} testid="explorer-wall" fmt={(v) => `${v}×`} />
          <Slider label="Volume surge confirmation R(t) ≥" values={sw.axes.surge} idx={ri} onChange={setRi} testid="explorer-surge" fmt={(v) => v.toFixed(1)} />
        </div>
        <div>
          {!sel || !b || !c ? <p className="text-[12px]" style={{ color: LO }}>N/A — no grid cell for this combination.</p> : (
            <table className="w-full text-[12px]" data-testid="explorer-compare" data-fp-reduction={sel.fpReductionPct ?? 'na'}>
              <thead><tr className="text-[10px] uppercase tracking-wide" style={{ color: LO }}><th /><th className="text-right" style={{ color: GOLD }}>Baseline flag</th><th className="text-right" style={{ color: TEAL }}>Multi-signal confirmed</th></tr></thead>
              <tbody>
                <Row label="Precision" a={pct(b.precision)} b={pct(c.precision)} better={b.precision !== null && c.precision !== null && c.precision > b.precision ? 'up' : null} />
                <Row label="Recall (both patterns)" a={pct(b.recall)} b={pct(c.recall)} />
                <Row label="Recall · spoof_wall" a={pct(b.recallSpoof)} b={pct(c.recallSpoof)} />
                <Row label="Recall · flicker" a={pct(b.recallFlicker)} b={pct(c.recallFlicker)} />
                <Row label="F1 score" a={num(b.f1, 3)} b={num(c.f1, 3)} better={f1Up} />
                <Row label="Flags / 1 000 snapshots" a={num(b.per1000, 3)} b={num(c.per1000, 3)} />
                <Row label="False positives" a={String(b.fp)} b={String(c.fp)} />
              </tbody>
              <tfoot><tr className="border-t border-white/10"><th scope="row" className="py-1 text-left font-semibold" style={{ color: LO }}>False-positive reduction</th><td colSpan={2} className="num py-1 text-right text-[13px] font-bold" style={{ color: TEAL }} data-testid="explorer-fp-reduction">{sel.fpReductionPct === null ? 'N/A' : `${sel.fpReductionPct.toFixed(1)}%`}</td></tr></tfoot>
            </table>
          )}
        </div>
        <div>
          <PRCurve cells={sw.cells} sel={sel ?? sw.cells[0]} walls={sw.axes.wallMultiple} />
          <p className="mt-1 text-[10px]" style={{ color: LO }}><span style={{ color: GOLD }}>■</span> baseline at each wall multiple · <span style={{ color: TEAL }}>●</span> every composite cell · line = R(t) sweep at the selected λ and wall · ◯ selected</p>
        </div>
      </div>
      {data.sensitivity && (
        <p className="mt-2 text-[11px]" style={{ color: LO }} data-testid="explorer-sensitivity">
          Sensitivity at the default setting: if volume is <b style={{ color: HI }}>not</b> linked to the patterns, composite precision {pct(data.sensitivity.volumeCouplingOff.precision)} / recall {pct(data.sensitivity.volumeCouplingOff.recall)}; with the volume signal removed, {pct(data.sensitivity.volumeSignalDisabled.precision)} / {pct(data.sensitivity.volumeSignalDisabled.recall)}.
        </p>
      )}
      <p className="mt-1 text-[10px] leading-snug" style={{ color: LO }} data-testid="explorer-caveat">
        Computed on a deterministic synthetic L2 replay with no look-ahead (every signal uses data available at the flag’s time). Order-book imbalance and spread come from the synthetic book itself; the volume signal rests on an assumed link between volume bursts and the injected patterns. Confirmation trades recall for fewer false positives, and none of this measures real-market manipulation.
      </p>
    </div>
  );
}
