// Week 11 Market DVR: IST session window, running VWAP, Opening Range, R(t) surge tagging, provenance, playback clock + scrubbing purity, wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement } from 'react';
(globalThis as unknown as { React: typeof React }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SESSION_MINUTES, SESSION_SECONDS, REPLAY_SPEEDS, advanceClock, assembleReplay, buildFrames, clockForMinute, clockLabel, filterSessionBars, frameIndexAt, fullDaySeconds,
  istEpoch, istHHMM, lastTradingDays, minuteOfClock, parseYahooSessions, speedById, syntheticBars, ticksToMinuteBars, uniformDayProfile, isReplayDate, defaultReplayDate,
} from '../lib/sessionReplay';
import type { SessionBar } from '../lib/yahoo';
import { SessionReplayPlayer } from '../components/dashboards/SessionReplayPlayer';
import { RuleSandbox } from '../components/dashboards/RuleSandbox';

const D = '2026-11-20';                                   // a Friday
const read = (p: string) => readFileSync(p, 'utf8');
const bar = (date: string, minute: number, o: number, h: number, l: number, c: number, v = 1000): SessionBar => ({ t: istEpoch(date, minute), open: o, high: h, low: l, close: c, volume: v });
const flat = (date = D, price = 100, vol = 1000): SessionBar[] => Array.from({ length: SESSION_MINUTES }, (_, k) => bar(date, 555 + k, price, price, price, price, vol));
const yahooBody = (sessions: { date: string; bars: SessionBar[] }[]) => {
  const all = sessions.flatMap((s) => s.bars);
  return { chart: { result: [{ timestamp: all.map((b) => b.t), indicators: { quote: [{ open: all.map((b) => b.open), high: all.map((b) => b.high), low: all.map((b) => b.low), close: all.map((b) => b.close), volume: all.map((b) => b.volume) }] } }] } };
};

test('IST session-window filtering keeps 09:15 ≤ t < 15:30 on the date, sorted, one bar per minute', () => {
  const bars = [bar(D, 554, 1, 1, 1, 1), bar(D, 555, 2, 2, 2, 2), bar(D, 700, 3, 3, 3, 3), bar(D, 700, 4, 4, 4, 4), bar(D, 929, 5, 5, 5, 5), bar(D, 930, 6, 6, 6, 6), bar('2026-11-19', 600, 7, 7, 7, 7), bar(D, 800, NaN, 1, 1, 1)];
  const out = filterSessionBars([...bars].reverse(), D);
  assert.deepEqual(out.map((b) => istHHMM(b.t)), ['09:15', '11:40', '15:29']);
  assert.equal(out[1].close, 3, 'the later duplicate in input order wins');
  assert.equal(SESSION_MINUTES, 375);
});

test('running cumulative VWAP matches a hand computation', () => {
  const bars = [bar(D, 555, 100, 102, 98, 100, 100), bar(D, 556, 100, 106, 100, 104, 300), bar(D, 557, 104, 104, 100, 102, 0)];
  const { frames } = buildFrames(bars);
  const tp1 = (102 + 98 + 100) / 3, tp2 = (106 + 100 + 104) / 3;
  assert.ok(Math.abs(frames[0].vwap! - tp1) < 1e-9);
  assert.ok(Math.abs(frames[1].vwap! - (tp1 * 100 + tp2 * 300) / 400) < 1e-9);
  assert.equal(frames[2].vwap, frames[1].vwap, 'zero-volume minute leaves VWAP unchanged');
  assert.equal(buildFrames([bar(D, 555, 5, 5, 5, 5, 0)]).frames[0].vwap, null, 'no volume → N/A');
});

test('Opening Range (09:15–09:30) is formed, then breakout/breakdown moments carry exact IST timestamps', () => {
  const bars = flat();
  for (let k = 0; k < 15; k++) bars[k] = bar(D, 555 + k, 100, 101, 99, 100);
  bars[40] = bar(D, 595, 100, 103, 100, 102.5);          // 09:55 close above OR high 101
  bars[90] = bar(D, 645, 100, 100, 97, 98);              // 10:45 close below OR low 99
  const r = buildFrames(bars);
  assert.equal(r.orHigh, 101); assert.equal(r.orLow, 99);
  assert.equal(r.frames[5].orState, 'forming'); assert.equal(r.frames[14].orState, 'forming');
  assert.equal(r.frames[16].orState, 'inside');
  assert.equal(r.frames[40].orState, 'above'); assert.equal(r.frames[90].orState, 'below');
  const up = r.moments.find((m) => m.kind === 'orb_up')!, dn = r.moments.find((m) => m.kind === 'orb_down')!;
  assert.equal(up.time, '09:55'); assert.equal(dn.time, '10:45');
  assert.equal(r.moments.filter((m) => m.kind === 'orb_up').length, 1, 'first breakout only');
});

test('R(t) surge tagging across frames: N/A early, ≥ 1.8 inside a volume burst, one moment per excursion', () => {
  const bars = flat(D, 100, 1000).map((b, k) => (k >= 120 && k < 135 ? { ...b, volume: 5000 } : b));
  const r = buildFrames(bars);
  assert.equal(r.rBasis, 'session-average-pace');
  assert.equal(r.frames[0].r, null); assert.equal(r.frames[3].r, null, '< 5 min since the open');
  assert.ok(r.frames[60].r! > 0.8 && r.frames[60].r! < 0.95, 'quiet window below 1× (the burst lifts the day\'s average pace)');
  const surge = r.moments.filter((m) => m.kind === 'surge');
  assert.equal(surge.length, 1);
  assert.ok(surge[0].i >= 123 && surge[0].i <= 125, `fires 4–5 min into the burst, got ${surge[0].i}`);
  assert.ok(r.frames[134].r! > 4 && r.frames[134].r! < 4.6);
  assert.ok(r.frames.slice(surge[0].i, 135).every((f) => f.r! >= 1.8));
  assert.ok(r.frames[200].r! < 1.8);
  // a supplied median profile is used and labelled as such
  const m = buildFrames(bars, { profile: { status: 'ok', sessions: 20, cum: uniformDayProfile(300_000).cum } });
  assert.equal(m.rBasis, 'median-profile');
});

test('VWAP crosses and circuit-band proximity (≤ 2 %) — N/A without prevClose + band', () => {
  const bars = flat();
  bars[20] = bar(D, 575, 100, 100, 99, 99);              // below VWAP (sets the starting side)
  bars[30] = bar(D, 585, 100, 101, 100, 101);            // above VWAP
  bars[31] = bar(D, 586, 101, 101, 99, 99);              // back below
  const r = buildFrames(bars);
  assert.deepEqual(r.moments.filter((m) => m.kind.startsWith('vwap')).map((m) => [m.time, m.kind]), [['09:36', 'vwap_cross_up'], ['09:46', 'vwap_cross_down'], ['09:47', 'vwap_cross_up']]);
  assert.equal(r.frames[10].circuitGapPct, null); assert.equal(r.circuit, null); assert.equal(r.frames[10].nearCircuit, false);
  const c = flat(); c[100] = bar(D, 655, 100, 103.5, 100, 103.2); c[101] = bar(D, 656, 103.2, 105, 103, 104.9);
  const rc = buildFrames(c, { prevClose: 100, band: 5 });
  assert.equal(rc.circuit!.upper, 105); assert.equal(rc.circuit!.lower, 95);
  assert.equal(rc.frames[10].nearCircuit, false);
  assert.equal(rc.frames[100].nearCircuit, true); assert.equal(rc.frames[100].circuitSide, 'upper');
  assert.ok(Math.abs(rc.frames[100].circuitGapPct! - ((105 - 103.2) / 105) * 100) < 1e-9);
  assert.deepEqual(rc.moments.filter((m) => m.kind.startsWith('circuit')).map((m) => [m.time, m.kind]), [['10:55', 'circuit_near'], ['10:56', 'circuit_touch']]);
});

test('Yahoo parsing: all sessions, previous close from the prior session, thin days dropped', () => {
  const s = parseYahooSessions(yahooBody([{ date: '2026-11-18', bars: flat('2026-11-18', 90) }, { date: '2026-11-19', bars: flat('2026-11-19', 95) }, { date: D, bars: flat(D, 100).slice(0, 10) }]));
  assert.deepEqual(s.map((x) => x.date), ['2026-11-18', '2026-11-19']);
  assert.equal(s[0].prevClose, null); assert.equal(s[1].prevClose, 90);
  assert.deepEqual(parseYahooSessions(null), []);
});

test('provenance tagging: Supabase ticks > Yahoo bars > (opt-in) Synthetic Fallback; thin recordings fall through', () => {
  const body = yahooBody([{ date: '2026-11-19', bars: flat('2026-11-19', 95) }, { date: D, bars: flat(D, 100) }]);
  const mkTicks = (n: number) => Array.from({ length: n * 2 }, (_, k) => ({ symbol: 'X', ts: istEpoch(D, 555 + Math.floor(k / 2)) * 1000 + (k % 2) * 20_000, ltp: 100 + k / 100, high: 0, low: 0, volume: 500 * (k + 1) }));
  const rec = assembleReplay({ symbol: 'X', date: D, ticks: mkTicks(60), yahooBody: body });
  assert.ok(rec.ok && rec.session.provenance === 'Supabase Recorded Ticks' && !rec.session.synthetic);
  assert.equal(rec.ok && rec.session.frames.length, 60);
  const thin = assembleReplay({ symbol: 'X', date: D, ticks: mkTicks(10), yahooBody: body });
  assert.ok(thin.ok && thin.session.provenance === 'Yahoo 1m Intraday Bars' && thin.session.frames.length === 375);
  assert.ok(thin.ok && thin.session.notes.some((n) => /Only 10 recorded/.test(n)));
  assert.equal(thin.ok && thin.session.prevClose, 95, 'prev close from the prior Yahoo session');
  const none = assembleReplay({ symbol: 'X', date: D, ticks: [], yahooBody: body });
  assert.ok(none.ok && none.session.provenance === 'Yahoo 1m Intraday Bars');
  const off = assembleReplay({ symbol: 'X', date: D, ticks: null, yahooBody: null });
  assert.ok(!off.ok && off.reason === 'no_data', 'offline: no silent synthetic');
  const syn = assembleReplay({ symbol: 'X', date: D, ticks: null, yahooBody: null, allowSynthetic: true });
  assert.ok(syn.ok && syn.session.provenance === 'Synthetic Fallback' && syn.session.synthetic && syn.session.frames.length === 375 && syn.session.notes.some((n) => /SYNTHETIC/.test(n)));
  assert.deepEqual(syntheticBars('X', D), syntheticBars('X', D), 'deterministic');
  const missing = assembleReplay({ symbol: 'X', date: '2026-11-17', ticks: null, yahooBody: body });
  assert.ok(!missing.ok && missing.availableDates[0] === D);
  assert.equal(rec.ok && rec.session.depth, 'N/A');
});

test('recorded ticks → minute bars use per-minute volume deltas and ignore out-of-session ticks', () => {
  const t = (m: number, s: number, ltp: number, volume: number) => ({ symbol: 'X', ts: (istEpoch(D, m) + s) * 1000, ltp, high: ltp, low: ltp, volume });
  const bars = ticksToMinuteBars([t(540, 0, 9, 1), t(555, 5, 100, 1000), t(555, 40, 102, 1500), t(556, 10, 101, 2500), t(930, 0, 5, 9999)], D);
  assert.equal(bars.length, 2);
  assert.deepEqual([bars[0].open, bars[0].high, bars[0].low, bars[0].close], [100, 102, 100, 102]);
  assert.equal(bars[0].volume, 1500); assert.equal(bars[1].volume, 1000);
});

test('playback speeds: 1×,2×,4×,8×,10× are real-time multiples; Express is the full day in ~5 min', () => {
  assert.deepEqual(REPLAY_SPEEDS.map((s) => s.label), ['1×', '2×', '4×', '8×', '10×', '5-Min Express']);
  assert.deepEqual(REPLAY_SPEEDS.slice(0, 5).map((s) => s.rate), [1, 2, 4, 8, 10]);
  assert.equal(fullDaySeconds(speedById('express')), 300);
  assert.equal(fullDaySeconds(speedById('1x')), SESSION_SECONDS);
  for (const s of REPLAY_SPEEDS) assert.equal(advanceClock(0, 1000, s).clock, s.rate);
  assert.equal(advanceClock(100, 2000, speedById('4x')).clock, 108);
  assert.deepEqual(advanceClock(SESSION_SECONDS - 5, 60_000, speedById('10x')), { clock: SESSION_SECONDS, done: true });
  assert.equal(advanceClock(50, -500, speedById('1x')).clock, 50, 'time never runs backwards');
  assert.equal(speedById('nonsense').id, '1x');
});

test('timeline scrubbing is pure: frame lookup, clamping, labels — and mutates nothing', () => {
  const { frames } = buildFrames(flat());
  const snap = JSON.stringify(frames);
  assert.equal(frameIndexAt(frames, 0), -1, 'nothing has closed at 09:15:00');
  assert.equal(frameIndexAt(frames, 59.9), -1); assert.equal(frameIndexAt(frames, 60), 0);
  assert.equal(frameIndexAt(frames, 1800), 29); assert.equal(frameIndexAt(frames, SESSION_SECONDS), 374);
  assert.equal(frameIndexAt([], 100), -1);
  for (const m of [0, 100, 374]) assert.equal(frameIndexAt(frames, clockForMinute(m)), m, 'scrub to minute m shows exactly frame m');
  assert.equal(clockForMinute(-5), 60); assert.equal(clockForMinute(9999), SESSION_SECONDS);
  assert.equal(minuteOfClock(0), 0); assert.equal(minuteOfClock(SESSION_SECONDS), 374);
  assert.equal(clockLabel(0), '09:15'); assert.equal(clockLabel(SESSION_SECONDS), '15:30'); assert.equal(clockLabel(75 * 60), '10:30');
  assert.equal(JSON.stringify(frames), snap, 'frames unchanged by playback maths');
  const g = globalThis as unknown as Record<string, unknown>;
  assert.equal(g.fetch === undefined || typeof g.fetch === 'function', true);
});

test('last 5 completed trading days: weekdays only, today only after 15:30 IST', () => {
  const at = (iso: string) => Date.parse(iso);
  assert.deepEqual(lastTradingDays(at('2026-11-21T02:00:00+05:30')), ['2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16']);   // Saturday
  assert.equal(defaultReplayDate(at('2026-11-20T12:00:00+05:30')), '2026-11-19');                                                                      // Friday mid-session
  assert.equal(defaultReplayDate(at('2026-11-20T15:31:00+05:30')), '2026-11-20');
  assert.equal(defaultReplayDate(at('2026-11-23T10:00:00+05:30')), '2026-11-20');                                                                      // Monday morning → Friday
  assert.ok(lastTradingDays(at('2026-11-23T20:00:00+05:30')).every((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())));
  assert.ok(isReplayDate('2026-11-20') && !isReplayDate('2026-13-40') && !isReplayDate('x'));
});

test('player + sandbox render: speeds, scrubber, date picker, mode toggle, honest N/A', () => {
  const html = renderToStaticMarkup(createElement(SessionReplayPlayer, { symbol: 'tcs' }));
  assert.doesNotMatch(html, /data-testid="replay-play"/, 'transport controls appear only once a session has loaded');
  const src = read('components/dashboards/SessionReplayPlayer.tsx');
  assert.match(src, /REPLAY_SPEEDS\.map/); assert.match(src, /replay-speed-\$\{s\.id\}/); assert.match(src, /replay-play/); assert.match(src, /replay-reset/);
  assert.match(src, /data-testid="replay-scrub"/); assert.match(html, /data-testid="replay-date"/); assert.match(html, /data-testid="replay-symbol"[^>]*value="TCS"/);
  assert.equal((html.match(/<option value="2\d{3}-/g) ?? []).length, 5, 'last five trading days');
  assert.match(html, /Read-only — it never changes live quotes/);
  const sb = renderToStaticMarkup(createElement(RuleSandbox));
  assert.match(sb, /Synthetic Burst Demo/); assert.match(sb, /Historical Session Replay \(09:15–15:30 IST\)/); assert.match(sb, /id="desk-sec-sandbox"/);
  assert.match(sb, /data-testid="sandbox-start"/, 'synthetic mode is the default');
});

test('wiring: read-only route, player reads only, README documents the mode, npm test runs this file', () => {
  const route = read('app/api/market/session-replay/route.ts');
  assert.match(route, /export async function GET/); assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)|insertTicks/);
  assert.match(route, /symbolDayTicks/); assert.match(route, /no-store/); assert.match(route, /synthetic/);
  const pl = read('components/dashboards/SessionReplayPlayer.tsx');
  assert.doesNotMatch(pl, /engine\.|localStorage|method: 'POST'|useCloud/);
  assert.match(read('lib/sessionReplay.ts'), /Supabase Recorded Ticks[\s\S]*Yahoo 1m Intraday Bars[\s\S]*Synthetic Fallback/);
  assert.doesNotMatch(read('lib/sessionReplay.ts'), /fetch\(|process\.env|from '\.\/(marketStore|supabaseAdmin|serverAuth)'/, 'lib/sessionReplay.ts is pure');
  const readme = read('README.md'); assert.match(readme, /Market DVR/); assert.match(readme, /session-replay/); assert.match(readme, /N\/A/);
  assert.match(read('package.json'), /week11-replay\.test\.ts/);
});
