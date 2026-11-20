// Week 11 polish: sandbox state + visibility, eod:digest script, signal attribution / ablation, defense walkthrough, symbol-switcher wiring, badge clipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as React from 'react';
import { createElement } from 'react';
(globalThis as unknown as { React: typeof React }).React = React;   // tsx compiles component JSX to React.createElement
import { renderToStaticMarkup } from 'react-dom/server';
import { sandboxReduce, sandboxButtonLabel, type SandboxPhase } from '../lib/sandboxState';
import { buildAttribution, f1Of, type AblationRowIn } from '../lib/signalAttribution';
import { DEFENSE_CHECKPOINTS } from '../lib/defenseGuide';
import { jumpTo } from '../components/DefenseGuideDrawer';
import { RuleSandbox } from '../components/dashboards/RuleSandbox';
import { DeskSymbolSwitcher } from '../components/dashboards/DeskSymbolSwitcher';
import { SignalAttributionCard } from '../components/dashboards/SignalAttributionCard';
import { DataBadge } from '../components/DataBadge';
import { buildIndex, searchInstruments } from '../lib/fuzzy';
import { SEED_INSTRUMENTS } from '../lib/instruments';
import { synthesize, synthesizeVolume, DEFAULT_COUPLING, NO_COUPLING, runSweep } from '../scripts/backtest-heuristics';

const read = (f: string) => readFileSync(f, 'utf8');
const bt = JSON.parse(read('public/backtest-heuristics.json'));

/* ───────── package.json ───────── */
test('package.json: eod:digest registered (cross-platform, no shell syntax), polish tests wired into npm test, test:daemon not widened', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['eod:digest'], 'tsx scripts/eod-digest.ts');
  assert.doesNotMatch(pkg.scripts['eod:digest'], /[&|;$]|\bexport\b|=/);
  assert.match(pkg.scripts.test, /tests\/week11-polish\.test\.ts/); assert.equal(pkg.scripts['test:polish'], 'tsx --test tests/week11-polish.test.ts');
  for (const t of ['week10', 'fixes', 'week11', 'daemon-health', 'week11-capstone', 'week11-final']) assert.match(pkg.scripts.test, new RegExp(`tests/${t}\\.test\\.ts`), t);
  assert.equal(pkg.scripts['test:daemon'], 'tsx --test tests/daemon-health.test.ts');
});
test('npm run eod:digest -- --offline prints the labelled replay digest and exits 0', () => {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'eod:digest', '--', '--offline'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 90_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /REPLAY/); assert.match(r.stdout, /Top R\(t\): RELIANCE/); assert.match(r.stdout, /Circuit : INFY UPPER/); assert.match(r.stdout, /Flags/);
});

/* ───────── sandbox: state machine, render, visibility ───────── */
test('sandbox state machine: idle → playing → paused → playing → done → replay; reset from anywhere', () => {
  let p: SandboxPhase = 'idle';
  const seq: [Parameters<typeof sandboxReduce>[1], SandboxPhase][] = [['toggle', 'playing'], ['toggle', 'paused'], ['toggle', 'playing'], ['finish', 'done'], ['finish', 'done'], ['toggle', 'playing'], ['reset', 'idle']];
  for (const [a, want] of seq) { p = sandboxReduce(p, a); assert.equal(p, want, a); }
  assert.equal(sandboxReduce('paused', 'finish'), 'paused', 'finish only applies while playing'); assert.equal(sandboxReduce('done', 'reset'), 'idle');
  assert.deepEqual((['idle', 'playing', 'paused', 'done'] as const).map(sandboxButtonLabel), ['Simulate Live Market Burst', 'Pause', 'Resume', 'Replay again']);
});
test('sandbox initial render: button, Reset, SIMULATION labels, three stock cards, no live-feed badge', () => {
  const html = renderToStaticMarkup(createElement(RuleSandbox));
  for (const t of ['Simulate Live Market Burst', 'Reset', 'SIMULATION', 'data-testid="sandbox-start"', 'data-phase="idle"', 'sandbox-stock-RELIANCE', 'sandbox-stock-TCS', 'sandbox-stock-INFY', 'follow action', 'Press the button to start']) assert.ok(html.includes(t), t);
  assert.ok(!html.includes('SmartAPI Live'), 'a scripted book must never be tagged as live SmartAPI data');
  assert.match(html, /id="desk-sec-sandbox"/);
});
test('sandbox is prominent: unconditional in the desk (no market-hours, accordion or cloud guard), above the circuit/volume panes; reachable without an account', () => {
  const ws = read('components/dashboards/SurveillanceWorkspace.tsx');
  const i = ws.indexOf('<RuleSandbox'); assert.ok(i > 0);
  assert.ok(i < ws.indexOf('data-testid="desk-circuit"'), 'sandbox renders before the circuit pane');
  const line = ws.split('\n').find((l) => l.includes('<RuleSandbox'))!; assert.doesNotMatch(line, /&&|\?|isMarketOpen/);
  assert.equal((ws.match(/<RuleSandbox/g) ?? []).length, 1, 'rendered once');
  assert.doesNotMatch(read('components/dashboards/RuleSandbox.tsx'), /isMarketOpen|<details|useCloud|cloud\./);
  const cw = read('components/ComplianceWorkspace.tsx');
  assert.match(cw, /compliance-unavailable[\s\S]*<OfflineSurveillance/, 'no-account branch shows the lab');
  assert.match(read('components/dashboards/OfflineSurveillance.tsx'), /<RuleSandbox \/>[\s\S]*<EodDigestCard[\s\S]*<SignalAttributionCard/);
  assert.match(read('app/page.tsx'), /<Navbar[\s\S]*?\n\s*showCompliance\n/, 'Compliance tab is shown in demo / local accounts too');
});

/* ───────── signal attribution / ablation ───────── */
const mk = (id: string, flags: number, tp: number, precision: number | null, recall: number | null): AblationRowIn => ({ id, label: id, signals: id, metrics: { flags, tp, fp: flags - tp, precision, recall } });
test('attribution maths: F1, FP reduction vs baseline, precision lift, bests', () => {
  assert.equal(f1Of(0.5, 0.5), 0.5); assert.equal(f1Of(null, 0.5), null); assert.equal(f1Of(0, 0), null);
  const a = buildAttribution({ data: { snapshots: 1000 }, ablation: [mk('baseline', 100, 20, 0.2, 0.9), mk('obi_only', 40, 16, 0.4, 0.6), mk('composite', 25, 15, 0.6, 0.3)] })!;
  const [b, o, c] = a.rows;
  assert.equal(b.fpReductionPct, null); assert.equal(b.precisionLiftPts, null);
  assert.equal(o.fpReductionPct, 70);        // (80 − 24) ÷ 80
  assert.equal(c.fpReductionPct, 87.5);      // (80 − 10) ÷ 80
  assert.equal(c.precisionLiftPts, 40); assert.equal(c.recallChangePts, -60);
  assert.ok(Math.abs(b.f1! - (2 * 0.2 * 0.9) / 1.1) < 1e-12);
  assert.equal(a.rows.filter((r) => r.best.precision).map((r) => r.id).join(), 'composite');
  assert.equal(a.bestF1, 'obi_only'); assert.ok(a.notes.some((n) => /best F1/.test(n)), 'says when the composite is not the best F1');
  assert.equal(buildAttribution(null), null); assert.equal(buildAttribution({ ablation: [] }), null);
  assert.equal(buildAttribution({ ablation: [mk('baseline', 0, 0, null, null)] })!.rows[0].f1, null);
});
test('published benchmark: six ablation rows reproduce the headline numbers and are internally consistent', () => {
  const a = buildAttribution(bt)!;
  assert.equal(a.snapshots, 539_972); assert.deepEqual(a.rows.map((r) => r.id), ['baseline', 'obi_only', 'volume_only', 'spread_only', 'obi_and_volume', 'composite']);
  const [b, , , , , c] = a.rows;
  assert.equal(Math.round(b.precision! * 1000) / 10, 13.3); assert.deepEqual(b.precision, bt.precision); assert.equal(b.flags, bt.modes.baseline.flags);
  assert.deepEqual([c.precision, c.recall, c.flags, c.fp], [bt.modes.confirmed_composite.precision, bt.modes.confirmed_composite.recall, bt.modes.confirmed_composite.flags, bt.modes.confirmed_composite.fp]);
  assert.equal(c.fpReductionPct, 71.4);
  for (const r of a.rows) {
    assert.equal(r.tp + r.fp, r.flags, r.id); assert.ok(r.flags <= b.flags, r.id);
    assert.ok(Math.abs(r.precision! - r.tp / r.flags) < 0.0015, `${r.id} precision from counts`);
    assert.ok(Math.abs(r.f1! - (2 * r.precision! * r.recall!) / (r.precision! + r.recall!)) < 0.002, `${r.id} F1`);
  }
  assert.ok(a.rows.slice(1).every((r) => r.precision! > b.precision!), 'every corroborating signal beats the baseline on precision');
  assert.ok(a.rows.slice(1).every((r) => r.recall! < b.recall!), '…and costs recall');
  assert.ok(a.notes.some((n) => /not the composite/.test(n)), 'the honest finding (OBI alone has the best F1) is stated');
});
test('backtest script produces the ablation block deterministically on a small synthetic day', () => {
  const { snaps, episodes } = synthesize({ symbols: 2, days: 1, stepMs: 1000, seed: 7, noise: 0.45 });
  const sw = runSweep(snaps, episodes, synthesizeVolume(snaps, episodes, 7, DEFAULT_COUPLING), synthesizeVolume(snaps, episodes, 7, NO_COUPLING));
  assert.deepEqual(sw.ablation.map((r) => r.id), ['baseline', 'obi_only', 'volume_only', 'spread_only', 'obi_and_volume', 'composite']);
  assert.deepEqual(sw.ablation[0].metrics, sw.modes.baseline);
  assert.equal(sw.ablation[5].metrics.flags, sw.modes.confirmed_composite.flags);
  for (const r of sw.ablation) assert.equal(r.metrics.tp + r.metrics.fp, r.metrics.flags);
});
test('ablation card renders the table, bests, honest note and an N/A state', () => {
  const html = renderToStaticMarkup(createElement(SignalAttributionCard, { data: bt }));
  assert.equal((html.match(/data-testid="ablation-row"/g) ?? []).length, 6);
  for (const t of ['Order-book imbalance OBI_λ alone', '15-min volume surge R(t) alone', 'Resting wall / flicker alone', 'Multi-Signal Confirmed composite', '5,39,972', '71.4 %', 'Synthetic benchmark']) assert.ok(html.includes(t), t);
  assert.ok(renderToStaticMarkup(createElement(SignalAttributionCard, { data: null })).includes('ablation-na'));
});

/* ───────── defense walkthrough ───────── */
test('defense walkthrough: five checkpoints with formulas, caveats and real jump targets', () => {
  assert.deepEqual(DEFENSE_CHECKPOINTS.map((c) => c.title), ['Live SmartAPI & 24/7 Lease Daemon', '15-Min Volume Baseline & Weighted OBI', 'Multi-Signal Precision Ablation & Threshold Explorer', 'Live Market Burst Replay Sandbox', 'SEBI White-Box Audit Pack Export']);
  const src = ['components/dashboards/SurveillanceWorkspace.tsx', 'components/dashboards/SignalAttributionCard.tsx', 'components/dashboards/RuleSandbox.tsx', 'components/dashboards/AuditExport.tsx'].map(read).join('\n');
  for (const c of DEFENSE_CHECKPOINTS) { assert.ok(src.includes(`id="${c.targetId}"`), `${c.targetId} exists on the desk`); assert.ok(c.formulas.length && c.caveats.length, c.id); }
  const all = JSON.stringify(DEFENSE_CHECKPOINTS);
  assert.match(all, /OBI_λ = Σᵢ wᵢ\(Bᵢ − Aᵢ\)/); assert.match(all, /e\^\(−λ\(i−1\)\)/); assert.match(all, /R\(t\) = /); assert.match(all, /F1 = 2PR/); assert.match(all, /SHA-256/);
  assert.doesNotMatch(all, /SEBI[- ]compliant(?!ce)/i); assert.match(all, /does not claim SEBI compliance/);
  assert.match(all, /OBI alone has the best F1/);
  assert.match(read('components/dashboards/SurveillanceWorkspace.tsx'), /<DefenseGuideDrawer/); assert.match(read('components/dashboards/OfflineSurveillance.tsx'), /<DefenseGuideDrawer/);
});
test('jumpTo scrolls, outlines the target and restores it; reports a missing target', () => {
  const timers: (() => void)[] = []; const g = globalThis as unknown as { window?: unknown };
  g.window = { setTimeout: (f: () => void) => { timers.push(f); return 1; } };
  try {
    const attrs = new Map<string, string>(); let scrolled = 0;
    const el = { style: { outline: '', outlineOffset: '' }, scrollIntoView: () => { scrolled++; }, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
    const doc = { getElementById: (id: string) => (id === 'x' ? el : null) } as unknown as Document;
    assert.equal(jumpTo('x', doc), true); assert.equal(scrolled, 1); assert.equal(attrs.get('data-defense-highlight'), 'on'); assert.match(el.style.outline, /solid/);
    timers.forEach((f) => f()); assert.equal(el.style.outline, ''); assert.equal(attrs.has('data-defense-highlight'), false);
    assert.equal(jumpTo('missing', doc), false);
  } finally { delete g.window; }
});

/* ───────── symbol switcher ───────── */
test('symbol switcher: Navbar action menu item (/) + desk inline switcher are wired end to end', () => {
  const nav = read('components/Navbar.tsx');
  assert.match(nav, /data-testid="switch-symbol"[\s\S]*Switch Symbol/); assert.match(nav, /<kbd[^>]*>\/<\/kbd>/);
  assert.match(nav, /onSwitchSymbol: switchSymbol/); assert.match(nav, /input\[data-testid="search-input"\]/);
  for (const k of ['Deep Research', 'Watchlist', 'Set Price Alert']) assert.ok(nav.includes(k), k + ' kept');
  assert.ok(nav.indexOf('switch-symbol') < nav.indexOf('Deep Research</button>'), 'Switch Symbol is the first item');
  assert.match(read('components/SearchBox.tsx'), /data-testid="search-input"/);
  assert.match(read('app/page.tsx'), /onSwitchSymbol: setSymbol/); assert.match(read('app/page.tsx'), /instruments, onSwitchSymbol/);
  assert.match(read('components/ComplianceWorkspace.tsx'), /instruments=\{desk\.instruments\} onSwitchSymbol=\{desk\.onSwitchSymbol\}/);
  assert.match(read('components/dashboards/SurveillanceWorkspace.tsx'), /<DeskSymbolSwitcher instruments=\{instruments\} symbol=\{symbol\} onSwitch=\{onSwitchSymbol\}/);
});
test('desk switcher renders the current symbol and searches the universe', () => {
  const html = renderToStaticMarkup(createElement(DeskSymbolSwitcher, { instruments: SEED_INSTRUMENTS, symbol: 'RELIANCE', onSwitch: () => undefined }));
  assert.match(html, /desk-switcher-current[^>]*>RELIANCE</); assert.match(html, /Switch symbol…/); assert.match(html, /role="combobox"/);
  const idx = buildIndex(SEED_INSTRUMENTS);
  assert.ok(searchInstruments(idx, 'TCS', 6).some((r) => r.symbol === 'TCS')); assert.ok(searchInstruments(idx, 'infosy', 6).some((r) => r.symbol === 'INFY'), 'typo-tolerant');
  assert.equal(searchInstruments(idx, 'zzzzqqqq', 6).length, 0);
});

/* ───────── badge clipping + hygiene ───────── */
test('DataBadge never overflows a narrow card: shrinkable, truncating, compact pill', () => {
  const html = renderToStaticMarkup(createElement(DataBadge, { kind: 'yahoo', label: 'Yahoo Fundamentals' }));
  for (const c of ['max-w-full', 'min-w-0', 'truncate', 'whitespace-nowrap', 'text-[10px]', 'px-1.5']) assert.ok(html.includes(c), c);
  assert.ok(!html.includes('shrink-0'), 'a non-shrinking badge is what clipped'); assert.ok(html.includes('[Yahoo Fundamentals]')); assert.match(html, /title="Yahoo Fundamentals —/);
  const pm = read('components/StockPostMortem.tsx'); assert.match(pm, /min-w-0 overflow-hidden rounded border/);
});
test('zero secrets in the polish files', () => {
  const bad = [/sb_secret_[A-Za-z0-9_-]{8,}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /\bre_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  for (const f of ['lib/signalAttribution.ts', 'lib/defenseGuide.ts', 'lib/sandboxState.ts', 'components/DefenseGuideDrawer.tsx', 'components/dashboards/DeskSymbolSwitcher.tsx', 'components/dashboards/SignalAttributionCard.tsx', 'components/dashboards/OfflineSurveillance.tsx', 'public/backtest-heuristics.json', 'package.json']) { const t = read(f); for (const re of bad) assert.ok(!re.test(t), `${f} matches ${re}`); }
});
