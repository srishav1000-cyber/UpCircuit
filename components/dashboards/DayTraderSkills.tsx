'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../ui';
import { ChartScanner, BIAS } from './ChartScanner';
import { useDailyBars } from '@/hooks/useDailyBars';
import { useNews } from '@/hooks/useNews';
import { apiFetch } from '@/lib/authBus';
import { scoped } from '@/lib/scope';
import { scan, type Bar } from '@/lib/chartScanner';
import { SKILLS, DEFAULT_BUDGET, alertSuggestions, analystBrief, buildPlan, cleanBudget, dailyBudget, journalStats, levels, makeTrade, riskChecklist, sanitizeTrades, timeMachine, MAX_TRADES, type BudgetCfg, type SkillId, type Side, type Trade, type TradePlan } from '@/lib/dayTrader';
import type { FeedMode } from '@/lib/market';
import type { NewsItem, Quote } from '@/lib/types';

const inp = 'num w-full rounded border border-line bg-bg px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent';
const btn = 'rounded-md border border-line px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-line disabled:opacity-40';
const f2 = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? 'N/A' : x.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const sgn = (x: number | null) => (x === null ? 'N/A' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
const tone = (x: number | null) => (x === null ? 'text-muted' : x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink');
const istToday = () => new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
const Check = ({ ok, text }: { ok: boolean | null; text: string }) => <li className="flex gap-2 text-[12px]"><span aria-label={ok === null ? 'unknown' : ok ? 'pass' : 'fail'} className={ok === null ? 'text-muted' : ok ? 'text-up' : 'text-down'}>{ok === null ? '–' : ok ? '✓' : '✕'}</span><span className="text-ink">{text}</span></li>;
const Note = ({ children }: { children: React.ReactNode }) => <p className="mt-2 text-[10px] text-muted">{children}</p>;

function useStored<T>(key: string, init: T, clean: (x: unknown) => T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(init);
  useEffect(() => { try { const raw = localStorage.getItem(scoped(key)); if (raw) setV(clean(JSON.parse(raw))); } catch { /* ignore */ } }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [v, (n: T) => { setV(n); try { localStorage.setItem(scoped(key), JSON.stringify(n)); } catch { /* ignore */ } }];
}

interface Props { quote: Quote; mode: FeedMode; favorites: string[]; onSelect: (s: string) => void; onAskAI: (prompt?: string) => void; onAddAlert?: (symbol: string, target: number, ltp: number) => { ok: true } | { ok: false; error: string }; className?: string }

/** The eleven day-trader skills in one card. Everything is computed in the browser from real daily bars + your own inputs; nothing here places an order. */
export function DayTraderSkills({ quote, mode, favorites, onSelect, onAskAI, onAddAlert, className = '' }: Props) {
  const [tab, setTab] = useState<SkillId>('scanner');
  const { series, err, stamp, live, prevIdx } = useDailyBars(quote.symbol, quote.ltp, mode === 'live');
  const [side, setSide] = useState<Side>('long');
  const [budget, setBudget] = useStored<BudgetCfg>('upcircuit:dt-budget:v1', DEFAULT_BUDGET, cleanBudget);
  const [trades, setTrades] = useStored<Trade[]>('upcircuit:dt-journal:v1', [], sanitizeTrades);
  const signals = useMemo(() => (series ? scan(series) : []), [series]);
  const lv = useMemo(() => (series ? levels(series, prevIdx) : null), [series, prevIdx]);
  const plan = useMemo(() => (series ? buildPlan(series, side, undefined, prevIdx) : null), [series, side, prevIdx]);
  const state = useMemo(() => dailyBudget(budget, trades.filter((t) => t.date === istToday())), [budget, trades]);
  const keys = SKILLS.map((s) => s.id);
  const onKey = (e: React.KeyboardEvent) => { const i = keys.indexOf(tab), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (d) { e.preventDefault(); const n = keys[(i + d + keys.length) % keys.length]; setTab(n); document.getElementById(`dts-tab-${n}`)?.focus(); } };
  const needBars = !series ? <p className="py-3 text-center text-[12px] text-muted" data-testid="dts-na">{err ? `N/A — ${err}` : 'Loading daily history…'}</p> : series.length < 60 ? <p className="py-3 text-center text-[12px] text-muted" data-testid="dts-na">N/A — needs 60+ daily bars (have {series.length}).</p> : null;
  return (
    <Card title={`Day-trader toolkit · ${quote.symbol}`} className={className} right={<span className="text-[10px] text-muted">11 skills · analysis only, no orders</span>}>
      <div role="tablist" aria-label="Day-trader skills" onKeyDown={onKey} className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-1 pb-1" data-testid="dts-tabs">
        {SKILLS.map((s, i) => <button key={s.id} id={`dts-tab-${s.id}`} role="tab" aria-selected={tab === s.id} aria-controls="dts-panel" tabIndex={tab === s.id ? 0 : -1} data-testid={`skill-${s.id}`} onClick={() => setTab(s.id)} className={`shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-semibold ${tab === s.id ? 'border-accent bg-accent/15 text-ink' : 'border-line text-muted hover:text-ink'}`}><span className="num mr-1 text-[9px]">{String(i + 1).padStart(2, '0')}</span>{s.label}</button>)}
      </div>
      <div id="dts-panel" role="tabpanel" aria-labelledby={`dts-tab-${tab}`} data-testid="dts-panel" data-tab={tab}>
        {tab === 'scanner' && <><ChartScanner series={series} err={err} live={live} stamp={stamp} /><WatchlistScan symbols={favorites} current={quote.symbol} onSelect={onSelect} /></>}
        {tab === 'news' && <NewsTab symbol={quote.symbol} />}
        {tab === 'analyst' && (needBars ?? <AnalystTab symbol={quote.symbol} series={series as Bar[]} onAskAI={onAskAI} />)}
        {tab === 'levels' && (needBars ?? (lv && <LevelsTab lv={lv} ltp={quote.ltp} />))}
        {tab === 'entry' && (needBars ?? (plan && <EntryTab plan={plan} side={side} setSide={setSide} />))}
        {tab === 'exit' && (needBars ?? (plan && <ExitTab plan={plan} side={side} setSide={setSide} />))}
        {tab === 'time' && (needBars ?? <TimeTab series={series as Bar[]} />)}
        {tab === 'budget' && <BudgetTab budget={budget} setBudget={setBudget} state={state} />}
        {tab === 'risk' && (needBars ?? (plan && <RiskTab plan={plan} budget={budget} state={state} quote={quote} side={side} setSide={setSide} />))}
        {tab === 'journal' && <JournalTab symbol={quote.symbol} trades={trades} setTrades={setTrades} plan={plan} />}
        {tab === 'alerts' && (needBars ?? (lv && <AlertsTab symbol={quote.symbol} lv={lv} plan={plan} ltp={quote.ltp} onAddAlert={onAddAlert} />))}
      </div>
    </Card>
  );
}

/* 01 · scan the watchlist ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function WatchlistScan({ symbols, current, onSelect }: { symbols: string[]; current: string; onSelect: (s: string) => void }) {
  const [rows, setRows] = useState<{ s: string; n: number; net: string; top: string }[] | null>(null); const [busy, setBusy] = useState(false);
  const list = useMemo(() => [...new Set([current, ...symbols])].slice(0, 12), [symbols, current]);
  async function run() {
    setBusy(true); const out: NonNullable<typeof rows> = []; const q = [...list];
    await Promise.all(Array.from({ length: 3 }, async () => { while (q.length) { const s = q.shift() as string; try { const j = (await (await apiFetch(`/api/bars/${encodeURIComponent(s)}?tf=1Y`)).json()) as { ok?: boolean; bars?: Bar[] }; const g = j.ok && j.bars ? scan(j.bars) : []; const bull = g.filter((x) => x.bias === 'bullish').length, bear = g.filter((x) => x.bias === 'bearish').length; out.push({ s, n: g.length, net: bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral', top: g[0]?.name ?? '—' }); } catch { out.push({ s, n: 0, net: 'neutral', top: 'N/A' }); } } }));
    setRows(out.sort((a, b) => b.n - a.n)); setBusy(false);
  }
  return (
    <div className="mt-3 border-t border-line pt-3" data-testid="wl-scan">
      <div className="mb-2 flex items-center gap-2"><button type="button" onClick={() => void run()} disabled={busy} data-testid="wl-scan-run" className={btn}>{busy ? 'Scanning…' : `Scan my watchlist (${list.length})`}</button><span className="text-[10px] text-muted">patterns completed in the last 3 daily bars, real history</span></div>
      {rows && <table className="w-full text-left text-[12px]"><thead className="text-[10px] uppercase tracking-wide text-muted"><tr><th className="py-1 pr-2">Scrip</th><th className="pr-2">Signals</th><th className="pr-2">Net</th><th>Latest</th></tr></thead><tbody>{rows.map((r) => <tr key={r.s} className="border-t border-line"><td className="py-1 pr-2"><button type="button" onClick={() => onSelect(r.s)} className="font-semibold text-accent hover:underline">{r.s}</button></td><td className="num pr-2">{r.n}</td><td className={`pr-2 ${r.net === 'bullish' ? 'text-up' : r.net === 'bearish' ? 'text-down' : 'text-muted'}`}>{r.net}</td><td className="text-muted">{r.top}</td></tr>)}</tbody></table>}
    </div>
  );
}

/* 02 · News ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function newsFor(items: NewsItem[] | undefined, symbol: string) { const m = (items ?? []).filter((n) => n.symbols?.includes(symbol)); return { m, avg: m.length ? m.reduce((a, n) => a + n.score, 0) / m.length : null }; }
function NewsTab({ symbol }: { symbol: string }) {
  const { news, error } = useNews(); const { m, avg } = newsFor(news?.items, symbol);
  if (!news) return <p className="py-3 text-center text-[12px] text-muted">{error ? 'N/A — news feed unavailable.' : 'Loading headlines…'}</p>;
  return (
    <div data-testid="skill-news-body">
      <p className="mb-2 text-[12px] text-ink">{m.length ? <>{m.length} headline{m.length > 1 ? 's' : ''} mention <b>{symbol}</b> · average tone <b className={tone(avg)}>{f2(avg)}</b></> : <>No headline in the latest feed mentions <b>{symbol}</b>.</>}{news.mode === 'sample' && <span className="ml-1 text-warn">(feeds unreachable — sample headlines)</span>}</p>
      <ul className="divide-y divide-line">{m.slice(0, 6).map((n) => <li key={n.id} className="flex items-start gap-2 py-1.5"><span className={`mt-0.5 shrink-0 rounded border px-1.5 py-px text-[10px] font-bold uppercase ${BIAS[n.score >= 0.15 ? 'bullish' : n.score <= -0.15 ? 'bearish' : 'neutral']}`}>{n.score.toFixed(2)}</span><a href={n.link} target="_blank" rel="noopener noreferrer" className="min-w-0 text-[12px] text-ink hover:underline">{n.title}<span className="ml-1 text-[10px] text-muted">{n.source}</span></a></li>)}</ul>
      <Note>Tone is the local VADER + finance-rules score of each headline (−1 … +1), refreshed every 5 minutes. A mention is not a catalyst.</Note>
    </div>
  );
}

/* 03 · Analyst ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function AnalystTab({ symbol, series, onAskAI }: { symbol: string; series: Bar[]; onAskAI: (p?: string) => void }) {
  const { news } = useNews(); const { m, avg } = newsFor(news?.items, symbol);
  const brief = useMemo(() => analystBrief(series, scan(series), avg, m.length), [series, avg, m.length]);
  if (!brief) return null;
  return (
    <div data-testid="skill-analyst-body" data-stance={brief.stance}>
      <div className="mb-2 flex items-center gap-2"><span className={`rounded border px-2 py-0.5 text-[11px] font-bold uppercase ${BIAS[brief.stance]}`}>Lean {brief.stance}</span><span className="num text-[11px] text-muted">score {brief.score > 0 ? '+' : ''}{brief.score}</span></div>
      <ul className="space-y-1">{brief.lines.map((l, i) => <li key={i} className="flex gap-2 text-[12px]"><span className={l.tone === 'bullish' ? 'text-up' : l.tone === 'bearish' ? 'text-down' : 'text-muted'}>●</span><span className="text-ink">{l.text}</span></li>)}</ul>
      <button type="button" className={`${btn} mt-3`} onClick={() => onAskAI(`Review ${symbol} as a day-trading candidate using these facts: ${brief.lines.map((l) => l.text).join('; ')}. What would invalidate the setup?`)}>Ask UpCircuit AI to review</button>
      <Note>Rule-based summary: one vote per line (trend, RSI, patterns, news). It restates the numbers shown — it is not a recommendation.</Note>
    </div>
  );
}

/* 04 · Levels ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function LevelsTab({ lv, ltp }: { lv: NonNullable<ReturnType<typeof levels>>; ltp: number }) {
  const rows: [string, number][] = [['R3', lv.r3], ['R2', lv.r2], ['R1', lv.r1], ['Prev high', lv.prevHigh], ['Pivot', lv.pivot], ['Prev close', lv.prevClose], ['Prev low', lv.prevLow], ['S1', lv.s1], ['S2', lv.s2], ['S3', lv.s3]];
  const all = [...rows, ['20d high', lv.high20] as [string, number], ['20d low', lv.low20] as [string, number], ...lv.bands.map((b): [string, number] => [`Band ×${b.touches}`, b.px])].sort((a, b) => b[1] - a[1]);
  return (
    <div data-testid="skill-levels-body"><div className="grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-3">{all.map(([k, v], i) => <div key={`${k}${i}`} className={`flex justify-between border-b border-line py-1 text-[12px] ${Math.abs(v - ltp) / ltp < 0.005 ? 'bg-accent/10' : ''}`}><span className="text-muted">{k}</span><span className={`num ${v > ltp ? 'text-down' : 'text-up'}`}>{f2(v)}</span></div>)}</div>
      <Note>Floor pivots from the last completed session, 20-day extremes, and swing bands tested ≥ 2×. Red = above LTP ₹{f2(ltp)} (resistance), green = below (support). Highlight = within 0.5 % of price.</Note></div>
  );
}

/* 05 / 06 · Entry & Exit ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const SideToggle = ({ side, setSide }: { side: Side; setSide: (s: Side) => void }) => <div className="mb-2 inline-flex rounded-md border border-line p-0.5" role="group" aria-label="Trade side">{(['long', 'short'] as const).map((s) => <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} data-testid={`side-${s}`} className={`rounded px-3 py-1 text-[11px] font-semibold uppercase ${side === s ? (s === 'long' ? 'bg-up/20 text-up' : 'bg-down/20 text-down') : 'text-muted'}`}>{s}</button>)}</div>;
function EntryTab({ plan, side, setSide }: { plan: TradePlan; side: Side; setSide: (s: Side) => void }) {
  return (
    <div data-testid="skill-entry-body"><SideToggle side={side} setSide={setSide} />
      <div className="mb-2 grid grid-cols-3 gap-2 text-[12px]">{[['Reference entry', plan.entry], [`Trigger (${side === 'long' ? 'above' : 'below'})`, plan.trigger], ['ATR(14)', plan.atr]].map(([k, v]) => <div key={k as string} className="rounded border border-line bg-bg px-2 py-1.5"><div className="text-[10px] uppercase text-muted">{k}</div><div className="num font-bold text-ink">₹{f2(v as number)}</div></div>)}</div>
      <ul className="space-y-1">{plan.checks.map((c, i) => <Check key={i} {...c} />)}</ul>
      <Note>Trigger = break of the last bar’s {side === 'long' ? 'high' : 'low'} (or a level within ½ ATR). Checks describe the setup; a ✕ is a reason to wait, not a rule.</Note></div>
  );
}
function ExitTab({ plan, side, setSide }: { plan: TradePlan; side: Side; setSide: (s: Side) => void }) {
  return (
    <div data-testid="skill-exit-body"><SideToggle side={side} setSide={setSide} />
      <div className="mb-2 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4"><div className="rounded border border-down/40 bg-down/10 px-2 py-1.5"><div className="text-[10px] uppercase text-muted">Stop</div><div className="num font-bold text-down" data-testid="exit-stop">₹{f2(plan.stop)}</div><div className="num text-[10px] text-muted">1R = ₹{f2(plan.riskPerShare)}</div></div>{plan.targets.map((t) => <div key={t.r} className="rounded border border-up/40 bg-up/10 px-2 py-1.5"><div className="text-[10px] uppercase text-muted">Target {t.r}R</div><div className="num font-bold text-up">₹{f2(t.px)}</div></div>)}</div>
      <p className="text-[12px] text-ink">{plan.trail}</p>
      {plan.nextLevel !== null && <p className="mt-1 text-[12px] text-muted">Next level {f2(plan.nextLevel)} sits {plan.rrToLevel}R from entry — consider scaling out there.</p>}
      <Note>Stop = 1.5 × ATR(14), tightened behind the nearest level when that is closer (never under ½ ATR). Gaps can jump a stop; a stop is not a guarantee.</Note></div>
  );
}

/* 07 · Time Machine ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function TimeTab({ series }: { series: Bar[] }) {
  const rows = useMemo(() => timeMachine(series), [series]);
  if (!rows.length) return <p className="py-3 text-center text-[12px] text-muted" data-testid="tm-none">No directional pattern fired in this stock’s last year of history, so there is nothing to replay.</p>;
  return (
    <div data-testid="skill-time-body"><table className="w-full text-left text-[12px]"><thead className="text-[10px] uppercase tracking-wide text-muted"><tr><th className="py-1 pr-2">Pattern</th><th className="pr-2">Times</th><th className="pr-2">+1d</th><th className="pr-2">+3d</th><th className="pr-2">+5d</th><th>5d hit rate</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id} className="border-t border-line"><td className="py-1 pr-2 font-semibold text-ink">{r.name}</td><td className="num pr-2">{r.n}</td>{[r.h1, r.h3, r.h5].map((x, i) => <td key={i} className={`num pr-2 ${tone(x)}`}>{sgn(x)}</td>)}<td className="num">{r.hit5 === null ? 'N/A' : `${r.hit5.toFixed(0)}%`}</td></tr>)}</tbody></table>
      <Note>Walk-forward replay: each past day is scanned using only the bars up to that day, then the next 1 / 3 / 5 closes are measured (bearish patterns count a fall as positive). One stock, one year, usually a handful of occurrences — treat as anecdote, not edge.</Note></div>
  );
}

/* 08 · Budget ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function BudgetTab({ budget, setBudget, state }: { budget: BudgetCfg; setBudget: (b: BudgetCfg) => void; state: ReturnType<typeof dailyBudget> }) {
  const set = (k: keyof BudgetCfg, v: string) => setBudget(cleanBudget({ ...budget, [k]: Number(v) }));
  const fields: [keyof BudgetCfg, string, string][] = [['capital', 'Trading capital ₹', '1000'], ['dailyLossPct', 'Max daily loss %', '0.1'], ['riskPct', 'Risk per trade %', '0.05'], ['maxTrades', 'Max trades / day', '1']];
  return (
    <div data-testid="skill-budget-body" data-status={state.status}>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{fields.map(([k, l, step]) => <label key={k} className="text-[10px] uppercase text-muted">{l}<input type="number" step={step} min={0} value={budget[k]} onChange={(e) => set(k, e.target.value)} data-testid={`budget-${k}`} className={`${inp} mt-1`} /></label>)}</div>
      <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">{[['Daily loss cap', `₹${f2(state.maxLoss, 0)}`], ['Lost today', `₹${f2(state.lostToday, 0)}`], ['Left today', `₹${f2(state.remaining, 0)}`], ['Trades left', `${state.tradesLeft} of ${budget.maxTrades}`]].map(([k, v]) => <div key={k} className="rounded border border-line bg-bg px-2 py-1.5"><div className="text-[10px] uppercase text-muted">{k}</div><div className="num font-bold text-ink">{v}</div></div>)}</div>
      <p role="status" data-testid="budget-msg" className={`mt-2 rounded border px-3 py-1.5 text-[12px] font-semibold ${state.status === 'halt' ? BIAS.bearish : state.status === 'warn' ? 'border-warn/40 bg-warn/10 text-warn' : BIAS.bullish}`}>{state.message}</p>
      <Note>Per-trade risk ₹{f2(state.perTrade, 0)}. “Today” = your journal entries dated today (IST). Saved in this browser only.</Note></div>
  );
}

/* 09 · Risk ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function RiskTab({ plan, budget, state, quote, side, setSide }: { plan: TradePlan; budget: BudgetCfg; state: ReturnType<typeof dailyBudget>; quote: Quote; side: Side; setSide: (s: Side) => void }) {
  const r = riskChecklist({ plan, budget, state, lowerCircuit: quote.lowerCircuit, upperCircuit: quote.upperCircuit });
  return (
    <div data-testid="skill-risk-body" data-verdict={r.verdict}><SideToggle side={side} setSide={setSide} />
      <div className="mb-2 flex items-center gap-2"><span className={`rounded border px-2 py-0.5 text-[11px] font-bold uppercase ${r.verdict === 'go' ? BIAS.bullish : r.verdict === 'stop' ? BIAS.bearish : 'border-warn/40 bg-warn/10 text-warn'}`}>{r.verdict === 'go' ? 'Checks pass' : r.verdict === 'stop' ? 'Stand aside' : 'Caution'}</span>{r.qty !== null && <span className="num text-[12px] text-muted">size {r.qty} sh @ ₹{f2(plan.entry)} · stop ₹{f2(plan.stop)}</span>}</div>
      <ul className="space-y-1">{r.checks.map((c, i) => <Check key={i} {...c} />)}</ul>
      <Note>Uses the Entry/Exit plan, your Budget tab numbers and today’s circuit limits{quote.bandKnown ? '' : ' (band inferred, not from the exchange)'}. A pre-trade checklist, not a signal.</Note></div>
  );
}

/* 10 · Journal ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function JournalTab({ symbol, trades, setTrades, plan }: { symbol: string; trades: Trade[]; setTrades: (t: Trade[]) => void; plan: TradePlan | null }) {
  const [f, setF] = useState({ date: istToday(), symbol, side: 'long' as Side, entry: '', exit: '', qty: '', stop: '', note: '' });
  const [msg, setMsg] = useState(''); const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setF((x) => ({ ...x, symbol })); }, [symbol]);
  const st = journalStats(trades);
  const add = () => { const t = makeTrade({ date: f.date, symbol: f.symbol, side: f.side, entry: Number(f.entry), exit: Number(f.exit), qty: Number(f.qty), stop: f.stop ? Number(f.stop) : undefined, note: f.note }); if ('error' in t) return setMsg(t.error); if (trades.length >= MAX_TRADES) return setMsg(`Journal is full (${MAX_TRADES}).`); setTrades([t, ...trades]); setMsg(`Logged ${t.symbol} ${t.pnl >= 0 ? '+' : ''}₹${t.pnl}`); setF({ ...f, entry: '', exit: '', qty: '', stop: '', note: '' }); };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div data-testid="skill-journal-body">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[['date', 'Date', 'date'], ['symbol', 'Symbol', 'text'], ['entry', 'Entry ₹', 'number'], ['exit', 'Exit ₹', 'number'], ['qty', 'Qty', 'number'], ['stop', 'Stop ₹ (optional)', 'number']].map(([k, l, ty]) => <label key={k} className="text-[10px] uppercase text-muted">{l}<input type={ty} value={f[k as keyof typeof f]} onChange={set(k)} data-testid={`j-${k}`} className={`${inp} mt-1`} /></label>)}
        <label className="text-[10px] uppercase text-muted">Side<select value={f.side} onChange={set('side')} data-testid="j-side" className={`${inp} mt-1`}><option value="long">Long</option><option value="short">Short</option></select></label>
        <label className="col-span-2 text-[10px] uppercase text-muted sm:col-span-1">Note<input value={f.note} maxLength={200} onChange={set('note')} data-testid="j-note" className={`${inp} mt-1`} /></label></div>
      <div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" onClick={add} data-testid="j-add" className={btn}>Log trade</button>{plan && <button type="button" className={btn} onClick={() => setF({ ...f, side: plan.side, entry: String(plan.entry), stop: String(plan.stop) })}>Fill from plan</button>}<span role="status" data-testid="j-msg" className="text-[11px] text-muted">{msg}</span></div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[12px] sm:grid-cols-6" data-testid="j-stats">{[['Trades', String(st.n)], ['Win rate', st.winRate === null ? 'N/A' : `${st.winRate.toFixed(0)}%`], ['Expectancy', st.expectancy === null ? 'N/A' : `₹${st.expectancy}`], ['Profit factor', st.profitFactor === null ? 'N/A' : String(st.profitFactor)], ['Avg R', st.avgR === null ? 'N/A' : st.avgR.toFixed(2)], ['Net P&L', `₹${st.total}`]].map(([k, v]) => <div key={k} className="rounded border border-line bg-bg px-2 py-1.5"><div className="text-[10px] uppercase text-muted">{k}</div><div className="num font-bold text-ink">{v}</div></div>)}</div>
      {trades.length > 0 && <div className="mt-2 max-h-48 overflow-y-auto"><table className="w-full text-left text-[12px]"><tbody>{trades.slice(0, 30).map((t) => <tr key={t.id} className="border-t border-line" data-testid="j-row"><td className="py-1 pr-2 text-muted">{t.date}</td><td className="pr-2 font-semibold text-ink">{t.symbol}</td><td className="pr-2 uppercase text-muted">{t.side}</td><td className={`num pr-2 ${tone(t.pnl)}`}>₹{t.pnl}</td><td className="num pr-2 text-muted">{t.r === null ? '' : `${t.r}R`}</td><td className="truncate text-muted">{t.note}</td><td><button type="button" aria-label={`Delete ${t.symbol} trade of ${t.date}`} onClick={() => setTrades(trades.filter((x) => x.id !== t.id))} className="px-1 text-muted hover:text-down">✕</button></td></tr>)}</tbody></table></div>}
      <Note>Saved in this browser only (up to {MAX_TRADES} trades). Enter trades you actually took — UpCircuit does not connect to a broker.</Note></div>
  );
}

/* 11 · Alerts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
function AlertsTab({ symbol, lv, plan, ltp, onAddAlert }: { symbol: string; lv: NonNullable<ReturnType<typeof levels>>; plan: TradePlan | null; ltp: number; onAddAlert: Props['onAddAlert'] }) {
  const [msg, setMsg] = useState(''); const sug = alertSuggestions(lv, plan, ltp);
  return (
    <div data-testid="skill-alerts-body"><p className="mb-2 text-[12px] text-muted">One tap sets a price alert at a level (it fires while UpCircuit is open; existing alerts are listed in the terminal).</p>
      <div className="flex flex-wrap gap-1.5">{sug.map((s) => <button key={`${s.label}${s.px}`} type="button" disabled={!onAddAlert || !(ltp > 0)} data-testid="alert-sug" onClick={() => { const r = onAddAlert?.(symbol, s.px, ltp); setMsg(!r ? 'Alerts unavailable.' : r.ok ? `Alert set: ${symbol} at ₹${f2(s.px)} (${s.label})` : r.error); }} className={`${btn} ${s.px > ltp ? 'text-down' : 'text-up'}`}>{s.label} <span className="num ml-1">₹{f2(s.px)}</span></button>)}</div>
      <p role="status" data-testid="alert-msg" className="mt-2 min-h-[1rem] text-[12px] text-ink">{msg}</p></div>
  );
}
