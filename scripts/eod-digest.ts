// Post-market surveillance digest.  npx tsx scripts/eod-digest.ts [--date YYYY-MM-DD] [--offline] [--out digest.json]
// Live mode needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (read at run time, never written anywhere). Without them, or with --offline,
// or when the day has no persisted data, it prints the deterministic replay digest instead — clearly labelled REPLAY.
import { writeFileSync } from 'node:fs';
import { buildDigest, digestInputFromRunner, surgesFromTicks, type DigestInput, type EodDigest, type TickRow } from '../lib/eodDigest';
import { ReplayRunner } from '../lib/surveillanceReplay';
import { istDate } from '../lib/auditDossier';
import type { IntradayProfile } from '../lib/volumeBaseline';

type Fetch = typeof fetch;
export interface DigestEnv { url?: string; key?: string }

async function getAll<T>(f: Fetch, env: Required<DigestEnv>, path: string, page = 1000): Promise<T[] | null> {
  const out: T[] = [];
  for (let off = 0; off < 200_000; off += page) {
    const r = await f(`${env.url.replace(/\/+$/, '')}/rest/v1/${path}${path.includes('?') ? '&' : '?'}limit=${page}&offset=${off}`, { headers: { apikey: env.key, Authorization: `Bearer ${env.key}` } }).catch(() => null);
    if (!r || !r.ok) return off === 0 ? null : out;
    const rows = (await r.json()) as T[];
    out.push(...rows); if (rows.length < page) break;
  }
  return out;
}

/** day's persisted data → digest input; null when the project cannot be reached or nothing was persisted for `date` */
export async function loadLiveInput(date: string, env: DigestEnv, f: Fetch = fetch): Promise<DigestInput | null> {
  if (!env.url || !env.key) return null;
  const e = { url: env.url, key: env.key };
  const [ticks, circ, flags, bases] = await Promise.all([
    getAll<{ symbol: string; ltp: number; volume: number; ts: string }>(f, e, `market_ticks?select=symbol,ltp,volume,ts&trading_date=eq.${date}&order=symbol.asc,ts.asc`),
    getAll<{ symbol: string; direction: 'UPPER' | 'LOWER'; price: number; detected_at: string; source: string }>(f, e, `circuit_events?select=symbol,direction,price,detected_at,source&trade_date=eq.${date}`),
    getAll<{ symbol: string; kind: 'wall' | 'add_cancel'; side: 'bid' | 'ask'; flagged_at: string; confirmed_by: string[] | null }>(f, e, `depth_flags?select=symbol,kind,side,flagged_at,confirmed_by&flagged_at=gte.${date}T00:00:00%2B05:30&flagged_at=lt.${date}T23:59:59%2B05:30`),
    getAll<{ symbol: string; status: string; profile: { cum: number[]; sessions: number } | null }>(f, e, 'volume_baselines?select=symbol,status,profile'),
  ]);
  if (!ticks?.length && !circ?.length && !flags?.length) return null;
  const rows: TickRow[] = (ticks ?? []).map((t) => ({ symbol: t.symbol, ts: Date.parse(t.ts), ltp: Number(t.ltp), volume: Number(t.volume) })).filter((t) => Number.isFinite(t.ts));
  const profiles: Record<string, IntradayProfile | null> = {};
  for (const b of bases ?? []) profiles[b.symbol] = b.status === 'ok' && b.profile?.cum?.length === 25 ? { status: 'ok', cum: b.profile.cum, sessions: b.profile.sessions } : null;
  return {
    date, source: 'live', ticks: rows.length,
    flags: (flags ?? []).map((x) => ({ symbol: x.symbol, kind: x.kind, side: x.side, at: Date.parse(x.flagged_at), confirmed: Array.isArray(x.confirmed_by) && x.confirmed_by.length >= 2, hits: x.confirmed_by ?? [], obi: null, volRatio: null, origin: 'daemon' as const })),
    surges: surgesFromTicks(rows, profiles).surges,
    obi: [],                                                   // depth snapshots are not persisted, so no OBI readings exist for a past day (flags that OBI corroborated are still listed)
    circuit: (circ ?? []).map((c) => ({ symbol: c.symbol, direction: c.direction, price: Number(c.price), at: Date.parse(c.detected_at), source: c.source })),
  };
}

export async function digestFor(date: string, opts: { offline?: boolean; env?: DigestEnv; fetch?: Fetch } = {}): Promise<EodDigest> {
  if (!opts.offline) {
    const input = await loadLiveInput(date, opts.env ?? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, opts.fetch);
    if (input) return buildDigest(input);
  }
  const run = new ReplayRunner(); run.runAll();
  return buildDigest(digestInputFromRunner(run));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2), get = (k: string) => { const i = argv.indexOf(`--${k}`); return i < 0 ? '' : argv[i + 1] ?? ''; };
  const date = get('date') || istDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('bad --date'); process.exit(2); }
  const d = await digestFor(date, { offline: argv.includes('--offline') });
  console.log(`${d.banner}\nDate ${d.date} · ${d.source}`);
  console.log('Top R(t):', d.topSurges.map((x) => `${x.symbol} ${x.peakRt}×`).join(', ') || 'N/A');
  console.log('Top OBI :', d.topObi.map((x) => `${x.symbol} ${x.obi ?? 'n/a'}`).join(', ') || 'N/A');
  console.log('Circuit :', d.circuitTouches.map((x) => `${x.symbol} ${x.direction}`).join(', ') || 'none');
  console.log(`Flags   : ${d.suppression.total} total · ${d.suppression.confirmed} Multi-Signal Confirmed · ${d.suppression.baselineOnly} Baseline-only · suppressed ${d.suppression.suppressedPct ?? 'N/A'} %`);
  const out = get('out');
  if (out) { writeFileSync(out, JSON.stringify(d, null, 2) + '\n'); console.log(`wrote ${out}`); }
}
if (process.argv[1] && /eod-digest\.(ts|js|mjs|cjs)$/.test(process.argv[1])) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
