// Week 11 capstone: multi-signal confirmation, backtest JSON, 5-level slippage + circuit-lock exit risk, audit dossier + redaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { confirmFlag, DepthFlagTracker, flagTag, CONFIRM_PARAMS, obiOfBook, levelWeights } from '../lib/heuristicFlags';
import { windowSurge, VolumeWindow, type IntradayProfile } from '../lib/volumeBaseline';
import { estimateSlippage, slippageReport, circuitLockExitRisk, defaultQty, SessionDepthMedian, NEAR_CIRCUIT_PCT, THIN_DEPTH_RATIO } from '../lib/analytics/slippage';
import { buildDossier, dossierFileName, dossierToHtml, redactSecrets, sealDossier, DOSSIER_SCHEMA, type DossierInput } from '../lib/auditDossier';
import { synthesize, synthesizeVolume, DEFAULT_COUPLING, NO_COUPLING, runSweep, LAMBDAS, WALL_MULTS, SURGES } from '../scripts/backtest-heuristics';

const book = (px: number, qtys: number[], dir: 1 | -1) => qtys.map((q, i) => ({ price: +(px + dir * 0.05 * i).toFixed(2), qty: q, orders: 1 }));

/* ───────── composite vs baseline ───────── */
test('confirmFlag: needs ≥ 2 of OBI / volume surge / spread; N/A cannot confirm', () => {
  assert.equal(CONFIRM_PARAMS.OBI_MIN, 0.35); assert.equal(CONFIRM_PARAMS.SURGE_MIN, 1.8); assert.equal(CONFIRM_PARAMS.SPREAD_MULT, 1.5); assert.equal(CONFIRM_PARAMS.MIN_SIGNALS, 2);
  assert.deepEqual(confirmFlag({ obi: 0.4, volRatio: 2, spreadRatio: 1 }).hits, ['obi', 'volume']);
  assert.equal(confirmFlag({ obi: 0.4, volRatio: 2, spreadRatio: 1 }).confirmed, true);
  assert.equal(confirmFlag({ obi: -0.36, volRatio: 1.79, spreadRatio: 1.49 }).confirmed, false);      // |OBI| counts; just-below thresholds do not
  assert.equal(confirmFlag({ obi: -0.36, volRatio: null, spreadRatio: 1.5 }).confirmed, true);
  assert.equal(confirmFlag({ obi: null, volRatio: null, spreadRatio: 9 }).confirmed, false);           // one signal is never enough
  assert.equal(flagTag({ confirmation: confirmFlag({ obi: 1, volRatio: 5, spreadRatio: null }) }), 'Multi-Signal Confirmed');
  assert.equal(flagTag({}), 'Baseline Flag');
});

test('OBI weights are exp(−λ(i−1)) and the imbalance is signed', () => {
  assert.deepEqual(levelWeights(0.5).map((x) => +x.toFixed(4)), [1, 0.6065, 0.3679, 0.2231, 0.1353]);
  const b = book(100, [1000, 1000, 1000, 1000, 1000], -1), a = book(100.05, [100, 100, 100, 100, 100], 1);
  assert.ok(obiOfBook(b, a, 0.5)! > 0.8); assert.ok(obiOfBook(a, b, 0.5)! < -0.8);
});

test('rolling 15-min surge R(t): N/A outside the session, ratio of window volume to expected', () => {
  const profile: IntradayProfile = { status: 'ok', sessions: 20, cum: Array.from({ length: 25 }, (_, i) => i * 1000) };
  const at = (h: number, m: number) => Date.UTC(2026, 10, 18, h, m) - 330 * 60_000;        // IST wall clock → UTC ms
  assert.equal(windowSurge(profile, 5000, 0, at(2, 0)), null);                              // before the open
  const r = windowSurge(profile, 20_000, 5_000, at(11, 0));                                 // 15 000 traded vs ~1 000 expected per 15 min → large
  assert.ok(r !== null && r > 5, String(r));
  const w = new VolumeWindow();
  assert.equal(w.ratio('X', profile, at(11, 0), 1000), null);                               // no history yet = N/A
});

test('composite beats baseline precision and cuts false positives, with a recall trade-off (deterministic synthetic day)', () => {
  const { snaps, episodes } = synthesize({ symbols: 2, days: 1, stepMs: 1000, seed: 7, noise: 0.45 });
  const vol = synthesizeVolume(snaps, episodes, 7, DEFAULT_COUPLING), off = synthesizeVolume(snaps, episodes, 7, NO_COUPLING);
  const sw = runSweep(snaps, episodes, vol, off);
  const { baseline: b, confirmed_composite: c, comparison: k } = sw.modes;
  // baseline in the sweep is exactly what DepthFlagTracker.observe emits
  const tr = new DepthFlagTracker(); let n = 0;
  for (const s of snaps) n += tr.observe(s.symbol, { bids: s.bids, asks: s.asks }, s.ltp, s.t).length;
  assert.equal(b.flags, n);
  assert.ok(c.flags < b.flags && c.fp < b.fp, 'confirmation removes false positives');
  assert.ok((c.precision ?? 0) > (b.precision ?? 1), `precision ${b.precision} → ${c.precision}`);
  assert.ok((c.recall ?? 1) <= (b.recall ?? 0), 'requiring corroboration can only lose recall');
  assert.equal(k.fpBefore, b.fp); assert.equal(k.fpAfter, c.fp);
  assert.ok(k.fpReductionPct! > 0 && k.recallDelta! <= 0);
  assert.ok(sw.assumptions.note.length > 0 && sw.sensitivity.volumeCouplingOff && sw.sensitivity.volumeSignalDisabled);
  assert.equal(sw.cells.length, LAMBDAS.length * WALL_MULTS.length * SURGES.length);
});

/* ───────── backtest JSON integrity ───────── */
test('public/backtest-heuristics.json: schema v2, baseline preserved, full sweep grid, disclosure present', () => {
  const j = JSON.parse(readFileSync('public/backtest-heuristics.json', 'utf8'));
  assert.equal(j.schemaVersion, 2);
  assert.equal(j.data.snapshots, 539_972);
  assert.equal(Math.round(j.precision * 1000) / 10, 13.3);
  assert.equal(j.recall.spoof_wall.rate, 1); assert.equal(Math.round(j.recall.flicker.rate * 1000) / 10, 95.2);
  assert.deepEqual(j.modes.baseline.precision, j.precision);
  for (const l of [0.2, 0.4, 0.6, 0.8]) assert.ok(j.sweep.axes.lambda.includes(l));
  for (const w of [2.5, 3, 4, 5]) assert.ok(j.sweep.axes.wallMultiple.includes(w));
  for (const s of [1, 1.5, 1.8, 2.2]) assert.ok(j.sweep.axes.surge.includes(s));
  assert.equal(j.sweep.cells.length, j.sweep.axes.lambda.length * j.sweep.axes.wallMultiple.length * j.sweep.axes.surge.length);
  for (const c of j.sweep.cells) {
    assert.ok(c.baseline.flags >= c.composite.flags, 'composite is a subset of baseline');
    assert.ok(c.composite.fp <= c.baseline.fp);
    for (const m of [c.baseline, c.composite]) assert.equal(m.tp + m.fp, m.flags);
    if (c.baseline.fp) assert.ok(Math.abs(c.fpReductionPct - ((c.baseline.fp - c.composite.fp) / c.baseline.fp) * 100) < 0.11);
  }
  const cmpr = j.modes.comparison;
  assert.equal(cmpr.precisionBefore, j.modes.baseline.precision); assert.equal(cmpr.precisionAfter, j.modes.confirmed_composite.precision);
  assert.ok(cmpr.precisionAfter > cmpr.precisionBefore && cmpr.fpAfter < cmpr.fpBefore && cmpr.recallAfter < cmpr.recallBefore);
  assert.match(JSON.stringify(j.assumptions) + j.notes.join(' '), /synthetic|assum/i);
  assert.match(j.notes.join(' '), /not how often real markets/i);
});

/* ───────── slippage + circuit-lock exit risk ───────── */
test('5-level VWAP fill: slippage in ₹ and bps, % of visible depth consumed', () => {
  const asks = [{ price: 100.1, qty: 100 }, { price: 100.2, qty: 200 }, { price: 100.4, qty: 300 }], bids = [{ price: 100.0, qty: 500 }];
  const r = estimateSlippage(bids, asks, 'buy', 250)!;                                        // 100@100.1 + 150@100.2
  assert.equal(r.filled, 250); assert.ok(Math.abs(r.avgPrice - (100 * 100.1 + 150 * 100.2) / 250) < 1e-9);
  assert.ok(Math.abs(r.slipPerShare - (r.avgPrice - 100.1)) < 1e-9); assert.ok(Math.abs(r.slipTotal - r.slipPerShare * 250) < 1e-9);
  assert.ok(Math.abs(r.slipBps - (r.slipPerShare / 100.1) * 1e4) < 1e-9); assert.equal(r.levelsUsed, 2);
  assert.ok(Math.abs(r.depthConsumedPct - (250 / 600) * 100) < 1e-9);
  assert.equal(defaultQty(null), 100); assert.equal(defaultQty(250), 400);
});

const live = { bids: book(100, [1000, 900, 800, 700, 600], -1), asks: book(100.05, [1000, 900, 800, 700, 600], 1), ltp: 100.02, marketOpen: true };
test('slippageReport is N/A when the market is closed or there is no depth; never a number', () => {
  const closed = slippageReport({ ...live, side: 'buy', qty: 100, marketOpen: false });
  assert.equal(closed.status, 'na'); assert.equal(closed.status === 'na' && closed.reason, 'market_closed');
  const none = slippageReport({ ...live, bids: [], asks: [], side: 'sell', qty: 100 });
  assert.equal(none.status === 'na' && none.reason, 'no_depth');
  assert.equal(slippageReport({ ...live, bids: null, asks: undefined, side: 'sell', qty: 100 }).status, 'na');
  const ok = slippageReport({ ...live, side: 'sell', qty: 1500 });
  assert.equal(ok.status, 'ok'); if (ok.status === 'ok') { assert.equal(ok.fill.levelsUsed, 2); assert.ok(ok.fill.slipBps > 0); }
});

test('circuit-lock exit risk: within 1.5 % of either circuit, or opposing depth < 25 % of the session median', () => {
  assert.equal(NEAR_CIRCUIT_PCT, 1.5); assert.equal(THIN_DEPTH_RATIO, 0.25);
  const base = { side: 'sell' as const, ltp: 100, consumedSideQty: 4000, sessionMedianQty: 4000 };
  assert.equal(circuitLockExitRisk({ ...base, upperCircuit: 110, lowerCircuit: 90, bandKnown: true }).warn, false);
  const lo = circuitLockExitRisk({ ...base, upperCircuit: 110, lowerCircuit: 98.6, bandKnown: true });
  assert.ok(lo.warn && lo.reasons.includes('near_lower_circuit') && /lower circuit/.test(lo.message!));
  assert.ok(circuitLockExitRisk({ ...base, upperCircuit: 101.4, lowerCircuit: 90, bandKnown: true }).reasons.includes('near_upper_circuit'));
  assert.equal(circuitLockExitRisk({ ...base, upperCircuit: 101.6, lowerCircuit: 98.4, bandKnown: true }).warn, false);                // just outside 1.5 %
  const thin = circuitLockExitRisk({ ...base, consumedSideQty: 900, upperCircuit: 110, lowerCircuit: 90 });                             // 22.5 %
  assert.ok(thin.warn && thin.reasons.includes('thin_depth') && thin.depthRatio === 0.225);
  assert.equal(circuitLockExitRisk({ ...base, consumedSideQty: 1000 }).reasons.includes('thin_depth'), false);                          // exactly 25 % is not thin
  assert.equal(circuitLockExitRisk({ ...base, sessionMedianQty: null, consumedSideQty: 1 }).warn, false);                               // no median yet → N/A, no warning
});

test('SessionDepthMedian needs enough samples before it reports', () => {
  const m = new SessionDepthMedian();
  for (let i = 0; i < 5; i++) m.push('X', 'bid', 1000, i * 6000);
  assert.equal(m.median('X', 'bid'), null);
});

/* ───────── audit dossier ───────── */
const FAKE_SECRETS = ['sb_secret_' + 'a'.repeat(24), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 're_' + 'Z'.repeat(20)];
function sample(): DossierInput {
  return {
    now: Date.UTC(2026, 10, 19, 20, 0), session: { userId: 'u-1', sessionId: 's-1' }, disclosureAcknowledged: true,
    feed: { mode: 'live', connection: 'open', lastTickAgeMs: 400 },
    daemon: [{ id: 'alert-daemon', age_ms: 3000, last_tick_age_ms: 500, feed_status: 'open', reconnects: 0, started_at: '2026-11-19T03:00:00Z', version: 'x', lease_epoch: 4, lease_ttl_ms: 25_000 }, { id: 'alert-daemon-standby', age_ms: 4000, last_tick_age_ms: null, feed_status: 'idle', reconnects: 0, started_at: '2026-11-19T03:00:00Z', version: 'x' }],
    rules: [{ id: 'r1', symbol: 'TCS', kind: 'price_above', threshold: 4000, cooldown_min: 15, channels: { push: true }, enabled: true, last_triggered_at: null, created_at: '2026-11-01T00:00:00Z' } as DossierInput['rules'][number]],
    quietHours: { enabled: true, start: 1320, end: 420, tz: 'Asia/Kolkata' },
    deliveries: [{ id: 'd1', fired_at: '2026-11-19T04:00:00Z', symbol: 'TCS', kind: 'price_above', price: 4001, channel: 'push', status: 'sent', detail: `ref ${FAKE_SECRETS[0]}`, tick_time: '2026-11-19T04:00:00.000Z', daemon_matched_at: '2026-11-19T04:00:00.100Z', push_sent_at: '2026-11-19T04:00:00.300Z', sw_ack_at: '2026-11-19T04:00:00.500Z', displayed_at: '2026-11-19T04:00:00.600Z' }],
    symbol: 'TCS', ltp: 100.02, depth: { bids: live.bids, asks: live.asks, live: true },
    volume: { cumulative: 5000, expectedByNow: 2000, multiple: 2.5, surge15: 2.1, profileSessions: 20 },
    exitRisk: circuitLockExitRisk({ side: 'sell', ltp: 100, lowerCircuit: 98.9, consumedSideQty: 4000, sessionMedianQty: 4000, bandKnown: true }),
    flags: [{ symbol: 'TCS', kind: 'wall', side: 'bid', severity: 'elevated', ts: Date.UTC(2026, 10, 19, 5, 0), detail: `wall; token ${FAKE_SECRETS[1]}`, label: 'Heuristic Flag / Possible Manipulation Pattern', confirmation: confirmFlag({ obi: 0.5, volRatio: 2, spreadRatio: null }), source: 'daemon' },
      { symbol: 'TCS', kind: 'add_cancel', side: 'ask', severity: 'watch', ts: Date.UTC(2026, 10, 19, 5, 1), detail: 'cycles', label: 'Heuristic Flag / Possible Manipulation Pattern' }],
    backtest: JSON.parse(readFileSync('public/backtest-heuristics.json', 'utf8')),
  };
}

test('dossier: schema, sections, IST file name, white-box formulas, non-advisory framing', () => {
  const d = buildDossier(sample());
  assert.equal(d.schema, DOSSIER_SCHEMA);
  assert.equal(dossierFileName(Date.UTC(2026, 10, 19, 20, 0)), 'upcircuit-surveillance-audit-2026-11-20.json');      // 01:30 IST next day
  assert.match(d.meta.generatedAtIST, /^20\/11\/2026 01:30:00 IST$/);
  assert.equal(d.meta.session.userId, 'u-1'); assert.equal(d.meta.disclosure.acknowledgedThisSession, true); assert.ok(d.meta.disclosure.statements.length > 0);
  assert.equal(d.ha.state, 'leader_active'); assert.equal(d.ha.leaderEpoch, 4); assert.deepEqual(d.ha.heartbeats.map((h) => h.role), ['leader', 'standby']);
  assert.equal(d.alerting.quietHours?.window, '22:00–07:00'); assert.equal(d.alerting.rules.length, 1);
  assert.equal(d.deliveries.count, 1); assert.equal(d.deliveries.rows[0].serviceWorkerAckAt, '2026-11-19T04:00:00.500Z');
  assert.equal(d.surveillance.orderBookImbalance.levels.length, 5); assert.ok(Math.abs(d.surveillance.orderBookImbalance.value!) < 0.05);
  assert.match(d.surveillance.orderBookImbalance.formula, /e\^\(−λ\(i−1\)\)/);
  assert.equal(d.surveillance.circuitLock.risk?.warn, true);
  assert.deepEqual(d.surveillance.heuristicSummary, { total: 2, confirmed: 1, baseline: 1 });
  assert.equal(d.surveillance.flags[0].tag, 'Multi-Signal Confirmed'); assert.deepEqual(d.surveillance.flags[0].corroboratedBy, ['obi', 'volume']);
  assert.equal(d.methodology.backtest.precision, 0.133); assert.equal(d.methodology.backtest.snapshots, 539_972);
  assert.match(d.framing, /not a SEBI-registered/i); assert.doesNotMatch(JSON.stringify(d), /sebi[- ]compliant/i);
  for (const k of ['obi', 'volumeSurge', 'spreadWidening', 'slippage']) assert.ok(d.methodology.formulas[k]);
  assert.ok(d.methodology.limitations.length >= 3);
});

test('dossier: N/A everywhere when the daemon, depth and volume are unavailable', () => {
  const i = sample(); i.daemon = null; i.depth = { bids: [], asks: [], live: false }; i.exitRisk = null; i.ltp = null; i.volume = { cumulative: null, expectedByNow: null, multiple: null, surge15: null, profileSessions: null }; i.session = null; i.disclosureAcknowledged = false;
  const d = buildDossier(i);
  assert.equal(d.ha.state, 'unavailable'); assert.equal(d.surveillance.orderBookImbalance.value, null); assert.equal(d.surveillance.circuitLock.risk, null); assert.equal(d.meta.session.userId, null);
  assert.match(dossierToHtml(d), /N\/A/);
});

test('dossier: secrets are redacted in values and keys, count reported, seal verifies, HTML is escaped with no inline script', async () => {
  const d = buildDossier(sample());
  const text = JSON.stringify(d);
  for (const s of FAKE_SECRETS) assert.ok(!text.includes(s), `leaked ${s.slice(0, 8)}…`);
  assert.ok(d.meta.redactions >= 1);
  const r = redactSecrets({ ok: 1, apiKey: 'x', nested: { password: 'p', note: `a ${FAKE_SECRETS[2]} b`, push_token: 't' }, list: [{ authorization: 'Bearer abcdefghijklmnop' }, 'https://fcm.googleapis.com/fcm/send/abc123'] });
  assert.deepEqual(r.value, { ok: 1, nested: { note: 'a [redacted] b' }, list: [{}, '[redacted]'] }); assert.equal(r.count, 6);
  const sealed = await sealDossier(d);
  assert.match(sealed.integrity!.digest, /^[0-9a-f]{64}$/);
  const { integrity, ...rest } = sealed; void integrity;
  assert.equal((await sealDossier(rest as typeof d)).integrity!.digest, sealed.integrity!.digest);                                        // deterministic
  const x = sample(); x.symbol = '<img src=x onerror=alert(1)>'; const html = dossierToHtml(await sealDossier(buildDossier(x)));
  assert.ok(!html.includes('<img src=x')); assert.ok(!/<script/i.test(html)); assert.ok(html.includes('Print / Save as PDF'));
});

test('zero secrets in the capstone sources, docs and generated backtest file', () => {
  const files = ['lib/auditDossier.ts', 'lib/analytics/slippage.ts', 'lib/heuristicFlags.ts', 'components/dashboards/AuditExport.tsx', 'components/dashboards/ThresholdExplorer.tsx', 'components/dashboards/SlippageCard.tsx', 'public/backtest-heuristics.json', 'schema.sql', 'docs/WEEK11_CAPSTONE_SCHEMA.sql', '.env.example'];
  const bad = [/sb_secret_[A-Za-z0-9_-]{8,}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /\bre_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  for (const f of files) { const t = readFileSync(f, 'utf8'); for (const re of bad) assert.ok(!re.test(t), `${f} matches ${re}`); }
});
