// "SEBI white-box surveillance & audit dossier": one structured JSON (and a printable report built from it) that records what the platform did, with which rules and
// formulas, on whose session — so a reviewer can trace every figure. It is a record of an automated screening tool, not investment advice, and not a SEBI filing.
// Pure and deterministic given its input (no network, no clock except `now`); secrets are redacted defensively before anything is returned.
import { stagesOf, summarize } from './deliveryLatency';
import { DISCLOSURE_POINTS, DISCLOSURE_VERSION } from './disclosure';
import { CONFIRM_PARAMS, FLAG_DISCLAIMER, FLAG_PARAMS, flagTag, levelWeights, obiOfBook, type DepthFlag } from './heuristicFlags';
import type { AlertDelivery, AlertRuleRow } from './cloud';
import type { DaemonBeat } from './feedHealth';
import type { QuietHours } from './quietHours';
import type { ExitRisk } from './analytics/slippage';
import type { DepthLevel } from './types';
import type { EodDigest } from './eodDigest';

export const DOSSIER_SCHEMA = 'upcircuit.surveillance-audit/1';
export const DOSSIER_FRAMING = 'White-box transparency record: the rule logic, parameters and formulas below are the ones that produced the figures shown. UpCircuit is an analytics and educational telemetry tool, not a SEBI-registered Investment Adviser or Research Analyst; nothing here is investment advice. Heuristic flags are patterns in resting orders, never proof of manipulation or of anyone’s intent.';

export interface DossierInput {
  now: number;
  session: { userId: string | null; sessionId: string | null } | null;
  disclosureAcknowledged: boolean;
  feed: { mode: string; connection: string; lastTickAgeMs: number | null };
  /** rows of public.daemon_health(); null = could not be read */
  daemon: DaemonBeat[] | null;
  rules: AlertRuleRow[];
  quietHours: QuietHours | null;
  deliveries: AlertDelivery[];
  symbol: string;
  ltp: number | null;
  depth: { bids: readonly DepthLevel[]; asks: readonly DepthLevel[]; live: boolean };
  volume: { cumulative: number | null; expectedByNow: number | null; multiple: number | null; surge15: number | null; profileSessions: number | null };
  exitRisk: ExitRisk | null;
  flags: (Pick<DepthFlag, 'symbol' | 'kind' | 'side' | 'severity' | 'ts' | 'detail' | 'label'> & { confirmation?: { confirmed: boolean; hits: string[] } | null; source?: string })[];
  /** the Daily Market Surveillance Digest as shown on the desk (live data or the labelled replay); null = not available */
  digest?: EodDigest | null;
  backtest: { precision?: number | null; recall?: Record<string, { rate?: number | null } | undefined>; data?: { snapshots?: number }; modes?: unknown; sensitivity?: unknown; assumptions?: unknown; config?: Record<string, unknown> } | null;
}

const IST = (ms: number) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', '') + ' IST';
export const istDate = (ms: number): string => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
export const dossierFileName = (ms: number): string => `upcircuit-surveillance-audit-${istDate(ms)}.json`;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString();
const r = (x: number | null | undefined, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

/* ───────────── secret redaction ───────────── */
const SECRET_KEY = /(secret|password|passwd|token|api[-_]?key|apikey|authorization|bearer|private|credential|totp|p256dh|endpoint|cookie|service[-_]?role|anon[-_]?key|vapid)/i;
const SECRET_VALUE: RegExp[] = [/sb_secret_[A-Za-z0-9_-]+/g, /sb_publishable_[A-Za-z0-9_-]+/g, /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, /\bre_[A-Za-z0-9]{16,}\b/g, /AIza[0-9A-Za-z_-]{20,}/g, /https:\/\/(?:fcm\.googleapis\.com|[a-z0-9.-]*push\.apple\.com|[a-z0-9.-]*notify\.windows\.com|updates\.push\.services\.mozilla\.com)\/\S+/g, /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g];
export const REDACTED = '[redacted]';
/** deep copy with secret-looking keys dropped and secret-looking substrings masked; `count` reports how many were touched */
export function redactSecrets<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') { let s = v; for (const re of SECRET_VALUE) s = s.replace(re, () => { count++; return REDACTED; }); return s; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (SECRET_KEY.test(k)) { count++; continue; } o[k] = walk(x); }
      return o;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}

/* ───────────── the dossier ───────────── */
export interface AuditDossier {
  schema: typeof DOSSIER_SCHEMA;
  framing: string;
  meta: {
    generatedAt: string; generatedAtIST: string; platform: string; disclosureVersion: string;
    session: { userId: string | null; sessionId: string | null };
    disclosure: { acknowledgedThisSession: boolean; statements: readonly string[] };
    redactions: number;
  };
  ha: {
    state: 'leader_active' | 'standby_only' | 'no_heartbeat' | 'unavailable';
    leaderEpoch: number | null; leaseRemainingMs: number | null;
    heartbeats: { role: 'leader' | 'standby' | 'unknown'; id: string; heartbeatAgeMs: number; feed: string; lastTickAgeMs: number | null; reconnects: number; startedAt: string; version: string | null }[];
    browserFeed: DossierInput['feed'];
    note: string;
  };
  alerting: {
    rules: { id: string; symbol: string; kind: string; threshold: number; cooldownMin: number; channels: Record<string, boolean | undefined>; enabled: boolean; lastTriggeredAt: string | null }[];
    quietHours: { enabled: boolean; window: string; timeZone: string } | null;
  };
  deliveries: {
    count: number;
    latencySummary: ReturnType<typeof summarize> | null;
    rows: { firedAt: string; symbol: string; kind: string; channel: string; status: string; price: number | null; stagesMs: ReturnType<typeof stagesOf>; serviceWorkerAckAt: string | null; displayedAt: string | null }[];
  };
  surveillance: {
    symbol: string; ltp: number | null; depthLive: boolean;
    orderBookImbalance: { lambda: number; formula: string; value: number | null; levels: { level: number; weight: number; bidQty: number | null; askQty: number | null }[] };
    volume: DossierInput['volume'] & { formula: string };
    circuitLock: { formula: string; risk: ExitRisk | null };
    flags: { symbol: string; pattern: string; side: string; severity: string; at: string; tag: string; corroboratedBy: string[]; source: string | null; detail: string; label: string }[];
    heuristicSummary: { total: number; confirmed: number; baseline: number };
  };
  dailyDigest: EodDigest | null;
  methodology: {
    rules: { wallDetection: string; addCancelDetection: string; confirmation: string; cooldown: string };
    parameters: { flag: typeof FLAG_PARAMS; confirmation: typeof CONFIRM_PARAMS };
    formulas: Record<string, string>;
    backtest: { description: string; precision: number | null; recall: Record<string, number | null>; snapshots: number | null; modes: unknown; sensitivity: unknown; assumptions: unknown };
    limitations: string[];
    flagDisclaimer: string;
  };
  integrity?: { algorithm: 'SHA-256'; digest: string; covers: string };
}

export function buildDossier(i: DossierInput): AuditDossier {
  const beats = i.daemon === null ? null : i.daemon;
  const heartbeats = (beats ?? []).map((b) => ({
    role: b.id === 'alert-daemon' ? ('leader' as const) : b.id === 'alert-daemon-standby' ? ('standby' as const) : ('unknown' as const), id: b.id, heartbeatAgeMs: b.age_ms, feed: b.feed_status,
    lastTickAgeMs: b.last_tick_age_ms, reconnects: b.reconnects, startedAt: b.started_at, version: b.version,
  }));
  const leader = heartbeats.find((h) => h.role === 'leader' && h.heartbeatAgeMs < 20_000);
  const epoch = (beats ?? []).find((b) => b.lease_epoch !== null && b.lease_epoch !== undefined)?.lease_epoch ?? null;
  const ttl = (beats ?? []).find((b) => b.lease_ttl_ms !== null && b.lease_ttl_ms !== undefined)?.lease_ttl_ms ?? null;
  const lam = CONFIRM_PARAMS.LAMBDA, w = levelWeights(lam);
  const sorted = (a: readonly DepthLevel[], side: 'bid' | 'ask') => a.filter((l) => l && l.price > 0 && l.qty > 0).sort((x, y) => (side === 'bid' ? y.price - x.price : x.price - y.price)).slice(0, 5);
  const bids = sorted(i.depth.bids, 'bid'), asks = sorted(i.depth.asks, 'ask');
  const live = i.depth.live && (bids.length > 0 || asks.length > 0);
  const flags = i.flags.map((f) => ({
    symbol: f.symbol, pattern: f.kind === 'wall' ? 'resting-order wall (spoof_wall candidate)' : 'rapid add/cancel (flicker candidate)', side: f.side, severity: f.severity, at: iso(f.ts), tag: flagTag({ confirmation: f.confirmation ?? undefined }),
    corroboratedBy: f.confirmation?.confirmed ? f.confirmation.hits : [], source: f.source ?? null, detail: f.detail, label: f.label,
  }));
  const bt = i.backtest;
  const body: AuditDossier = {
    schema: DOSSIER_SCHEMA,
    framing: DOSSIER_FRAMING,
    meta: {
      generatedAt: iso(i.now), generatedAtIST: IST(i.now), platform: 'UpCircuit — real-time stock analytics & surveillance for Indian equities', disclosureVersion: DISCLOSURE_VERSION,
      session: { userId: i.session?.userId ?? null, sessionId: i.session?.sessionId ?? null },
      disclosure: { acknowledgedThisSession: i.disclosureAcknowledged, statements: DISCLOSURE_POINTS }, redactions: 0,
    },
    ha: {
      state: beats === null ? 'unavailable' : leader ? 'leader_active' : heartbeats.length ? 'standby_only' : 'no_heartbeat',
      leaderEpoch: epoch, leaseRemainingMs: ttl, heartbeats, browserFeed: i.feed,
      note: 'Only the leader writes the "alert-daemon" heartbeat; a warm standby writes "alert-daemon-standby". The epoch is the lease fencing token — it rises by one on every change of leader. Ages use the database clock. N/A fields were not available to this account.',
    },
    alerting: {
      rules: i.rules.map((x) => ({ id: x.id, symbol: x.symbol, kind: x.kind, threshold: x.threshold, cooldownMin: x.cooldown_min, channels: { ...x.channels }, enabled: x.enabled, lastTriggeredAt: x.last_triggered_at })),
      quietHours: i.quietHours ? { enabled: i.quietHours.enabled, window: `${hhmm(i.quietHours.start)}–${hhmm(i.quietHours.end)}`, timeZone: i.quietHours.tz } : null,
    },
    deliveries: {
      count: i.deliveries.length, latencySummary: i.deliveries.length ? summarize(i.deliveries) : null,
      rows: i.deliveries.map((d) => ({ firedAt: d.fired_at, symbol: d.symbol, kind: d.kind, channel: d.channel, status: d.status, price: d.price, stagesMs: stagesOf(d), serviceWorkerAckAt: d.sw_ack_at ?? null, displayedAt: d.displayed_at ?? null })),
    },
    surveillance: {
      symbol: i.symbol, ltp: r(i.ltp, 2), depthLive: live,
      orderBookImbalance: {
        lambda: lam, formula: 'OBI_λ = Σᵢ wᵢ(Bᵢ − Aᵢ) ÷ Σᵢ wᵢ(Bᵢ + Aᵢ),  wᵢ = e^(−λ(i−1)),  i = 1 (best price) … 5;  Bᵢ / Aᵢ = bid / ask quantity at level i',
        value: live ? r(obiOfBook(bids, asks, lam)) : null,
        levels: w.map((wt, k) => ({ level: k + 1, weight: r(wt, 4) as number, bidQty: bids[k]?.qty ?? null, askQty: asks[k]?.qty ?? null })),
      },
      volume: { ...i.volume, formula: 'multiple = cumulative volume ÷ typical cumulative volume at the same minute (median profile, 25 buckets of 15 min, ≥ 10 sessions); R(t) = volume of the last 15 min ÷ typical volume of the same 15 min' },
      circuitLock: { formula: `warn if LTP is within ${1.5}% of the upper or lower circuit price, or if the order-book side an exit would consume holds < 25% of its session median depth`, risk: i.exitRisk },
      flags, heuristicSummary: { total: flags.length, confirmed: flags.filter((f) => f.tag === 'Multi-Signal Confirmed').length, baseline: flags.filter((f) => f.tag === 'Baseline Flag').length },
    },
    dailyDigest: i.digest ?? null,
    methodology: {
      rules: {
        wallDetection: `a level holding ≥ ${FLAG_PARAMS.WALL_MULT}× the median of the other top-5 levels on its side, ≥ ${FLAG_PARAMS.WALL_MIN_QTY} shares and ≥ ${Math.round(FLAG_PARAMS.WALL_MIN_SHARE * 100)}% of that side's top-5 quantity ("elevated" at ≥ ${FLAG_PARAMS.WALL_MULT_HIGH}×)`,
        addCancelDetection: 'repeated add → cancel (without a fill) cycles at the same price level inside a rolling window; the price not trading through the level distinguishes a cancel from a fill',
        confirmation: `"Multi-Signal Confirmed" = at least ${CONFIRM_PARAMS.MIN_SIGNALS} of 3 corroborate: |OBI_λ| ≥ ${CONFIRM_PARAMS.OBI_MIN}; R(t) ≥ ${CONFIRM_PARAMS.SURGE_MIN}; spread ≥ ${CONFIRM_PARAMS.SPREAD_MULT}× its rolling median. A reading that cannot be computed is N/A and cannot confirm. Otherwise the flag is a "Baseline Flag" (single rule).`,
        cooldown: `the same flag is not repeated within ${FLAG_PARAMS.COOLDOWN_MS / 1000} s`,
      },
      parameters: { flag: FLAG_PARAMS, confirmation: CONFIRM_PARAMS },
      formulas: {
        obi: 'OBI_λ = Σ wᵢ(Bᵢ − Aᵢ) ÷ Σ wᵢ(Bᵢ + Aᵢ),  wᵢ = e^(−λ(i−1))',
        volumeSurge: 'R(t) = [V(t) − V(t − W)] ÷ [E(t) − E(t − W)],  W = 15 min,  E = typical (median) cumulative volume profile',
        spreadWidening: 'spread(t) ÷ median(spread over the previous 120 snapshots) ≥ 1.5',
        slippage: 'VWAP fill = Σ pᵢqᵢ ÷ Σ qᵢ over the top-5 levels walked; slippage = VWAP − best price (₹ and bps)',
      },
      backtest: {
        description: 'Deterministic synthetic L2 replay with no look-ahead bias (every signal uses data available at the flag time). Labels come from the generator, so precision/recall describe agreement with the generator’s own pattern definitions under an assumed noise and volume model — not real-market manipulation.',
        precision: r(bt?.precision), recall: { spoof_wall: r(bt?.recall?.spoof_wall?.rate), flicker: r(bt?.recall?.flicker?.rate) }, snapshots: bt?.data?.snapshots ?? null,
        modes: bt?.modes ?? null, sensitivity: bt?.sensitivity ?? null, assumptions: bt?.assumptions ?? null,
      },
      limitations: [
        'Heuristic flags are screening hints; icebergs, market-maker re-quoting and normal risk management look similar.',
        'The browser samples depth twice a second; the daemon sees every tick it is subscribed to, so the two can differ.',
        'Order-book depth is only available during the live session; outside it every depth-derived figure is N/A.',
        'Backtest figures are synthetic; the volume signal rests on an assumed link between volume bursts and the injected patterns.',
      ],
      flagDisclaimer: FLAG_DISCLAIMER,
    },
  };
  const red = redactSecrets(body);
  red.value.meta.redactions = red.count;
  return red.value;
}

/** adds a SHA-256 over the canonical JSON of everything except `integrity` (key order is the build order, so the same input hashes the same) */
export async function sealDossier(d: AuditDossier): Promise<AuditDossier> {
  const { integrity: _drop, ...rest } = d; void _drop;
  const bytes = new TextEncoder().encode(JSON.stringify(rest));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const digest = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { ...rest, integrity: { algorithm: 'SHA-256', digest, covers: 'the canonical JSON of this file without the integrity block' } };
}

/* ───────────── printable report (HTML → print / "Save as PDF") ───────────── */
const esc = (s: unknown): string => String(s ?? 'N/A').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const na = (x: unknown) => (x === null || x === undefined ? 'N/A' : esc(x));
export function dossierToHtml(d: AuditDossier): string {
  const tbl = (head: string[], rows: unknown[][]) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${na(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}">None</td></tr>`}</tbody></table>`;
  const ms = (x: number | null) => (x === null ? 'N/A' : `${Math.round(x)} ms`);
  const s = d.surveillance, m = d.methodology;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UpCircuit surveillance audit · ${esc(d.meta.generatedAtIST)}</title>
<style>
:root{color-scheme:light}body{font:12px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#fff;margin:0;padding:24px;max-width:960px;margin-inline:auto}
h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:22px 0 6px;padding-bottom:3px;border-bottom:2px solid #0f766e;color:#0f766e}h3{font-size:12px;margin:12px 0 4px}
table{width:100%;border-collapse:collapse;margin:6px 0;font-size:11px}th,td{border:1px solid #cbd5e1;padding:3px 6px;text-align:left;vertical-align:top}th{background:#f1f5f9}
code,.f{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:11px}.note{border:1px solid #cbd5e1;background:#f8fafc;padding:8px;border-radius:6px}
.muted{color:#475569}.tag{font-weight:700}button{font:inherit;padding:6px 12px;margin:0 0 12px;cursor:pointer}@media print{button{display:none}body{padding:0}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}
</style></head><body>
<button type="button" id="print">Print / Save as PDF</button>
<h1>UpCircuit — Surveillance &amp; Alert Audit Dossier</h1>
<p class="muted">${esc(d.schema)} · generated ${esc(d.meta.generatedAtIST)} (${esc(d.meta.generatedAt)})</p>
<p class="note">${esc(d.framing)}</p>
<h2>1 · Platform &amp; session</h2>
${tbl(['Field', 'Value'], [['Platform', d.meta.platform], ['Generated (IST)', d.meta.generatedAtIST], ['User ID', d.meta.session.userId], ['Login session ID', d.meta.session.sessionId], ['Disclosure version', d.meta.disclosureVersion], ['SEBI non-registration / self-responsibility disclosure acknowledged this session', d.meta.disclosure.acknowledgedThisSession ? 'Yes' : 'No'], ['Secrets redacted from this file', d.meta.redactions]])}
<ul>${d.meta.disclosure.statements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>2 · Alert-daemon high-availability state</h2>
<p><b>State:</b> ${esc(d.ha.state.replace(/_/g, ' '))} · <b>lease epoch:</b> ${na(d.ha.leaderEpoch)} · <b>lease remaining:</b> ${ms(d.ha.leaseRemainingMs)} · <b>browser feed:</b> ${esc(d.ha.browserFeed.mode)} / ${esc(d.ha.browserFeed.connection)}, last tick ${ms(d.ha.browserFeed.lastTickAgeMs)} ago</p>
${tbl(['Role', 'Heartbeat age', 'Feed', 'Last tick age', 'Reconnects', 'Started', 'Version'], d.ha.heartbeats.map((h) => [h.role, ms(h.heartbeatAgeMs), h.feed, ms(h.lastTickAgeMs), h.reconnects, h.startedAt, h.version]))}
<p class="muted">${esc(d.ha.note)}</p>
<h2>3 · Active alert rules &amp; quiet hours</h2>
${tbl(['Symbol', 'Rule', 'Threshold', 'Cooldown (min)', 'Channels', 'Enabled', 'Last triggered'], d.alerting.rules.map((x) => [x.symbol, x.kind, x.threshold, x.cooldownMin, Object.entries(x.channels).filter(([, v]) => v).map(([k]) => k).join(' + ') || 'none', x.enabled ? 'yes' : 'no', x.lastTriggeredAt]))}
<p><b>Quiet hours:</b> ${d.alerting.quietHours ? (d.alerting.quietHours.enabled ? `${esc(d.alerting.quietHours.window)} (${esc(d.alerting.quietHours.timeZone)})` : 'configured but off') : 'not set'}</p>
<h2>4 · Recent alert deliveries &amp; service-worker ACK latency</h2>
${d.deliveries.latencySummary ? `<p>p50 cross-to-push ${ms(d.deliveries.latencySummary.p50.crossToPush)} · p95 ${ms(d.deliveries.latencySummary.p95.crossToPush)} · ${d.deliveries.latencySummary.acked} of ${d.deliveries.latencySummary.rows} acknowledged by a service worker</p>` : '<p>No deliveries recorded.</p>'}
${tbl(['Fired', 'Symbol', 'Rule', 'Channel', 'Status', 'Tick→match', 'Match→push', 'Push→ACK', 'Push→display', 'SW ACK at'], d.deliveries.rows.map((x) => [x.firedAt, x.symbol, x.kind, x.channel, x.status, ms(x.stagesMs.tickToMatchMs), ms(x.stagesMs.matchToPushMs), ms(x.stagesMs.pushToAckMs), ms(x.stagesMs.pushToDisplayMs), x.serviceWorkerAckAt]))}
<h2>5 · Live surveillance readings · ${esc(s.symbol)}</h2>
<p>LTP ${na(s.ltp)} · order-book depth ${s.depthLive ? 'live' : 'N/A (not streaming)'}</p>
<h3>Top-5 order-book imbalance (λ = ${esc(s.orderBookImbalance.lambda)}): <span class="tag">${na(s.orderBookImbalance.value)}</span></h3>
<p><span class="f">${esc(s.orderBookImbalance.formula)}</span></p>
${tbl(['Level', 'Weight wᵢ', 'Bid qty', 'Ask qty'], s.orderBookImbalance.levels.map((l) => [l.level, l.weight, l.bidQty, l.askQty]))}
<h3>Volume</h3>${tbl(['Cumulative', 'Expected by now', 'Multiple', 'R(t) 15-min surge', 'Profile sessions'], [[s.volume.cumulative, s.volume.expectedByNow, s.volume.multiple, s.volume.surge15, s.volume.profileSessions]])}<p><span class="f">${esc(s.volume.formula)}</span></p>
<h3>Circuit-lock exit risk</h3><p>${s.circuitLock.risk ? (s.circuitLock.risk.warn ? `<b>WARNING</b> — ${esc(s.circuitLock.risk.message)}` : 'No warning at the current reading.') : 'N/A (market closed or depth unavailable)'}</p><p><span class="f">${esc(s.circuitLock.formula)}</span></p>
<h3>Heuristic flags — ${s.heuristicSummary.confirmed} Multi-Signal Confirmed · ${s.heuristicSummary.baseline} Baseline</h3>
${tbl(['At', 'Symbol', 'Pattern', 'Side', 'Severity', 'Tag', 'Corroborated by', 'Source'], s.flags.map((f) => [f.at, f.symbol, f.pattern, f.side, f.severity, f.tag, f.corroboratedBy.join(' + ') || '—', f.source]))}
<p class="muted">${esc(m.flagDisclaimer)}</p>
<h2>6 · Daily market surveillance digest</h2>
${d.dailyDigest ? `<p>${esc(d.dailyDigest.banner)} · ${esc(d.dailyDigest.date)}</p>
${tbl(['Symbol', 'Peak R(t)', 'At'], d.dailyDigest.topSurges.map((x) => [x.symbol, `${x.peakRt}×`, x.at]))}
${tbl(['Symbol', 'OBI_λ', 'At', 'Basis'], d.dailyDigest.topObi.map((x) => [x.symbol, x.obi, x.at, x.basis === 'reading' ? 'reading' : 'flag corroboration only']))}
${tbl(['Symbol', 'Circuit', 'Price', 'At'], d.dailyDigest.circuitTouches.map((x) => [x.symbol, x.direction, x.price, x.at]))}
<p>Flags: ${d.dailyDigest.suppression.total} total · ${d.dailyDigest.suppression.confirmed} Multi-Signal Confirmed · ${d.dailyDigest.suppression.baselineOnly} Baseline-only · suppression ratio ${na(d.dailyDigest.suppression.suppressedPct === null ? null : `${d.dailyDigest.suppression.suppressedPct} %`)}</p><p class="muted">${esc(d.dailyDigest.suppression.note)}</p>` : '<p>N/A</p>'}
<h2>7 · White-box methodology</h2>
<ul><li><b>Wall:</b> ${esc(m.rules.wallDetection)}</li><li><b>Add/cancel:</b> ${esc(m.rules.addCancelDetection)}</li><li><b>Confirmation:</b> ${esc(m.rules.confirmation)}</li><li><b>Cooldown:</b> ${esc(m.rules.cooldown)}</li></ul>
${tbl(['Formula', 'Definition'], Object.entries(m.formulas))}
<p><b>Backtest.</b> ${esc(m.backtest.description)} Baseline precision ${na(m.backtest.precision)}, recall spoof_wall ${na(m.backtest.recall.spoof_wall)} / flicker ${na(m.backtest.recall.flicker)} over ${na(m.backtest.snapshots)} snapshots; the full baseline-vs-confirmed comparison, sensitivity runs and assumptions are in the JSON file.</p>
<h3>Limitations</h3><ul>${m.limitations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
${d.integrity ? `<p class="muted">Integrity: ${esc(d.integrity.algorithm)} <code>${esc(d.integrity.digest)}</code> over the companion JSON (${esc(d.integrity.covers)}).</p>` : ''}
</body></html>`;
}
