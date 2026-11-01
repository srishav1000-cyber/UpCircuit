// The 11 day-trader skills as pure, dependency-free functions over real daily bars + the user's own inputs.
// Scanner, Levels, Entry, Exit, Time Machine, Budget, Risk, Journal, Alerts, News and Analyst. Planning and analysis only — UpCircuit never places an order.
import { ema, rsi, scan, supportResistance, MIN_BARS, type Bar, type Bias, type Signal } from './chartScanner';
import { planPosition } from './analytics/positionSize';

export const SKILLS = [
  { id: 'scanner', label: 'Scanner' }, { id: 'news', label: 'News' }, { id: 'analyst', label: 'Analyst' }, { id: 'levels', label: 'Levels' }, { id: 'entry', label: 'Entry' }, { id: 'exit', label: 'Exit' },
  { id: 'time', label: 'Time Machine' }, { id: 'budget', label: 'Budget' }, { id: 'risk', label: 'Risk' }, { id: 'journal', label: 'Journal' }, { id: 'alerts', label: 'Alerts' },
] as const;
export type SkillId = (typeof SKILLS)[number]['id'];
const r2 = (x: number) => Math.round(x * 100) / 100;

/* 03 · ATR / trend facts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export function atr(bars: readonly Bar[], n = 14): number | null {
  if (bars.length <= n) return null;
  const tr = (i: number) => Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  let a = 0; for (let i = 1; i <= n; i++) a += tr(i); a /= n; for (let i = n + 1; i < bars.length; i++) a = (a * (n - 1) + tr(i)) / n; return a;
}

/* 04 · Levels ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface LevelSet { prevHigh: number; prevLow: number; prevClose: number; pivot: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number; high20: number; low20: number; bands: { px: number; touches: number }[] }
/** Classic floor-trader pivots from the LAST COMPLETED session (bars[-2] when the last bar is today's partial bar is the caller's choice: pass the bar to use as `prev`). */
export function levels(bars: readonly Bar[], prevIdx = bars.length - 1): LevelSet | null {
  if (bars.length < 21 || prevIdx < 20) return null;
  const p = bars[prevIdx], P = (p.high + p.low + p.close) / 3, w = bars.slice(prevIdx - 19, prevIdx + 1);
  return { prevHigh: p.high, prevLow: p.low, prevClose: p.close, pivot: P, r1: 2 * P - p.low, s1: 2 * P - p.high, r2: P + (p.high - p.low), s2: P - (p.high - p.low), r3: p.high + 2 * (P - p.low), s3: p.low - 2 * (p.high - P),
    high20: Math.max(...w.map((b) => b.high)), low20: Math.min(...w.map((b) => b.low)), bands: supportResistance(bars.slice(0, prevIdx + 1)) };
}
export const nearest = (px: number, list: number[], side: 'above' | 'below'): number | null => { const c = list.filter((x) => (side === 'above' ? x > px : x < px)).sort((a, b) => Math.abs(a - px) - Math.abs(b - px)); return c[0] ?? null; };
export const levelList = (l: LevelSet): number[] => [l.prevHigh, l.prevLow, l.pivot, l.r1, l.r2, l.s1, l.s2, l.high20, l.low20, ...l.bands.map((b) => b.px)];

/* 05–06 · Entry & Exit plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export type Side = 'long' | 'short';
export interface TradePlan { side: Side; entry: number; trigger: number; stop: number; atr: number; riskPerShare: number; targets: { r: number; px: number }[]; nextLevel: number | null; rrToLevel: number | null; trail: string; checks: { ok: boolean | null; text: string }[] }
/** `entry` defaults to the last close. Stop = 1.5 × ATR(14) beyond entry, tightened behind the nearest opposing level if that is closer (but never < 0.5 ATR). Targets 1R / 2R / 3R. */
export function buildPlan(bars: readonly Bar[], side: Side, entryPx?: number, prevIdx?: number): TradePlan | null {
  const a = atr(bars), lv = levels(bars, prevIdx); if (a === null || !lv) return null;
  const last = bars[bars.length - 1], entry = entryPx ?? last.close, lvls = levelList(lv), dir = side === 'long' ? 1 : -1;
  const back = nearest(entry, lvls, side === 'long' ? 'below' : 'above'), ahead = nearest(entry, lvls, side === 'long' ? 'above' : 'below');
  let risk = 1.5 * a; if (back !== null) { const d = Math.abs(entry - back) + 0.25 * a; if (d >= 0.5 * a && d < risk) risk = d; }
  const stop = entry - dir * risk;
  const trigger = side === 'long' ? Math.max(last.high, ahead !== null && ahead - entry < 0.5 * a ? ahead : last.high) : Math.min(last.low, ahead !== null && entry - ahead < 0.5 * a ? ahead : last.low);
  const closes = bars.map((b) => b.close), e20 = ema(closes, 20).at(-1) ?? null, e50 = ema(closes, 50).at(-1) ?? null, r14 = rsi(closes, 14).at(-1) ?? null, c = last.close;
  const checks: TradePlan['checks'] = [
    { ok: e20 === null ? null : side === 'long' ? c > e20 : c < e20, text: e20 === null ? 'EMA20 n/a' : `Close ${c.toFixed(2)} ${c > e20 ? 'above' : 'below'} EMA20 ${e20.toFixed(2)}` },
    { ok: e20 === null || e50 === null ? null : side === 'long' ? e20 > e50 : e20 < e50, text: e20 === null || e50 === null ? 'EMA50 n/a' : `EMA20 ${e20 > e50 ? 'above' : 'below'} EMA50 (${e50.toFixed(2)})` },
    { ok: r14 === null ? null : side === 'long' ? r14 > 50 && r14 < 75 : r14 < 50 && r14 > 25, text: r14 === null ? 'RSI n/a' : `RSI(14) ${r14.toFixed(1)} — ${side === 'long' ? 'momentum up but not stretched (50–75)' : 'momentum down but not stretched (25–50)'}` },
    { ok: ahead === null ? null : Math.abs(ahead - entry) >= risk, text: ahead === null ? 'No level ahead found' : `Next level ${ahead.toFixed(2)} is ${(Math.abs(ahead - entry) / risk).toFixed(1)}R away (want ≥ 1R of room)` },
  ];
  return { side, entry: r2(entry), trigger: r2(trigger), stop: r2(stop), atr: r2(a), riskPerShare: r2(risk), targets: [1, 2, 3].map((r) => ({ r, px: r2(entry + dir * r * risk) })), nextLevel: ahead === null ? null : r2(ahead), rrToLevel: ahead === null ? null : r2(Math.abs(ahead - entry) / risk),
    trail: `Trail the stop to the higher of breakeven after +1R and EMA20${e20 === null ? '' : ` (${e20.toFixed(2)})`}; exit on a close ${side === 'long' ? 'below' : 'above'} it. Time stop: no progress after 3 sessions.`, checks };
}

/* 07 · Time Machine: what happened after each pattern the scanner would have flagged in the past ─────────────────────────────────────────── */
export interface TmRow { id: string; name: string; bias: Bias; n: number; h1: number | null; h3: number | null; h5: number | null; hit5: number | null }
export const mean = (v: number[]) => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : null);
/** Walk-forward over the history: at each bar i, scan using ONLY bars[0..i] (no look-ahead), then measure direction-adjusted % return after 1 / 3 / 5 bars. Neutral patterns (doji) are skipped. */
export function timeMachine(bars: readonly Bar[]): TmRow[] {
  const acc = new Map<string, { name: string; bias: Bias; r: { 1: number[]; 3: number[]; 5: number[] } }>();
  for (let i = MIN_BARS - 1; i < bars.length - 1; i++) for (const s of scan(bars.slice(0, i + 1), { recent: 1 })) {
    if (s.age !== 0 || s.bias === 'neutral' || s.id.startsWith('sr-')) continue; const k = acc.get(s.id) ?? { name: s.name, bias: s.bias, r: { 1: [], 3: [], 5: [] } }; acc.set(s.id, k);
    for (const h of [1, 3, 5] as const) if (i + h < bars.length) k.r[h].push((s.bias === 'bullish' ? 1 : -1) * (bars[i + h].close / bars[i].close - 1) * 100);
  }
  return [...acc.entries()].map(([id, k]) => ({ id, name: k.name, bias: k.bias, n: k.r[1].length, h1: mean(k.r[1]), h3: mean(k.r[3]), h5: mean(k.r[5]), hit5: k.r[5].length ? (k.r[5].filter((x) => x > 0).length / k.r[5].length) * 100 : null })).sort((a, b) => b.n - a.n);
}

/* 08 · Budget ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface BudgetCfg { capital: number; dailyLossPct: number; riskPct: number; maxTrades: number }
export const DEFAULT_BUDGET: BudgetCfg = { capital: 100000, dailyLossPct: 2, riskPct: 0.5, maxTrades: 5 };
export function cleanBudget(x: unknown): BudgetCfg {
  const o = (x ?? {}) as Partial<BudgetCfg>, n = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return { capital: n(o.capital, DEFAULT_BUDGET.capital, 1000, 1e10), dailyLossPct: n(o.dailyLossPct, 2, 0.1, 20), riskPct: n(o.riskPct, 0.5, 0.05, 5), maxTrades: Math.round(n(o.maxTrades, 5, 1, 50)) };
}
export interface BudgetState { maxLoss: number; perTrade: number; lostToday: number; remaining: number; tradesToday: number; tradesLeft: number; status: 'ok' | 'warn' | 'halt'; message: string }
export function dailyBudget(b: BudgetCfg, today: { pnl: number }[]): BudgetState {
  const maxLoss = (b.capital * b.dailyLossPct) / 100, perTrade = (b.capital * b.riskPct) / 100, net = today.reduce((a, t) => a + t.pnl, 0), lostToday = Math.max(0, -net), remaining = Math.max(0, maxLoss - lostToday), tradesLeft = Math.max(0, b.maxTrades - today.length);
  const status = remaining <= 0 || tradesLeft === 0 ? 'halt' : remaining < perTrade * 1.5 || tradesLeft === 1 ? 'warn' : 'ok';
  return { maxLoss: r2(maxLoss), perTrade: r2(perTrade), lostToday: r2(lostToday), remaining: r2(remaining), tradesToday: today.length, tradesLeft, status,
    message: status === 'halt' ? (remaining <= 0 ? 'Daily loss limit reached — stop trading for today.' : 'Trade limit reached for today.') : status === 'warn' ? 'Close to today’s limit — size down or stand aside.' : 'Within today’s budget.' };
}

/* 09 · Risk checklist ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface RiskCheck { ok: boolean | null; text: string }
export function riskChecklist(i: { plan: TradePlan; budget: BudgetCfg; state: BudgetState; lowerCircuit?: number; upperCircuit?: number }): { checks: RiskCheck[]; qty: number | null; verdict: 'go' | 'caution' | 'stop' } {
  const pp = planPosition({ capital: i.budget.capital, riskPct: i.budget.riskPct, entry: i.plan.entry, stop: i.plan.stop, lowerCircuit: i.lowerCircuit, upperCircuit: i.upperCircuit });
  const err = 'error' in pp; const checks: RiskCheck[] = [
    { ok: i.state.status !== 'halt', text: i.state.message },
    { ok: err ? null : pp.qty > 0, text: err ? pp.error : `Size ${pp.qty} shares risks ₹${pp.lossAtStop.toFixed(0)} (${((pp.lossAtStop / i.budget.capital) * 100).toFixed(2)}% of capital) at the stop` },
    { ok: err ? null : pp.lossAtStop <= i.state.remaining, text: err ? 'Loss vs remaining budget n/a' : `Stop loss ₹${pp.lossAtStop.toFixed(0)} vs ₹${i.state.remaining.toFixed(0)} budget left today` },
    { ok: i.plan.rrToLevel === null ? null : i.plan.rrToLevel >= 1.5, text: i.plan.rrToLevel === null ? 'Reward-to-level n/a' : `Room to next level = ${i.plan.rrToLevel}R (want ≥ 1.5R)` },
    { ok: err ? null : !pp.cappedByCash, text: err ? 'Cash cap n/a' : pp.cappedByCash ? `Position capped by capital (${pp.positionPct.toFixed(0)}% of it)` : `Position uses ${pp.positionPct.toFixed(0)}% of capital` },
    ...(err ? [] : pp.warnings.map((w) => ({ ok: false as boolean | null, text: w }))),
  ];
  const bad = checks.filter((c) => c.ok === false).length; return { checks, qty: err ? null : pp.qty, verdict: checks[0].ok === false ? 'stop' : bad === 0 ? 'go' : 'caution' };
}

/* 10 · Journal ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface Trade { id: string; date: string; symbol: string; side: Side; entry: number; exit: number; qty: number; stop?: number; note: string; pnl: number; r: number | null }
export const MAX_TRADES = 500;
export function makeTrade(i: { date: string; symbol: string; side: Side; entry: number; exit: number; qty: number; stop?: number; note?: string }, id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`): Trade | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date)) return { error: 'Pick a date.' }; if (!/^[A-Z0-9&._-]{1,24}$/.test(i.symbol.trim().toUpperCase())) return { error: 'Enter a symbol.' };
  if (![i.entry, i.exit, i.qty].every((x) => Number.isFinite(x) && x > 0) || !Number.isInteger(i.qty)) return { error: 'Entry, exit and a whole-number quantity must be positive.' };
  const dir = i.side === 'long' ? 1 : -1, pnl = r2(dir * (i.exit - i.entry) * i.qty), risk = i.stop && i.stop > 0 && i.stop !== i.entry ? Math.abs(i.entry - i.stop) * i.qty : 0;
  return { id, date: i.date, symbol: i.symbol.trim().toUpperCase(), side: i.side, entry: i.entry, exit: i.exit, qty: i.qty, ...(i.stop ? { stop: i.stop } : {}), note: (i.note ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 200), pnl, r: risk > 0 ? r2(pnl / risk) : null };
}
export function sanitizeTrades(x: unknown): Trade[] {
  if (!Array.isArray(x)) return [];
  return x.flatMap((t: Partial<Trade>) => { const m = makeTrade({ date: String(t?.date), symbol: String(t?.symbol ?? ''), side: t?.side === 'short' ? 'short' : 'long', entry: Number(t?.entry), exit: Number(t?.exit), qty: Number(t?.qty), stop: t?.stop ? Number(t.stop) : undefined, note: String(t?.note ?? '') }, String(t?.id ?? '')); return 'error' in m || !m.id ? [] : [m]; }).slice(0, MAX_TRADES);
}
export interface JournalStats { n: number; wins: number; winRate: number | null; avgWin: number | null; avgLoss: number | null; expectancy: number | null; profitFactor: number | null; total: number; avgR: number | null }
export function journalStats(t: readonly Trade[]): JournalStats {
  const w = t.filter((x) => x.pnl > 0), l = t.filter((x) => x.pnl < 0), gw = w.reduce((a, x) => a + x.pnl, 0), gl = -l.reduce((a, x) => a + x.pnl, 0), rs = t.flatMap((x) => (x.r === null ? [] : [x.r]));
  return { n: t.length, wins: w.length, winRate: t.length ? (w.length / t.length) * 100 : null, avgWin: mean(w.map((x) => x.pnl)), avgLoss: mean(l.map((x) => x.pnl)), expectancy: t.length ? r2(t.reduce((a, x) => a + x.pnl, 0) / t.length) : null, profitFactor: gl > 0 ? r2(gw / gl) : null, total: r2(t.reduce((a, x) => a + x.pnl, 0)), avgR: mean(rs) };
}

/* 11 · Alert suggestions ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export function alertSuggestions(lv: LevelSet, plan: TradePlan | null, ltp: number): { label: string; px: number }[] {
  const raw = [{ label: 'Prev day high', px: lv.prevHigh }, { label: 'Prev day low', px: lv.prevLow }, { label: 'Pivot R1', px: lv.r1 }, { label: 'Pivot S1', px: lv.s1 }, { label: '20-day high', px: lv.high20 }, { label: '20-day low', px: lv.low20 },
    ...(plan ? [{ label: `${plan.side === 'long' ? 'Long' : 'Short'} stop`, px: plan.stop }, { label: 'Target 1R', px: plan.targets[0].px }, { label: 'Target 2R', px: plan.targets[1].px }] : [])];
  return raw.map((x) => ({ ...x, px: r2(x.px) })).filter((x) => Math.abs(x.px - ltp) / ltp > 0.001).sort((a, b) => a.px - b.px);
}

/* 03 · Analyst: rule-based brief that cites its numbers ────────────────────────────────────────────────────────────────────────────── */
export interface Brief { stance: Bias; score: number; lines: { tone: Bias; text: string }[] }
export function analystBrief(bars: readonly Bar[], signals: readonly Signal[], newsScore: number | null, newsCount: number): Brief | null {
  if (bars.length < MIN_BARS) return null; const closes = bars.map((b) => b.close), c = closes.at(-1) as number, e20 = ema(closes, 20).at(-1) as number, e50 = ema(closes, 50).at(-1) as number, r14 = rsi(closes, 14).at(-1) as number, a = atr(bars);
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low)), pos = hi > lo ? ((c - lo) / (hi - lo)) * 100 : 50, lines: Brief['lines'] = []; let score = 0;
  const add = (tone: Bias, text: string) => { lines.push({ tone, text }); score += tone === 'bullish' ? 1 : tone === 'bearish' ? -1 : 0; };
  add(c > e20 && e20 > e50 ? 'bullish' : c < e20 && e20 < e50 ? 'bearish' : 'neutral', `Trend: close ${c.toFixed(2)}, EMA20 ${e20.toFixed(2)}, EMA50 ${e50.toFixed(2)} — ${c > e20 && e20 > e50 ? 'aligned up' : c < e20 && e20 < e50 ? 'aligned down' : 'mixed'}`);
  add(r14 >= 70 ? 'bearish' : r14 <= 30 ? 'bullish' : r14 > 50 ? 'bullish' : 'bearish', `Momentum: RSI(14) ${r14.toFixed(1)}${r14 >= 70 ? ' (overbought — pullback risk)' : r14 <= 30 ? ' (oversold — bounce risk)' : ''}`);
  add('neutral', `Range: ${pos.toFixed(0)}% of the 1-year range (${lo.toFixed(2)} – ${hi.toFixed(2)})`);
  if (a !== null) add('neutral', `Volatility: ATR(14) ${a.toFixed(2)} = ${((a / c) * 100).toFixed(1)}% of price`);
  const fresh = signals.filter((s) => s.age <= 1 && s.bias !== 'neutral'); fresh.forEach((s) => add(s.bias, `Pattern: ${s.name} (${s.age === 0 ? 'latest bar' : '1 bar ago'})`)); if (!fresh.length) add('neutral', 'Pattern: nothing directional in the last 2 bars');
  if (newsScore !== null && newsCount > 0) add(newsScore >= 0.15 ? 'bullish' : newsScore <= -0.15 ? 'bearish' : 'neutral', `News: ${newsCount} headline${newsCount > 1 ? 's' : ''} mention it, average tone ${newsScore.toFixed(2)}`); else add('neutral', 'News: no headline in the latest feed mentions this stock');
  return { stance: score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral', score, lines };
}
