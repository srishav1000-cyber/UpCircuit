// Signal attribution & ablation: what each corroborating signal contributes on its own versus combined, read from the published backtest
// (public/backtest-heuristics.json → ablation). Pure; derives F1 and false-positive reduction from the raw counts so the table can be re-checked by hand.
// Synthetic benchmark: the numbers describe agreement with the generator's labels under an assumed noise and volume model, not real-market manipulation.
export interface AblationMetrics { flags: number; tp: number; fp: number; precision: number | null; recall: number | null; recallSpoof?: number | null; recallFlicker?: number | null; f1?: number | null; per1000?: number }
export interface AblationRowIn { id: string; label: string; signals: string; metrics: AblationMetrics }
export interface AttributionRow {
  id: string; label: string; signals: string;
  precision: number | null; recall: number | null; f1: number | null;
  flags: number; tp: number; fp: number; per1000: number | null;
  /** (baseline FP − FP) ÷ baseline FP, in % — null for the baseline itself or when it had no FPs */
  fpReductionPct: number | null;
  /** percentage-point change in precision / recall versus the baseline */
  precisionLiftPts: number | null; recallChangePts: number | null;
  best: { f1: boolean; precision: boolean };
}
export interface Attribution { snapshots: number | null; rows: AttributionRow[]; bestF1: string | null; notes: string[] }

const r1 = (x: number) => Math.round(x * 10) / 10;
export const f1Of = (p: number | null, r: number | null): number | null => (p === null || r === null || p + r === 0 ? null : (2 * p * r) / (p + r));
export const PRECISION_NOTE = 'Precision = TP ÷ (TP + FP) over emitted flags; recall = detected labelled episodes ÷ all labelled episodes; F1 = 2PR ÷ (P + R); FP reduction = (FP_baseline − FP) ÷ FP_baseline.';

export function buildAttribution(bt: { data?: { snapshots?: number }; ablation?: AblationRowIn[] } | null | undefined): Attribution | null {
  const rows = bt?.ablation;
  if (!rows?.length) return null;
  const base = rows.find((r) => r.id === 'baseline') ?? rows[0];
  const out: AttributionRow[] = rows.map((r) => {
    const m = r.metrics, p = m.precision, rc = m.recall;
    return {
      id: r.id, label: r.label, signals: r.signals, precision: p, recall: rc, f1: m.f1 ?? f1Of(p, rc), flags: m.flags, tp: m.tp, fp: m.fp, per1000: m.per1000 ?? null,
      fpReductionPct: r.id === base.id || !base.metrics.fp ? null : r1(((base.metrics.fp - m.fp) / base.metrics.fp) * 100),
      precisionLiftPts: r.id === base.id || p === null || base.metrics.precision === null ? null : r1((p - base.metrics.precision) * 100),
      recallChangePts: r.id === base.id || rc === null || base.metrics.recall === null ? null : r1((rc - base.metrics.recall) * 100),
      best: { f1: false, precision: false },
    };
  });
  const top = (k: 'f1' | 'precision') => { let b: AttributionRow | null = null; for (const r of out) if (r[k] !== null && (!b || (r[k] as number) > (b[k] as number))) b = r; return b; };
  const bf = top('f1'), bp = top('precision');
  if (bf) bf.best.f1 = true; if (bp) bp.best.precision = true;
  const comp = out.find((r) => r.id === 'composite'), notes = [PRECISION_NOTE];
  if (bf && comp && bf.id !== comp.id) notes.push(`On this synthetic benchmark the best F1 is "${bf.label}" (${((bf.f1 ?? 0) * 100).toFixed(1)} %), not the composite (${((comp.f1 ?? 0) * 100).toFixed(1)} %): the composite is the more conservative filter, and the spread signal adds little because the generator has no spread coupling.`);
  notes.push('Every row uses the same flags, thresholds (|OBI_λ| ≥ 0.35, R(t) ≥ 1.8, spread ≥ 1.5× median, λ = 0.5, wall ≥ 4×) and no-look-ahead rule; the volume↔episode link is an assumption (see sensitivity runs).');
  return { snapshots: bt?.data?.snapshots ?? null, rows: out, bestF1: bf?.id ?? null, notes };
}
