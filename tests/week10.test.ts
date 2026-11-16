// Week 10 unit tests: time-of-day volume profile, weighted order-book imbalance, daemon lease election, heuristic backtest.
//   npm run test:week10        (node:test via tsx)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKETS, SESSION_OPEN_MIN, bucketIndex, bucketLabel, computeIntradayProfile, expectedVolume, istDayOf, istMinuteOf, volumeMultipleAt, MIN_BASELINE_SESSIONS, NO_PROFILE, type IntradayProfile,
} from '../lib/volumeBaseline';
import { LEVEL_WEIGHTS, MIN_DEPTH_QTY, obiValue, topFiveImbalance, weightedObi } from '../lib/depthImbalance';
import { createLease, type LeaseRow } from '../daemon/lease';
import { RuleIndex } from '../daemon/engine';
import { evaluate, synthesize } from '../scripts/backtest-heuristics';

const IST = 19800;
/** epoch ms of an IST wall-clock time on 2026-11-09 (a Monday) */
const at = (hh: number, mm = 0, ss = 0, day = 9) => Date.UTC(2026, 10, day, hh, mm, ss) - IST * 1000;

/* ───────────────────────── time-of-day volume profile ───────────────────────── */

/** 15-minute bars for one IST day: bucket k trades `vol(k)` shares. time = IST-shifted seconds (as lib/yahooData.parseBars returns). */
function dayBars(day: number, vol: (k: number) => number, skip: number[] = []) {
  const midnight = Date.UTC(2026, 10, day) / 1000;            // IST-shifted day start == UTC midnight of that date
  return Array.from({ length: BUCKETS }, (_, k) => ({ time: midnight + (SESSION_OPEN_MIN + k * 15) * 60, volume: skip.includes(k) ? 0 : vol(k) }));
}
const flatBars = (days: number[], vol: (k: number) => number) => days.flatMap((d) => dayBars(d, vol));
const NOW = at(10, 0, 0, 20);                                        // 20 Nov 2026 10:00 IST; sessions 2…19 Nov are "completed"
const DAYS = Array.from({ length: 12 }, (_, i) => 2 + i);            // 12 completed sessions

test('bucket index: 25 buckets, 09:15 inclusive → 15:30 exclusive', () => {
  assert.equal(BUCKETS, 25);
  assert.equal(bucketIndex(9 * 60 + 14.99), null);
  assert.equal(bucketIndex(9 * 60 + 15), 0);
  assert.equal(bucketIndex(9 * 60 + 29.99), 0);
  assert.equal(bucketIndex(9 * 60 + 30), 1);
  assert.equal(bucketIndex(15 * 60 + 14.99), 23); assert.equal(bucketIndex(15 * 60 + 15), 24); assert.equal(bucketIndex(15 * 60 + 29.99), 24);
  assert.equal(bucketIndex(15 * 60 + 30), null);
  assert.equal(bucketLabel(0), '09:15'); assert.equal(bucketLabel(24), '15:15');
  assert.equal(istMinuteOf(at(11, 45)), 11 * 60 + 45);
  assert.equal(istDayOf(at(9, 16)), istDayOf(at(15, 29)));
});

test('profile: median of cumulative curves, non-decreasing, needs ≥ 10 clean sessions', () => {
  // every session trades 1 000 per bucket, except one outlier day that trades 50× — the median must ignore it
  const bars = [...flatBars(DAYS.slice(0, 11), () => 1000), ...dayBars(DAYS[11], () => 50_000)];
  const p = computeIntradayProfile(bars, NOW);
  assert.equal(p.status, 'ok'); assert.equal(p.sessions, 12); assert.equal(p.cum.length, 25);
  assert.equal(p.cum[0], 1000); assert.equal(p.cum[1], 2000); assert.equal(p.cum[24], 25_000);
  for (let k = 1; k < 25; k++) assert.ok(p.cum[k] >= p.cum[k - 1]);
  // fewer than MIN_BASELINE_SESSIONS → insufficient, no curve
  const few = computeIntradayProfile(flatBars(DAYS.slice(0, MIN_BASELINE_SESSIONS - 1), () => 1000), NOW);
  assert.equal(few.status, 'insufficient'); assert.equal(few.cum.length, 0); assert.equal(few.sessions, MIN_BASELINE_SESSIONS - 1);
  assert.equal(computeIntradayProfile([], NOW).status, 'unavailable'); assert.equal(computeIntradayProfile(null, NOW), NO_PROFILE);
});

test('profile: today, holey days and out-of-session prints are excluded; only the last 20 sessions count', () => {
  const today = istDayOf(NOW);
  const todayDay = new Date((today * 86400) * 1000).getUTCDate();
  const bars = [...flatBars(DAYS, () => 1000), ...dayBars(todayDay, () => 9_999_999)];          // today's partial session must not leak in
  assert.equal(computeIntradayProfile(bars, NOW).cum[24], 25_000);
  // a day missing 3 buckets (22 of 25 < 23) is dropped, so 12 good + 1 holey = 12 sessions
  const holey = dayBars(DAYS[11] + 1, () => 1000, [3, 4, 5]);
  assert.equal(computeIntradayProfile([...flatBars(DAYS, () => 1000), ...holey], NOW).sessions, 12);
  // missing only 2 buckets (23 of 25) is kept
  assert.equal(computeIntradayProfile([...flatBars(DAYS, () => 1000), ...dayBars(DAYS[11] + 1, () => 1000, [3, 4])], NOW).sessions, 13);
  // pre-open / post-close prints are ignored
  const stray = { time: Date.UTC(2026, 10, 3) / 1000 + (9 * 60 + 5) * 60, volume: 777_777 };
  assert.equal(computeIntradayProfile([...flatBars(DAYS, () => 1000), stray], NOW).cum[0], 1000);
  // 25 completed sessions → only the latest 20 are used (the old 5 trade 100× and would move the median if they counted)
  const old = Array.from({ length: 5 }, (_, i) => 1 + i), recent = Array.from({ length: 20 }, (_, i) => 6 + i);
  const long = computeIntradayProfile([...flatBars(old, () => 100_000), ...flatBars(recent, () => 1000)], at(10, 0, 0, 29));
  assert.equal(long.sessions, 20); assert.equal(long.cum[24], 25_000);
});

/** bucket k trades 10 000 + 1 000·k shares; cum[k] = running total (cum[0] = 10 000 is above the 2 % floor) */
const ramp: IntradayProfile = { status: 'ok', sessions: 15, cum: Array.from({ length: 25 }, (_, k) => 20_000 * (k + 1) + 500 * k * (k + 1)) };
const FULL = ramp.cum[24];

test('expected volume: end of bucket, linear inside a bucket, early floor', () => {
  // 09:30:00 is the START of bucket 1 → expected = cumulative at the end of bucket 0
  assert.equal(expectedVolume(ramp, FULL, at(9, 30))!.expected, ramp.cum[0]);
  assert.equal(expectedVolume(ramp, FULL, at(9, 30))!.bucket, 1);
  // 09:37:30 is halfway through bucket 1 → halfway between cum[0] and cum[1]
  const mid = expectedVolume(ramp, FULL, at(9, 37, 30))!;
  assert.equal(mid.basis, 'time-of-day'); assert.equal(mid.bucket, 1);
  assert.ok(Math.abs(mid.expected - (ramp.cum[0] + ramp.cum[1]) / 2) < 1e-6);
  // 15:29:59 is almost the end of the last bucket → almost the full day
  assert.ok(expectedVolume(ramp, FULL, at(15, 29, 59))!.expected > ramp.cum[23] && expectedVolume(ramp, FULL, at(15, 29, 59))!.expected <= ramp.cum[24]);
  // 09:15:00 sharp: nothing has traded in the profile → the 2 % floor of the full-day baseline applies (never divide by ~0)
  assert.equal(expectedVolume(ramp, FULL, at(9, 15))!.expected, 0.02 * FULL);
  // monotone across the session
  let last = 0;
  for (let m = 9 * 60 + 15; m < 15 * 60 + 30; m += 5) { const e = expectedVolume(ramp, FULL, at(Math.floor(m / 60), m % 60))!.expected; assert.ok(e >= last); last = e; }
});

test('expected volume: falls back to the flat full-day baseline', () => {
  for (const prof of [null, undefined, NO_PROFILE, { status: 'insufficient', sessions: 4, cum: [] } as IntradayProfile, { status: 'ok', sessions: 12, cum: [1, 2, 3] } as IntradayProfile]) {
    const e = expectedVolume(prof, 80_000, at(11, 0))!;
    assert.equal(e.basis, 'full-day'); assert.equal(e.expected, 80_000); assert.equal(e.bucket, null);
  }
  // outside the session (pre-open, after close, weekend hour) → flat even with a good profile
  assert.equal(expectedVolume(ramp, FULL, at(9, 0))!.basis, 'full-day');
  assert.equal(expectedVolume(ramp, FULL, at(16, 0))!.basis, 'full-day');
  // no baseline of either kind → N/A, never a made-up number
  assert.equal(expectedVolume(null, null, at(11, 0)), null);
  assert.equal(expectedVolume(null, 0, at(11, 0)), null);
  assert.equal(volumeMultipleAt(5000, null, null, at(11, 0)), null);
  assert.equal(volumeMultipleAt(-1, ramp, FULL, at(11, 0)), null);
});

test('multiple vs time-of-day curve fires on a morning that the full-day multiple would miss', () => {
  const t = at(10, 15);                                               // end of bucket 3 → expected = cum[3] = 500·4·5 = 10 000
  const e = expectedVolume(ramp, FULL, t)!;
  assert.equal(e.expected, ramp.cum[3]);
  const vol = 2 * e.expected;                                         // twice the usual volume for 10:15
  const tod = volumeMultipleAt(vol, ramp, FULL, t)!;
  assert.ok(Math.abs(tod.multiple - 2) < 1e-9); assert.equal(tod.basis, 'time-of-day');
  const flat = volumeMultipleAt(vol, null, FULL, t)!;                 // the old behaviour: vol ÷ full day
  assert.ok(flat.multiple < 0.25); assert.equal(flat.basis, 'full-day');
});

test('daemon engine: volume_surge uses the time-of-day basis when the lookup says so, the full day otherwise', () => {
  const rule = { id: 'v1', user_id: 'u', symbol: 'ABC', kind: 'volume_surge' as const, threshold: 1.5, cooldown_min: 0, channels: { push: true, email: false }, enabled: true, last_triggered_at: null };
  const run = (lookup: (s: string, n: number) => number | null | { value: number; basis: 'time-of-day' | 'full-day' }) => {
    const idx = new RuleIndex(); idx.setBaselineLookup(lookup); idx.upsert(rule);
    idx.onTick({ symbol: 'ABC', ltp: 100, prevClose: 99, ts: 1, volume: 1000 }, 1);                  // seeds state (condition false)
    return idx.onTick({ symbol: 'ABC', ltp: 100, prevClose: 99, ts: 2, volume: 20_000 }, 2);
  };
  const tod = run(() => ({ value: 10_000, basis: 'time-of-day' }));
  assert.equal(tod.length, 1); assert.match(tod[0].message, /volume typical by this time of day/); assert.match(tod[0].message, /2\.00×/);
  const flat = run(() => 10_000);                                                                    // Week 9 contract: a bare number is the full-day volume
  assert.equal(flat.length, 1); assert.match(flat[0].message, /typical daily volume/);
  assert.equal(run(() => null).length, 0);                                                           // N/A: silent
  let seen = 0; run((_s, n) => { seen = n; return 10_000; }); assert.equal(seen, 2);                 // the lookup receives the evaluation time
});

/* ───────────────────────── weighted order-book imbalance ───────────────────────── */

test('level weights are exp(−0.5·(i−1)) for i = 1…5', () => {
  assert.deepEqual(LEVEL_WEIGHTS.length, 5);
  [1, Math.exp(-0.5), Math.exp(-1), Math.exp(-1.5), Math.exp(-2)].forEach((w, i) => assert.ok(Math.abs(LEVEL_WEIGHTS[i] - w) < 1e-12));
  assert.ok(Math.abs(LEVEL_WEIGHTS[1] - 0.6065306597) < 1e-9); assert.ok(Math.abs(LEVEL_WEIGHTS[4] - 0.1353352832) < 1e-9);
});

test('weighted OBI: hand-computed values, symmetry, one-sided books', () => {
  // bids 100,100,100,100,100 · asks 500,0,0,0,0 → raw (500−500)/1000 = 0; weighted: bids Σw·100 = 100·Σw, asks 500·1
  const W = LEVEL_WEIGHTS.reduce((a, b) => a + b, 0);
  const expected = (100 * W - 500) / (100 * W + 500);
  const v = weightedObi([100, 100, 100, 100, 100], [500, 0, 0, 0, 0])!;
  assert.ok(Math.abs(v - expected) < 1e-12); assert.ok(v < 0);
  assert.equal(weightedObi([300, 200, 100, 50, 25], [300, 200, 100, 50, 25]), 0);
  assert.equal(weightedObi([100, 100, 100, 100, 100], []), 1); assert.equal(weightedObi([], [7, 7]), -1);
  assert.equal(weightedObi([], []), null); assert.equal(weightedObi([0, 0], [0, 0]), null);
  // antisymmetry
  const a = [500, 400, 300, 200, 100], b = [100, 150, 200, 250, 300];
  assert.ok(Math.abs(weightedObi(a, b)! + weightedObi(b, a)!) < 1e-12);
  // the weighting matters: the same total quantity on the touch vs four levels away
  const near = weightedObi([1000, 0, 0, 0, 0], [0, 0, 0, 0, 1000])!;
  assert.ok(near > 0.7);
  assert.ok(Math.abs(near - (1 - Math.exp(-2)) / (1 + Math.exp(-2))) < 1e-12);
});

test('topFiveImbalance exposes both readings; raw is unchanged, thin books stay N/A', () => {
  const lv = (qs: number[], d: number) => qs.map((q, i) => ({ price: 100 + d * 0.05 * (i + 1), qty: q, orders: 1 }));
  const bids = lv([1000, 800, 600, 400, 200], -1), asks = lv([200, 400, 600, 800, 1000], 1);
  const r = topFiveImbalance(bids, asks)!;
  assert.equal(r.value, 0);                                           // raw: 3000 vs 3000
  assert.ok(r.weightedValue > 0.2);                                   // near-touch bids dominate
  assert.equal(obiValue(r, 'raw'), r.value); assert.equal(obiValue(r, 'weighted'), r.weightedValue);
  assert.ok(Math.abs(r.weightedValue - weightedObi([1000, 800, 600, 400, 200], [200, 400, 600, 800, 1000])!) < 1e-12);
  assert.equal(topFiveImbalance(lv([100], -1), lv([100], 1)), null); assert.ok(MIN_DEPTH_QTY > 200);
  // unsorted / junk levels are cleaned the same way for both readings; only the best five count
  const junk = topFiveImbalance([...bids, { price: 90, qty: 99_999, orders: 1 }, { price: NaN, qty: 5, orders: 1 }], asks)!;
  assert.equal(junk.value, 0);
});

/* ───────────────────────── lease election ───────────────────────── */

/** in-memory stand-in for public.acquire_daemon_lease on a virtual DATABASE clock, with the same rules as the SQL */
class FakeDb {
  t = 0;
  row: { holder: string | null; expires: number; epoch: number } | null = null;
  down = new Set<string>();                                            // holders whose network to the database is cut
  calls = 0;
  acquire = (holder: string) => async (name: string, id: string, ttl: number): Promise<LeaseRow> => {
    assert.equal(name, 'alert-daemon'); assert.equal(id, holder); this.calls++;
    if (this.down.has(holder)) throw new Error('network down');
    const r = this.row;
    if (!r) { this.row = { holder: id, expires: this.t + ttl * 1000, epoch: 1 }; }
    else if (r.expires <= this.t || r.holder === id) { this.row = { holder: id, expires: this.t + ttl * 1000, epoch: r.holder === id && r.expires > this.t ? r.epoch : r.epoch + 1 }; }
    else return { acquired: false, holder_id: r.holder, expires_at: new Date(r.expires).toISOString(), epoch: r.epoch };
    return { acquired: true, holder_id: this.row!.holder, expires_at: new Date(this.row!.expires).toISOString(), epoch: this.row!.epoch };
  };
  release = async (_n: string, id: string) => { if (this.row && this.row.holder === id && this.row.expires > this.t) this.row.expires = this.t; };
}
const mkLease = (db: FakeDb, id: string, extra: Partial<Parameters<typeof createLease>[0]> = {}) =>
  createLease({ name: 'alert-daemon', holderId: id, ttlSeconds: 30, renewMs: 10_000, acquire: db.acquire(id), release: db.release, now: () => db.t, ...extra });

test('lease: first instance leads, the second stands by, renewal keeps the epoch', async () => {
  const db = new FakeDb(); const a = mkLease(db, 'A'), b = mkLease(db, 'B');
  assert.equal((await a.tick()).role, 'leader'); assert.equal(a.isLeader(), true); assert.equal(a.info().epoch, 1);
  const bi = await b.tick(); assert.equal(bi.role, 'standby'); assert.equal(b.isLeader(), false); assert.equal(bi.holder, 'A'); assert.match(bi.reason, /held by A/);
  db.t += 10_000; await a.tick(); await b.tick();
  assert.equal(a.isLeader(), true); assert.equal(a.info().epoch, 1);   // renewal is not a change of leader
  assert.equal(b.isLeader(), false);
});

test('lease: crash failover takes at most one TTL and bumps the fencing epoch', async () => {
  const db = new FakeDb(); const a = mkLease(db, 'A'), b = mkLease(db, 'B');
  await a.tick(); await b.tick();
  // A dies silently (no more calls). B polls every 10 s.
  let took = -1;
  for (let s = 10; s <= 60; s += 10) { db.t = s * 1000; if ((await b.tick()).role === 'leader') { took = s; break; } }
  assert.equal(took, 30);                                              // lease granted at t=0 with ttl 30 s → free at t=30
  assert.equal(b.info().epoch, 2);
  // A comes back: it must not steal the lease from a live holder
  db.t += 1000; assert.equal((await a.tick()).role, 'standby'); assert.equal(db.row!.holder, 'B');
});

test('lease: graceful stop releases immediately; the standby takes over on its next poll', async () => {
  const db = new FakeDb(); const a = mkLease(db, 'A'), b = mkLease(db, 'B');
  await a.tick(); await b.tick();
  db.t += 2000; await a.stop();
  assert.equal(a.isLeader(), false);
  assert.equal((await b.tick()).role, 'leader'); assert.equal(b.info().epoch, 2);
  // stopping a standby releases nothing
  const c = mkLease(db, 'C'); await c.tick(); await c.stop(); assert.equal(db.row!.holder, 'B');
});

test('lease: a partitioned leader steps down before its lease can expire — never two leaders at once', async () => {
  const db = new FakeDb(); const a = mkLease(db, 'A', { safetyMs: 3000 }), b = mkLease(db, 'B', { safetyMs: 3000 });
  await a.tick(); await b.tick();                                      // t=0: A leads (expires 30 s)
  db.down.add('A');                                                    // A can no longer reach the database
  let overlap = 0, bLeaderAt = -1, aStoppedAt = -1;
  for (let s = 1; s <= 60; s++) {
    db.t = s * 1000;
    if (s % 10 === 0) { await a.tick(); await b.tick(); }              // both poll every 10 s; A's polls throw
    if (a.isLeader() && b.isLeader()) overlap++;
    if (aStoppedAt < 0 && !a.isLeader()) aStoppedAt = s;
    if (bLeaderAt < 0 && b.isLeader()) bLeaderAt = s;
  }
  assert.equal(overlap, 0);
  assert.equal(aStoppedAt, 27);                                        // 30 s lease − 3 s safety
  assert.equal(bLeaderAt, 30);                                         // first B poll after the DB lease expired
  assert.ok(aStoppedAt < bLeaderAt);
});

test('lease: a stalled event loop makes isLeader() false by itself (no round needed)', async () => {
  const db = new FakeDb(); const a = mkLease(db, 'A', { safetyMs: 3000 });
  await a.tick(); assert.equal(a.isLeader(), true);
  db.t = 26_999; assert.equal(a.isLeader(), true);
  db.t = 27_000; assert.equal(a.isLeader(), false); assert.equal(a.info().role, 'standby');
});

test('lease: rounds never overlap; configuration is validated; a database error as standby stays standby', async () => {
  const db = new FakeDb(); const a = mkLease(db, 'A');
  await Promise.all([a.tick(), a.tick(), a.tick()]); assert.equal(db.calls, 1);
  assert.throws(() => mkLease(db, 'X', { ttlSeconds: 15, renewMs: 10_000 }), /twice the renewal/);
  const db2 = new FakeDb(); const s = mkLease(db2, 'S'); db2.down.add('S'); assert.equal((await s.tick()).role, 'standby');
});

test('lease: the SQL contract — leaders alternate only through expiry or release, epoch is a strictly increasing fence', async () => {
  const db = new FakeDb(); const ids = ['A', 'B', 'C']; const leases = ids.map((i) => mkLease(db, i));
  const epochs: number[] = []; let prevHolder: string | null = null;
  for (let step = 0; step < 200; step++) {
    db.t = step * 5000;
    for (let k = 0; k < 3; k++) if ((step + k) % 2 === 0 && !(k === 0 && step > 20 && step < 80)) await leases[k].tick();   // A is silent for a long stretch
    const leaders = leases.filter((l) => l.isLeader()).length;
    assert.ok(leaders <= 1, `two leaders at step ${step}`);
    if (db.row && db.row.holder !== prevHolder) { epochs.push(db.row.epoch); prevHolder = db.row.holder; }
  }
  assert.ok(epochs.length >= 2);
  for (let i = 1; i < epochs.length; i++) assert.ok(epochs[i] > epochs[i - 1]);
});

/* ───────────────────────── heuristic backtest ───────────────────────── */

test('backtest: unlabelled data reports counts and N/A precision, never an invented number', () => {
  const { snaps } = synthesize({ symbols: 1, days: 1, stepMs: 1000, seed: 5, noise: 0.3 });
  const r = evaluate(snaps, null, { source: 'unit' });
  assert.equal(r.precision, null); assert.equal(r.recall, null); assert.equal(r.truePositives, null);
  assert.equal(r.data.labelled, false); assert.equal(r.data.snapshots, snaps.length);
  assert.ok(r.notes.some((n) => /N\/A/.test(n)));
});

test('backtest: synthetic labelled run is deterministic, finds injected walls and add/cancel patterns, and flags are labelled heuristic', () => {
  const cfg = { symbols: 2, days: 1, stepMs: 500, seed: 3, noise: 0.25 };
  const a = synthesize(cfg), b = synthesize(cfg);
  assert.deepEqual(a.episodes, b.episodes);                           // seeded → identical
  assert.equal(a.snaps.length, b.snaps.length); assert.deepEqual(a.snaps[1000], b.snaps[1000]);
  const r = evaluate(a.snaps, a.episodes, cfg);
  assert.equal(r.data.labelled, true);
  assert.ok(r.precision !== null && r.precision >= 0 && r.precision <= 1);
  assert.equal(r.truePositives! + r.falsePositives!, r.flags.total);
  const wall = r.recall!.spoof_wall;
  if (wall.episodes > 0) assert.ok((wall.rate as number) >= 0.9, `spoof-wall recall ${wall.rate}`);
  const flick = r.recall!.flicker;
  if (flick.episodes > 0) assert.ok((flick.rate as number) >= 0.5, `flicker recall ${flick.rate}`);
  assert.ok(r.notes.some((n) => /not how often real markets/.test(n)));
  assert.equal(r.params.CYCLES_WATCH, 3);
});

test('backtest: more book noise → more background false positives (the result is assumption-dependent, and says so)', () => {
  const base = { symbols: 2, days: 1, stepMs: 500, seed: 4 };
  const quiet = synthesize({ ...base, noise: 0.2 }), loud = synthesize({ ...base, noise: 0.6 });
  const fq = evaluate(quiet.snaps, quiet.episodes).falsePositiveCauses!, fl = evaluate(loud.snaps, loud.episodes).falsePositiveCauses!;
  const bg = (c: Record<string, number>) => Object.entries(c).filter(([k]) => k.startsWith('background_noise')).reduce((s, [, v]) => s + v, 0);
  assert.ok(bg(fl) > bg(fq), `background FPs: loud ${bg(fl)} vs quiet ${bg(fq)}`);
});
