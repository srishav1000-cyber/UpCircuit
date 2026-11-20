// Week 11 final: EOD surveillance digest, live replay sandbox (real pipeline), portfolio surveillance overlay, wiring and hygiene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ReplayRunner, buildReplay, REPLAY_START_MS, REPLAY_DISCLOSURE, SIM_RULES } from '../lib/surveillanceReplay';
import { buildDigest, chooseDigest, digestInputFromRunner, replayDigest, surgesFromTicks, uniformProfile, type DigestInput, type TickRow } from '../lib/eodDigest';
import { holdingsSurveillance, PORTFOLIO_NEAR_PCT, type SurvInput } from '../lib/analytics/portfolioSurveillance';
import { digestFor, loadLiveInput } from '../scripts/eod-digest';
import { buildDossier, dossierToHtml } from '../lib/auditDossier';
import { istMinuteOf } from '../lib/volumeBaseline';

const minOf = (r: ReplayRunner, ts: number) => (ts - r.scenario.startMs) / 60_000;

/* ───────── replay sandbox: the real pipeline on a scripted burst ───────── */
test('replay scenario is deterministic, inside the session, and labelled as a simulation', () => {
  const a = buildReplay(), b = buildReplay();
  assert.deepEqual(a.frames, b.frames);
  const m = istMinuteOf(REPLAY_START_MS); assert.ok(m >= 9 * 60 + 15 && m < 15 * 60 + 30);
  assert.deepEqual(a.symbols, ['RELIANCE', 'TCS', 'INFY']);
  assert.match(REPLAY_DISCLOSURE, /SIMULATION/); assert.match(REPLAY_DISCLOSURE, /no real alert/);
  for (const f of a.frames) { assert.ok(f.bids.length === 5 && f.asks.length === 5); assert.ok(f.bids[0].price < f.asks[0].price, 'book never crossed'); }
});

test('replay burst through heuristicFlags + depthImbalance + volumeBaseline: confirmed vs baseline-only, R(t), OBI, circuit', () => {
  const r = new ReplayRunner(); const all = r.runAll();
  assert.ok(r.done && r.progress === 1);
  // R(t) is N/A until 5 minutes of history exist
  assert.ok(all.filter((x) => minOf(r, x.t) < 4.9).every((x) => x.volRatio === null));
  assert.ok(all.some((x) => x.symbol === 'RELIANCE' && x.volRatio! >= SIM_RULES.surge));
  assert.ok(all.filter((x) => x.symbol === 'TCS' && x.volRatio !== null).every((x) => x.volRatio! < 1.2), 'TCS volume stays normal');
  // RELIANCE wall during the burst: corroborated by OBI + volume
  const rw = r.flags.filter((f) => f.symbol === 'RELIANCE' && f.kind === 'wall' && f.side === 'bid');
  assert.ok(rw.length && rw.every((f) => f.confirmation?.confirmed && f.confirmation.hits.includes('obi') && f.confirmation.hits.includes('volume')));
  assert.ok(rw.every((f) => minOf(r, f.ts) >= 10 && minOf(r, f.ts) < 12));
  // TCS wall: single rule only → Baseline
  const tw = r.flags.filter((f) => f.symbol === 'TCS' && f.kind === 'wall');
  assert.ok(tw.length && tw.every((f) => f.confirmation && !f.confirmation.confirmed));
  // the flickering ask order alone is a volume-only baseline flag
  const fl = r.flags.filter((f) => f.symbol === 'RELIANCE' && f.kind === 'add_cancel' && minOf(r, f.ts) > 14);
  assert.ok(fl.length && fl.every((f) => !f.confirmation?.confirmed));
  // a quiet book produces no flags at all (no jitter noise)
  assert.equal(r.flags.filter((f) => minOf(r, f.ts) < 5).length, 0);
  // OBI is signed and large on the wall / thin ask
  assert.ok(all.some((x) => x.symbol === 'RELIANCE' && x.obi! > 0.35));
  assert.ok(all.some((x) => x.symbol === 'INFY' && x.obi! > 0.6));
  // circuit
  const infyLast = all.filter((x) => x.symbol === 'INFY').pop()!;
  assert.equal(infyLast.toUpperPct, 0);
  assert.ok(r.alerts.some((a) => a.kind === 'circuit_touch' && a.symbol === 'INFY'));
  assert.ok(r.alerts.some((a) => a.kind === 'circuit_proximity' && a.symbol === 'INFY'));
  // simulated alerts: all labelled simulated; confirmed flag + surge triggers present; cooldown holds
  assert.ok(r.alerts.every((a) => a.channel === 'simulated-push'));
  for (const k of ['confirmed_flag', 'volume_surge', 'order_imbalance'] as const) assert.ok(r.alerts.some((a) => a.kind === k), k);
  const surgeTimes = r.alerts.filter((a) => a.kind === 'volume_surge' && a.symbol === 'RELIANCE').map((a) => a.t);
  assert.ok(surgeTimes.every((t, i) => i === 0 || t - surgeTimes[i - 1] >= SIM_RULES.cooldownMs));
});

test('sandbox stepping (what the UI does) matches the batch run, can reset, and never mutates the scenario', () => {
  const sc = buildReplay(); const snapshot = JSON.stringify(sc.frames);
  const a = new ReplayRunner(sc); let ticks = 0; while (!a.done) { assert.equal(a.stepTick().length, 3); ticks++; }
  assert.equal(ticks, (24 * 60) / 5 + 1);
  assert.equal(JSON.stringify(sc.frames), snapshot, 'frames untouched');
  const b = new ReplayRunner(sc); b.runAll();
  assert.deepEqual(a.flags.map((f) => [f.symbol, f.kind, f.ts, f.confirmation?.confirmed]), b.flags.map((f) => [f.symbol, f.kind, f.ts, f.confirmation?.confirmed]));
  a.reset(); assert.equal(a.readings.length, 0); assert.equal(a.flags.length, 0); assert.equal(a.progress, 0);
  a.runAll(); assert.equal(a.flags.length, b.flags.length, 'a reset run reproduces the first');
});

/* ───────── EOD digest ───────── */
const T = Date.UTC(2026, 10, 18, 6, 0);
const base = (): DigestInput => ({
  date: '2026-11-18', source: 'live', ticks: 100,
  flags: [
    { symbol: 'AAA', kind: 'wall', side: 'bid', at: T, confirmed: true, hits: ['obi', 'volume'], obi: 0.5, volRatio: 2.2, origin: 'daemon' },
    { symbol: 'AAA', kind: 'add_cancel', side: 'ask', at: T + 1, confirmed: false, hits: ['volume'], obi: null, volRatio: null, origin: 'daemon' },
    { symbol: 'BBB', kind: 'wall', side: 'ask', at: T + 2, confirmed: false, hits: [], obi: null, volRatio: null, origin: 'daemon' },
    { symbol: 'CCC', kind: 'wall', side: 'bid', at: T + 3, confirmed: false, hits: ['obi'], obi: null, volRatio: null, origin: 'daemon' },
  ],
  surges: [{ symbol: 'AAA', rt: 2, at: T }, { symbol: 'AAA', rt: 3.5, at: T + 5 }, { symbol: 'BBB', rt: 1.1, at: T }, { symbol: 'DDD', rt: 5, at: T }],
  obi: [{ symbol: 'AAA', value: -0.8, at: T }, { symbol: 'AAA', value: 0.4, at: T + 9 }, { symbol: 'BBB', value: 0.2, at: T }],
  circuit: [{ symbol: 'EEE', direction: 'UPPER', price: 110, at: T + 7, source: 'smartapi' }, { symbol: 'EEE', direction: 'UPPER', price: 110, at: T + 9, source: 'session' }, { symbol: 'EEE', direction: 'LOWER', price: 90, at: T + 8, source: 'session' }],
});
test('digest: peaks per symbol, ranked; circuit touches de-duplicated; suppression ratio', () => {
  const d = buildDigest(base());
  assert.deepEqual(d.topSurges.map((x) => [x.symbol, x.peakRt]), [['DDD', 5], ['AAA', 3.5], ['BBB', 1.1]]);
  assert.deepEqual(d.topObi.map((x) => [x.symbol, x.obi, x.basis]), [['AAA', -0.8, 'reading'], ['BBB', 0.2, 'reading'], ['CCC', null, 'flag_corroboration_only']]);
  assert.equal(d.circuitTouches.length, 2); assert.equal(d.circuitTouches.find((c) => c.direction === 'UPPER')!.source, 'smartapi');
  assert.deepEqual([d.suppression.total, d.suppression.confirmed, d.suppression.baselineOnly, d.suppression.suppressedPct], [4, 1, 3, 75]);
  assert.deepEqual(d.suppression.byKind.wall, { total: 3, confirmed: 1 });
  assert.match(d.suppression.note, /not a measured false-positive rate/);
  assert.equal(d.source, 'live'); assert.equal(d.status, 'ok');
});
test('digest: N/A when nothing was recorded — never zeros that look like data', () => {
  const d = buildDigest({ date: '2026-11-18', source: 'live', flags: [], surges: [], obi: [], circuit: [], ticks: null });
  assert.equal(d.status, 'na'); assert.equal(d.suppression.suppressedPct, null); assert.deepEqual(d.topSurges, []);
});
test('digest: offline / market-closed replay is deterministic, labelled, and shows all four sections', () => {
  const a = replayDigest(), b = replayDigest(); assert.deepEqual(a, b);
  assert.equal(a.source, 'replay'); assert.match(a.banner, /REPLAY/); assert.equal(a.date, '2026-11-18');
  assert.equal(a.topSurges[0].symbol, 'RELIANCE'); assert.ok(a.topSurges[0].peakRt > 3);
  assert.equal(a.topObi[0].symbol, 'INFY');
  assert.deepEqual(a.circuitTouches.map((c) => [c.symbol, c.direction]), [['INFY', 'UPPER']]);
  assert.ok(a.suppression.confirmed > 0 && a.suppression.baselineOnly > 0 && a.suppression.suppressedPct! > 0 && a.suppression.suppressedPct! < 100);
  const r = new ReplayRunner(); r.runAll(); assert.equal(a.suppression.total, r.flags.length);
  assert.equal(JSON.stringify(digestInputFromRunner(r)).includes('Infinity'), false);
});
test('chooseDigest: live data wins; closed + empty → replay; open + empty → N/A; explicit replay', () => {
  assert.equal(chooseDigest(base(), true).source, 'live'); assert.equal(chooseDigest(base(), false).source, 'live');
  assert.equal(chooseDigest(null, false).source, 'replay');
  const open = chooseDigest(null, true); assert.equal(open.status, 'na'); assert.equal(open.source, 'live');
  assert.equal(chooseDigest(base(), true, true).source, 'replay');
});
test('R(t) from persisted ticks: a burst reads high, the quiet day reads below 1; session-average pace is declared', () => {
  const open = Date.UTC(2026, 10, 18, 3, 45); let cum = 0; const ticks: TickRow[] = [];
  for (let m = 0; m <= 375; m++) { cum += m >= 200 && m < 215 ? 5000 : 1000; ticks.push({ symbol: 'ZZZ', ts: open + m * 60_000, ltp: 100, volume: cum }); }
  const { surges, basis } = surgesFromTicks(ticks);
  assert.equal(basis.ZZZ, 'session-average-pace'); assert.ok(surges[0].rt > 3.5 && surges[0].rt < 4.5, String(surges[0].rt));
  assert.ok(Math.abs(((surges[0].at - open) / 60_000) - 214) <= 2);
  const quiet = surgesFromTicks(ticks.map((t, i) => ({ ...t, volume: (i + 1) * 1000 })));
  assert.ok(quiet.surges[0].rt < 1.1);
  assert.equal(uniformProfile(2500).cum[24], 2500);
  assert.equal(surgesFromTicks([{ symbol: 'Q', ts: open, ltp: 1, volume: 0 }]).surges.length, 0);
});
test('EOD script: live load from Supabase REST (mock), replay fallback on no data / no key / --offline; the key is never echoed', async () => {
  const KEY = 'test-' + 'k'.repeat(24);
  const calls: string[] = [];
  const mock = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u); calls.push(url);
    assert.equal((init?.headers as Record<string, string>).apikey, KEY);
    const body = url.includes('market_ticks') ? [{ symbol: 'ZZZ', ltp: 100, volume: 1000, ts: '2026-11-18T05:00:00Z' }, { symbol: 'ZZZ', ltp: 101, volume: 90000, ts: '2026-11-18T05:20:00Z' }]
      : url.includes('circuit_events') ? [{ symbol: 'ZZZ', direction: 'UPPER', price: 110, detected_at: '2026-11-18T09:00:00Z', source: 'smartapi' }]
      : url.includes('depth_flags') ? [{ symbol: 'ZZZ', kind: 'wall', side: 'bid', flagged_at: '2026-11-18T06:00:00Z', confirmed_by: ['obi', 'volume'] }, { symbol: 'ZZZ', kind: 'wall', side: 'ask', flagged_at: '2026-11-18T06:05:00Z', confirmed_by: null }] : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const live = await loadLiveInput('2026-11-18', { url: 'https://x.supabase.test', key: KEY }, mock);
  assert.ok(live); assert.equal(live!.source, 'live'); assert.equal(live!.flags.length, 2); assert.equal(live!.flags.filter((f) => f.confirmed).length, 1); assert.equal(live!.circuit.length, 1);
  assert.ok(calls.every((c) => !c.includes(KEY)), 'key only in headers');
  const d = await digestFor('2026-11-18', { env: { url: 'https://x.supabase.test', key: KEY }, fetch: mock });
  assert.equal(d.source, 'live'); assert.ok(!JSON.stringify(d).includes(KEY));
  const none = (async () => new Response('[]', { status: 200 })) as typeof fetch, down = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.equal((await digestFor('2026-11-18', { env: { url: 'https://x', key: KEY }, fetch: none })).source, 'replay');
  assert.equal((await digestFor('2026-11-18', { env: { url: 'https://x', key: KEY }, fetch: down })).source, 'replay');
  assert.equal((await digestFor('2026-11-18', { env: {} })).source, 'replay');
  assert.equal((await digestFor('2026-11-18', { offline: true, env: { url: 'https://x', key: KEY }, fetch: mock })).source, 'replay');
});
test('audit pack carries the digest (JSON + printable report)', () => {
  const d = replayDigest();
  const input = { now: Date.UTC(2026, 10, 19, 20, 0), session: null, disclosureAcknowledged: false, feed: { mode: 'sim', connection: 'idle', lastTickAgeMs: null }, daemon: null, rules: [], quietHours: null, deliveries: [], symbol: 'TCS', ltp: null, depth: { bids: [], asks: [], live: false }, volume: { cumulative: null, expectedByNow: null, multiple: null, surge15: null, profileSessions: null }, exitRisk: null, flags: [], backtest: null, digest: d };
  const j = buildDossier(input);
  assert.equal(j.dailyDigest?.source, 'replay'); assert.equal(j.dailyDigest?.topSurges[0].symbol, 'RELIANCE');
  const html = dossierToHtml(j); assert.match(html, /Daily market surveillance digest/); assert.match(html, /REPLAY/);
  assert.equal(buildDossier({ ...input, digest: null }).dailyDigest, null);
});

/* ───────── portfolio surveillance overlay ───────── */
const NOW = Date.UTC(2026, 10, 18, 6, 0);
const q = (ltp: number, up = 110, lo = 90) => ({ ltp, upperCircuit: up, lowerCircuit: lo });
const book = (qty: number) => ({ bids: [{ price: 99, qty, orders: 1 }, { price: 98, qty, orders: 1 }], asks: [{ price: 100, qty, orders: 1 }] });
function run(over: Partial<SurvInput> & { qty?: number } = {}) {
  return holdingsSurveillance({ holdings: [{ symbol: 'AAA', qty: over.qty ?? 100 }], quotes: () => q(100), flags: [], now: NOW, ...over });
}
test('overlay: Multi-Signal Confirmed flag in the last 30 min → high; baseline-only → watch; stale flag ignored; clear otherwise', () => {
  assert.equal(run({ flags: [{ symbol: 'AAA', ts: NOW - 5 * 60_000, confirmed: true }] }).level, 'high');
  const w = run({ flags: [{ symbol: 'AAA', ts: NOW - 60_000, confirmed: false }] }); assert.equal(w.level, 'watch'); assert.deepEqual(w.rows[0].reasons, ['baseline_flag']);
  assert.equal(run({ flags: [{ symbol: 'AAA', ts: NOW - 31 * 60_000, confirmed: true }] }).level, 'clear');
  assert.equal(run({ flags: [{ symbol: 'BBB', ts: NOW, confirmed: true }] }).level, 'clear');
  assert.equal(run({ flags: [{ symbol: 'AAA', ts: NOW + 60_000, confirmed: true }] }).level, 'clear', 'future-dated flags are ignored');
  assert.equal(run().level, 'clear'); assert.match(run().label, /No surveillance/);
});
test('overlay: circuit proximity uses ≤ 2 %; thin exit depth near a circuit is high, thin alone is watch, N/A without a book', () => {
  assert.equal(PORTFOLIO_NEAR_PCT, 2);
  assert.deepEqual(run({ quotes: () => q(100, 101.9) }).rows[0].reasons, ['near_upper_circuit']);            // 1.86 % below
  assert.equal(run({ quotes: () => q(100, 102.1) }).level, 'clear');                                          // 2.1 % below
  assert.deepEqual(run({ quotes: () => q(100, 120, 98.5) }).rows[0].reasons, ['near_lower_circuit']);
  const thinNear = run({ quotes: () => q(100, 101), depth: () => book(300), qty: 1000 });                     // visible bids 600 < 1000 shares held
  assert.equal(thinNear.level, 'high'); assert.ok(thinNear.rows[0].reasons.includes('thin_exit_depth_near_circuit')); assert.equal(thinNear.rows[0].exitCoverage, 0.6);
  const thinFar = run({ depth: () => book(300), qty: 1000 }); assert.equal(thinFar.level, 'watch'); assert.deepEqual(thinFar.rows[0].reasons, ['thin_exit_depth']);
  const deep = run({ quotes: () => q(100, 101), depth: () => book(5000), qty: 1000 }); assert.equal(deep.rows[0].exitCoverage, 10); assert.equal(deep.level, 'watch');   // near circuit but depth OK
  const noBook = run({ quotes: () => q(100, 101) }); assert.equal(noBook.rows[0].depthAvailable, false); assert.equal(noBook.rows[0].exitCoverage, null); assert.equal(noBook.depthChecked, 0);
});
test('overlay: focus names without quantity, unknown quotes → N/A, ordering and counts', () => {
  const s = holdingsSurveillance({
    holdings: [{ symbol: 'OK', qty: 10 }, { symbol: 'NOQ', qty: 10 }, { symbol: 'HOT', qty: 10 }, { symbol: 'FOC', qty: 0, focus: true }],
    quotes: (x) => (x === 'NOQ' ? undefined : q(100, x === 'HOT' ? 101 : 130)), flags: [{ symbol: 'HOT', ts: NOW, confirmed: true }], now: NOW,
  });
  assert.deepEqual(s.rows.map((r) => [r.symbol, r.level]), [['HOT', 'high'], ['OK', 'clear'], ['FOC', 'clear'], ['NOQ', 'na']]);
  assert.deepEqual([s.high, s.watch, s.clear, s.na], [1, 0, 2, 1]); assert.equal(s.level, 'high'); assert.match(s.label, /1 holding at elevated/);
  assert.equal(holdingsSurveillance({ holdings: [], quotes: () => undefined, flags: [], now: NOW }).level, 'na');
  assert.equal(s.rows.find((r) => r.symbol === 'FOC')!.focus, true);
});

/* ───────── wiring, docs and hygiene ───────── */
test('wiring: cards in the Surveillance Desk, badge in Retail + Executive/Institutional lenses, tests in npm test, README guide', () => {
  const ws = readFileSync('components/dashboards/SurveillanceWorkspace.tsx', 'utf8');
  assert.match(ws, /<EodDigestCard/); assert.match(ws, /<RuleSandbox/); assert.match(ws, /digest=\{digestShown\}/);
  assert.match(readFileSync('components/dashboards/Retail.tsx', 'utf8'), /<HoldingsSurveillanceBadge/);
  assert.match(readFileSync('components/PortfolioRiskEngine.tsx', 'utf8'), /Holdings Surveillance &amp; Liquidity Risk/);
  assert.match(readFileSync('components/dashboards/Executive.tsx', 'utf8'), /<PortfolioRiskEngine[^>]*selected=/);
  assert.match(readFileSync('lib/sandboxState.ts', 'utf8'), /Simulate Live Market Burst/);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')); assert.match(pkg.scripts.test, /tests\/week11-final\.test\.ts/); assert.match(pkg.scripts.test, /tests\/week11-capstone\.test\.ts/);
  const rd = readFileSync('README.md', 'utf8'); assert.match(rd, /Final Defense Demo Guide/); assert.match(rd, /After-Hours Replay/);
  assert.ok(existsSync('scripts/eod-digest.ts'));
  // the sandbox owns its state: no engine, no cloud, no storage
  const sb = readFileSync('components/dashboards/RuleSandbox.tsx', 'utf8'); assert.doesNotMatch(sb, /useCloud|cloud\.|localStorage|fetch\(|engine\./);
});
test('zero secrets in the new files', () => {
  const bad = [/sb_secret_[A-Za-z0-9_-]{8,}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /\bre_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S+/];
  for (const f of ['lib/surveillanceReplay.ts', 'lib/eodDigest.ts', 'lib/analytics/portfolioSurveillance.ts', 'scripts/eod-digest.ts', 'components/dashboards/EodDigestCard.tsx', 'components/dashboards/RuleSandbox.tsx', 'components/PortfolioRiskEngine.tsx', 'README.md']) {
    const t = readFileSync(f, 'utf8'); for (const re of bad) assert.ok(!re.test(t), `${f} matches ${re}`);
  }
});
