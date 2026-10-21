// Peer comparison table: one row per stock, quartile ranks computed per metric over peers with real values.
import { quartileRanks, type Better } from './analytics/peers';

export interface PeerInput {
  symbol: string;
  mcapCr: number | null;
  pe: number | null;
  roe: number | null;
  de: number | null;
  dy: number | null;
  retPct: number | null;
  volPct: number | null;
  sharpe: number | null;
}

export type PeerMetric = 'pe' | 'roe' | 'de' | 'dy' | 'retPct' | 'volPct' | 'sharpe';
export const PEER_BETTER: Record<PeerMetric, Better> = { pe: 'lower', roe: 'higher', de: 'lower', dy: 'higher', retPct: 'higher', volPct: 'lower', sharpe: 'higher' };

export interface PeerRow {
  symbol: string;
  cells: { mcap: string; pe: string; roe: string; de: string; dy: string; ret: string; vol: string; sharpe: string };
  /** quartile 1–4 per metric, null when the metric is N/A */
  q: Record<PeerMetric, 1 | 2 | 3 | 4 | null>;
  /** valuation rank by P/E (lower is better): "Q1"…"Q4" with ≥ 4 peers, else "#1 of 3"; null without a P/E */
  valueQuartile: string | null;
}

const f = (v: number | null, dp = 1) => (v === null || !Number.isFinite(v) ? 'N/A' : v.toFixed(dp));
const big = (v: number | null) => (v === null || !Number.isFinite(v) ? 'N/A' : Math.round(v).toLocaleString('en-IN'));

export function buildPeerTable(inputs: PeerInput[]): PeerRow[] {
  const metrics = Object.keys(PEER_BETTER) as PeerMetric[];
  const ranks = Object.fromEntries(metrics.map((m) => [m, quartileRanks(inputs.map((i) => ({ symbol: i.symbol, value: i[m] })), PEER_BETTER[m])])) as Record<PeerMetric, ReturnType<typeof quartileRanks>>;
  return inputs.map((i) => {
    const q = Object.fromEntries(metrics.map((m) => [m, ranks[m].find((r) => r.symbol === i.symbol)?.quartile ?? null])) as PeerRow['q'];
    return { symbol: i.symbol, cells: { mcap: big(i.mcapCr), pe: f(i.pe), roe: f(i.roe), de: f(i.de, 2), dy: f(i.dy, 2), ret: f(i.retPct), vol: f(i.volPct), sharpe: f(i.sharpe, 2) }, q, valueQuartile: q.pe ? `Q${q.pe}` : (() => { const r = ranks.pe.find((x) => x.symbol === i.symbol); return r?.rank ? `#${r.rank} of ${r.of}` : null; })() };
  });
}
