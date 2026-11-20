// End-of-day post-market surveillance digest — pure aggregation (no network, no clock). Inputs come from one of two places:
//   live   : the day's persisted ticks, circuit events and heuristic flags (scripts/eod-digest.ts with a service key, or the Surveillance Desk with the signed-in account)
//   replay : the deterministic scripted scenario in lib/surveillanceReplay.ts (outside market hours, or when nothing was persisted)
// Every figure is "N/A" when its inputs are missing — never invented. The suppression ratio is the share of single-rule flags the multi-signal filter would NOT alert on;
// without ground-truth labels that is a filtering ratio, not a measured false-positive rate (the labelled figure is the synthetic backtest's).
import { ReplayRunner, type ReplayScenario } from './surveillanceReplay';
import { VolumeWindow, BUCKETS, type IntradayProfile } from './volumeBaseline';
import { istDate } from './auditDossier';

export const DIGEST_SCHEMA = 'upcircuit.eod-digest/1';
export type DigestSource = 'live' | 'replay';
export interface DigestFlag { symbol: string; kind: 'wall' | 'add_cancel'; side: 'bid' | 'ask'; at: number; confirmed: boolean; hits: string[]; obi: number | null; volRatio: number | null; origin: 'daemon' | 'browser' | 'replay' }
export interface DigestInput {
  date: string; source: DigestSource;
  flags: DigestFlag[];
  /** R(t) readings (any number per symbol; the digest keeps each symbol's peak) */
  surges: { symbol: string; rt: number; at: number }[];
  /** top-5 order-book imbalance readings (weighted, λ = 0.5) */
  obi: { symbol: string; value: number; at: number }[];
  circuit: { symbol: string; direction: 'UPPER' | 'LOWER'; price: number | null; at: number; source: string }[];
  /** how many raw ticks / depth snapshots the figures rest on (null = unknown) */
  ticks: number | null;
}
export interface EodDigest {
  schema: typeof DIGEST_SCHEMA; date: string; source: DigestSource; status: 'ok' | 'na';
  banner: string;
  topSurges: { symbol: string; peakRt: number; at: string }[];
  topObi: { symbol: string; obi: number | null; at: string; basis: 'reading' | 'flag_corroboration_only' }[];
  circuitTouches: { symbol: string; direction: 'UPPER' | 'LOWER'; price: number | null; at: string; source: string }[];
  suppression: { total: number; confirmed: number; baselineOnly: number; suppressedPct: number | null; byKind: Record<string, { total: number; confirmed: number }>; note: string };
  basis: { ticks: number | null; formulas: Record<string, string> };
}
export const REPLAY_BANNER = 'REPLAY — deterministic synthetic scenario (the market is closed or nothing was persisted). Not market data.';
export const LIVE_BANNER = 'Live session data persisted for this trading day.';

const iso = (ms: number) => new Date(ms).toISOString();
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function buildDigest(i: DigestInput, top = 5): EodDigest {
  const peakBy = <T extends { symbol: string }>(rows: T[], val: (x: T) => number): Map<string, T> => {
    const m = new Map<string, T>();
    for (const x of rows) { const v = val(x); if (!Number.isFinite(v)) continue; const c = m.get(x.symbol); if (!c || v > val(c)) m.set(x.symbol, x); }
    return m;
  };
  const topSurges = [...peakBy(i.surges, (x) => x.rt).values()].sort((a, b) => b.rt - a.rt).slice(0, top).map((x) => ({ symbol: x.symbol, peakRt: r3(x.rt), at: iso(x.at) }));
  const readings = [...peakBy(i.obi, (x) => Math.abs(x.value)).values()].map((x) => ({ symbol: x.symbol, obi: r3(x.value), at: iso(x.at), basis: 'reading' as const }));
  const seen = new Set(readings.map((r) => r.symbol));
  const corroborated = [...peakBy(i.flags.filter((f) => f.hits.includes('obi') && !seen.has(f.symbol)), (f) => f.at).values()]
    .map((f) => ({ symbol: f.symbol, obi: f.obi === null ? null : r3(f.obi), at: iso(f.at), basis: 'flag_corroboration_only' as const }));
  const topObi = [...readings, ...corroborated].sort((a, b) => Math.abs(b.obi ?? 0) - Math.abs(a.obi ?? 0)).slice(0, top);
  const seenC = new Set<string>();
  const circuitTouches = [...i.circuit].sort((a, b) => a.at - b.at).filter((c) => { const k = `${c.symbol}|${c.direction}`; if (seenC.has(k)) return false; seenC.add(k); return true; })
    .map((c) => ({ symbol: c.symbol, direction: c.direction, price: c.price, at: iso(c.at), source: c.source }));
  const byKind: Record<string, { total: number; confirmed: number }> = {};
  for (const f of i.flags) { const k = (byKind[f.kind] ??= { total: 0, confirmed: 0 }); k.total++; if (f.confirmed) k.confirmed++; }
  const total = i.flags.length, confirmed = i.flags.filter((f) => f.confirmed).length;
  const empty = !total && !i.surges.length && !i.obi.length && !i.circuit.length;
  return {
    schema: DIGEST_SCHEMA, date: i.date, source: i.source, status: empty ? 'na' : 'ok', banner: i.source === 'replay' ? REPLAY_BANNER : LIVE_BANNER,
    topSurges, topObi, circuitTouches,
    suppression: {
      total, confirmed, baselineOnly: total - confirmed, suppressedPct: total ? Math.round(((total - confirmed) / total) * 1000) / 10 : null, byKind,
      note: 'Share of single-rule (Baseline) flags that the multi-signal filter would not alert on. Without ground-truth labels this is a filtering ratio, not a measured false-positive rate; the labelled synthetic backtest is public/backtest-heuristics.json.',
    },
    basis: {
      ticks: i.ticks,
      formulas: {
        'R(t)': 'volume traded in the last 15 min ÷ typical volume for the same 15 min (median intraday profile; the session-average pace when no profile exists)',
        OBI_λ: 'Σ wᵢ(Bᵢ − Aᵢ) ÷ Σ wᵢ(Bᵢ + Aᵢ),  wᵢ = e^(−0.5(i−1)),  top 5 levels',
        'circuit touch': 'LTP at or beyond the upper / lower circuit price',
        suppression: '(Baseline flags − Multi-Signal Confirmed flags) ÷ all flags',
      },
    },
  };
}

/* ───────────── replay source (offline fallback + demo) ───────────── */
export function digestInputFromRunner(run: ReplayRunner): DigestInput {
  const rd = run.readings, sc: ReplayScenario = run.scenario;
  return {
    date: istDate(sc.startMs), source: 'replay', ticks: rd.length,
    flags: run.flags.map((f) => ({ symbol: f.symbol, kind: f.kind, side: f.side, at: f.ts, confirmed: !!f.confirmation?.confirmed, hits: f.confirmation?.hits ?? [], obi: f.confirmation?.obi ?? null, volRatio: f.confirmation?.volRatio ?? null, origin: 'replay' as const })),
    surges: rd.filter((x) => x.volRatio !== null).map((x) => ({ symbol: x.symbol, rt: x.volRatio as number, at: x.t })),
    obi: rd.filter((x) => x.obi !== null).map((x) => ({ symbol: x.symbol, value: x.obi as number, at: x.t })),
    circuit: rd.filter((x, k) => x.toUpperPct !== null && x.toUpperPct <= 0 && !rd.slice(0, k).some((y) => y.symbol === x.symbol && y.toUpperPct !== null && y.toUpperPct <= 0)).map((x) => ({ symbol: x.symbol, direction: 'UPPER' as const, price: x.ltp, at: x.t, source: 'replay' })),
  };
}
export function replayDigest(): EodDigest { const r = new ReplayRunner(); r.runAll(); return buildDigest(digestInputFromRunner(r)); }

/* ───────────── R(t) from a day of persisted ticks ───────────── */
export interface TickRow { symbol: string; ts: number; ltp: number; volume: number }
/** session-average-pace profile: the day's final cumulative volume spread evenly over the 25 buckets (used only when no median profile is available) */
export function uniformProfile(dayVolume: number): IntradayProfile { return { status: 'ok', sessions: 1, cum: Array.from({ length: BUCKETS }, (_, k) => Math.round((dayVolume * (k + 1)) / BUCKETS)) }; }
/** peak R(t) per symbol over the day's ticks. `profiles` (from volume_baselines) win; otherwise the session-average pace is used and `basis` says so. */
export function surgesFromTicks(ticks: TickRow[], profiles: Record<string, IntradayProfile | null | undefined> = {}): { surges: DigestInput['surges']; basis: Record<string, 'median-profile' | 'session-average-pace'> } {
  const by = new Map<string, TickRow[]>();
  for (const t of ticks) (by.get(t.symbol) ?? by.set(t.symbol, []).get(t.symbol)!).push(t);
  const surges: DigestInput['surges'] = [], basis: Record<string, 'median-profile' | 'session-average-pace'> = {};
  for (const [sym, rows] of by) {
    rows.sort((a, b) => a.ts - b.ts);
    const given = profiles[sym], day = rows[rows.length - 1].volume;
    const prof = given && given.status === 'ok' ? given : day > 0 ? uniformProfile(day) : null;
    basis[sym] = given && given.status === 'ok' ? 'median-profile' : 'session-average-pace';
    if (!prof) continue;
    const w = new VolumeWindow(5_000); let best: { rt: number; at: number } | null = null;
    for (const t of rows) { w.push(sym, t.ts, t.volume); const rt = w.ratio(sym, prof, t.ts, t.volume); if (rt !== null && (!best || rt > best.rt)) best = { rt, at: t.ts }; }
    if (best) surges.push({ symbol: sym, rt: best.rt, at: best.at });
  }
  return { surges, basis };
}

/** Which digest to show: persisted/live data when there is any; the deterministic replay when the market is closed and nothing exists; otherwise N/A (market open, nothing recorded yet). */
export function chooseDigest(live: DigestInput | null, marketOpen: boolean, forceReplay = false): EodDigest {
  if (!forceReplay && live) { const d = buildDigest(live); if (d.status === 'ok') return d; }
  if (forceReplay || !marketOpen) return replayDigest();
  return buildDigest(live ?? { date: '', source: 'live', flags: [], surges: [], obi: [], circuit: [], ticks: null });
}
