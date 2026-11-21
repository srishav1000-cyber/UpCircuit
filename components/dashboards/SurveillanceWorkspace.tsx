'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Flame, ShieldAlert, Waves } from 'lucide-react';
import type { CloudClient, AlertRuleRow, DepthFlagRow, VolumeBaselineRow } from '@/lib/cloud';
import type { MarketEngine } from '@/lib/market';
import { circuitWatchlist, NEAR_PCT } from '@/lib/analytics/proximity';
import { volumeMultipleAt, expectedVolume, VolumeWindow, bucketLabel, bucketIndex, istMinuteOf, BUCKETS, MIN_BASELINE_SESSIONS, type IntradayProfile } from '@/lib/volumeBaseline';
import { DepthFlagTracker, FLAG_DISCLAIMER, FLAG_LABEL, flagTag, confirmationFromHits, type DepthFlag } from '@/lib/heuristicFlags';
import { FeedHealthStatus, type FeedHealthStatusProps } from './FeedHealthStatus';
import { OrderImbalanceGauge } from './OrderImbalanceGauge';
import { AlertDeliveryLog } from './AlertDeliveryLog';
import { SlippageCard } from './SlippageCard';
import { ThresholdExplorer, type ExplorerData } from './ThresholdExplorer';
import { AuditExport } from './AuditExport';
import { DeskSymbolSwitcher } from './DeskSymbolSwitcher';
import { SignalAttributionCard } from './SignalAttributionCard';
import { DefenseGuideDrawer } from '../DefenseGuideDrawer';
import type { Instrument } from '@/lib/types';
import { EodDigestCard } from './EodDigestCard';
import { RuleSandbox } from './RuleSandbox';
import { topFiveImbalance, obiValue } from '@/lib/depthImbalance';
import { isMarketOpen } from '@/lib/market';
import { istDate } from '@/lib/auditDossier';
import type { DigestInput, EodDigest } from '@/lib/eodDigest';
import type { CircuitEvent } from '@/lib/cloud';

// Dark slate canvas with gold (attention) and teal (healthy / live) accents; everything else uses the theme tokens.
const GOLD = '#d4a64a';
const TEAL = '#2dd4bf';
const SLATE = 'linear-gradient(180deg, rgb(15 20 30 / 0.92), rgb(11 14 22 / 0.96))';
const pane = 'rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm';

const fmtN = (n: number) => n.toLocaleString('en-IN');
const fmtMult = (m: number) => `${m >= 10 ? m.toFixed(1) : m.toFixed(2)}×`;
const ist = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

type LiveFlag = DepthFlag & { source: 'browser' | 'daemon' };

function PaneHead({ icon, title, right, testid }: { icon: React.ReactNode; title: string; right?: React.ReactNode; testid?: string }) {
  return (
    <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2" data-testid={testid}>
      <span style={{ color: GOLD }} aria-hidden>{icon}</span>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
      <div className="ml-auto text-[11px] text-muted">{right}</div>
    </header>
  );
}

interface BacktestFile extends ExplorerData {
  config?: Record<string, unknown>;
  data?: { snapshots: number; symbols: number; labelled: boolean; episodes: Record<string, number> };
  flags?: { total: number; per1000Snapshots: number; byKind: Record<string, number> };
  precision?: number | null;
  recall?: Record<string, { episodes: number; detected: number; rate: number | null; medianDelayMs: number | null }> | null;
}
const pctTxt = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? 'N/A' : `${(x * 100).toFixed(d)}%`);
/** high-contrast text for the dark glass panes (values / labels) */
const HI = '#f8fafc', LO = '#cbd5e1';
const fmtUS = (n: number) => n.toLocaleString('en-US');

/** Compact status card: the intraday volume curve the volume_surge rule compares against, plus the offline heuristic-flag backtest and this session's flag tally. */
function BacktestCurveCard({ symbol, profile, volume, sessionFlags }: { symbol: string; profile: IntradayProfile | null; volume: number | null; sessionFlags: { wall: number; add_cancel: number } }) {
  const [bt, setBt] = useState<BacktestFile | null | 'none'>(null);
  useEffect(() => {
    let on = true;
    fetch('/backtest-heuristics.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((j) => on && setBt(j as BacktestFile)).catch(() => on && setBt('none'));
    return () => { on = false; };
  }, []);
  const W = 220, H = 64, PAD = 4;
  const cum = profile?.cum.length === BUCKETS ? profile.cum : null;
  const top = cum ? cum[BUCKETS - 1] : 0;
  const x = (k: number) => PAD + (k / (BUCKETS - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / (top || 1)) * (H - 2 * PAD);
  const nowK = bucketIndex(istMinuteOf(Date.now()));
  const exp = cum ? expectedVolume(profile, null, Date.now()) : null;
  const synth = bt && bt !== 'none' && bt.config && (bt.config as { source?: string }).source === 'synthetic';
  return (
    <section className={pane} data-testid="desk-backtest" aria-label="Session backtest and intraday curve">
      <PaneHead icon={<Activity size={14} />} title="Session backtest, threshold explorer & intraday curve" right={symbol} />
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <div data-testid="desk-curve">
          <div className="mb-1 text-[11px] font-semibold text-muted">Typical cumulative volume, 09:15 → 15:30 IST</div>
          {!cum ? (
            <p data-testid="desk-curve-na" className="py-4 text-[12px] text-muted">N/A — no intraday profile for {symbol} yet (needs ≥ {MIN_BASELINE_SESSIONS} sessions of 15-minute history and a volume-surge rule so the daemon computes it). Volume rules use the typical full day meanwhile.</p>
          ) : (
            <>
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Median cumulative volume by 15-minute bucket for ${symbol}`}>
                <polyline fill="none" stroke={TEAL} strokeWidth="2" points={cum.map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
                {nowK !== null && exp ? <circle cx={x(nowK)} cy={y(exp.expected)} r="3.5" fill={GOLD} /> : null}
                {volume !== null && nowK !== null ? <circle cx={x(nowK)} cy={Math.max(PAD, y(Math.min(volume, top * 1.2)))} r="3" fill="none" stroke={GOLD} strokeWidth="1.5" /> : null}
              </svg>
              <div className="num flex justify-between text-[10px] text-muted"><span>09:15</span><span>12:20</span><span>15:30</span></div>
              <div className="num text-[11px] text-muted" data-testid="desk-curve-readout">
                {exp && nowK !== null ? <>expected by now {fmtN(Math.round(exp.expected))} ({((exp.expected / top) * 100).toFixed(0)}% of the day)</> : 'market closed — curve shows the typical session'} · {profile!.sessions} sessions
              </div>
            </>
          )}
        </div>
        <div data-testid="desk-bt">
          <div className="mb-1 text-[11px] font-semibold text-muted">Heuristic flag backtest</div>
          {bt === null ? <p className="py-4 text-[12px] text-muted">Loading…</p>
            : bt === 'none' || !bt.data ? <p data-testid="desk-bt-na" className="py-3 text-[12px] text-muted">N/A — no backtest result published. Run <code className="text-ink">npx tsx scripts/backtest-heuristics.ts --out public/backtest-heuristics.json</code>.</p>
            : (
              <ul className="space-y-1 text-[12px]" data-testid="desk-bt-rows">
                <li className="flex justify-between gap-3"><span style={{ color: LO }}>Data</span><span className="num font-semibold" style={{ color: HI }} data-testid="desk-bt-data">{fmtUS(bt.data.snapshots)} snapshots · {bt.data.symbols} symbols{synth ? ' · synthetic' : ''}</span></li>
                <li className="flex justify-between gap-3"><span style={{ color: LO }}>Precision</span><b className="num" data-testid="desk-bt-precision" style={{ color: GOLD }}>{pctTxt(bt.precision)}</b></li>
                <li className="flex justify-between gap-3"><span style={{ color: LO }}>Recall · spoof_wall</span><b className="num" style={{ color: HI }} data-testid="desk-bt-recall-wall">{pctTxt(bt.recall?.spoof_wall?.rate)}</b></li>
                <li className="flex justify-between gap-3"><span style={{ color: LO }}>Recall · flicker</span><b className="num" style={{ color: HI }} data-testid="desk-bt-recall-flicker">{pctTxt(bt.recall?.flicker?.rate)}</b></li>
                <li className="flex justify-between gap-3"><span style={{ color: LO }}>Flags per 1 000 snapshots</span><span className="num font-semibold" style={{ color: HI }}>{bt.flags?.per1000Snapshots ?? 'N/A'}</span></li>
              </ul>
            )}
          <div className="num mt-2 text-[11px]" style={{ color: LO }} data-testid="desk-session-flags">Recent flags: wall {sessionFlags.wall} · add/cancel {sessionFlags.add_cancel}</div>
          {synth && <p className="mt-1 text-[10px] leading-snug" style={{ color: LO }} data-testid="desk-bt-caveat">Synthetic data: precision depends on the assumed book noise and describes agreement with the generator’s own pattern definition — not how often real markets are manipulated.</p>}
        </div>
      </div>
      {bt && bt !== 'none' && bt.data ? <div className="space-y-3 px-3 pb-3"><SignalAttributionCard data={bt} /><ThresholdExplorer data={bt} /></div> : null}
    </section>
  );
}

/** Consolidated surveillance desk: feed health · circuit proximity · volume-surge rules · top-5 depth imbalance + heuristic flags · live delivery log. */
export interface SurveillanceWorkspaceProps {
  engine: MarketEngine;
  /** the stock whose depth is shown (the terminal's selected symbol) */
  symbol: string;
  /** engine version — re-render trigger from the page */
  version?: number;
  feed: Omit<FeedHealthStatusProps, 'cloud' | 'variant' | 'className'>;
  cloud: CloudClient | null;
  onOpenStock: (symbol: string) => void;
  /** searchable universe + a handler that only changes the active symbol (no research modal) — together they enable the inline switcher */
  instruments?: Instrument[];
  onSwitchSymbol?: (symbol: string) => void;
  className?: string;
}

export function SurveillanceWorkspace({ engine, symbol, feed, cloud, onOpenStock, instruments, onSwitchSymbol, className = '' }: SurveillanceWorkspaceProps) {
  const [rules, setRules] = useState<AlertRuleRow[]>([]);
  const [baselines, setBaselines] = useState<Record<string, VolumeBaselineRow>>({});
  const [stored, setStored] = useState<DepthFlagRow[]>([]);
  const [live, setLive] = useState<LiveFlag[]>([]);
  const [, force] = useState(0);
  const tracker = useRef(new DepthFlagTracker({ evaluate: true }));    // attaches the multi-signal confirmation to every flag so each row can be tagged
  const volWin = useRef(new VolumeWindow());
  const profileRef = useRef<IntradayProfile | null>(null);
  const symRef = useRef(symbol);
  /* the day's observations for the digest: peak R(t) / OBI of the selected stock and first circuit touches seen in this browser session, plus today's register rows */
  const peaks = useRef({ surge: new Map<string, { symbol: string; rt: number; at: number }>(), obi: new Map<string, { symbol: string; value: number; at: number }>(), touch: new Map<string, DigestInput['circuit'][number]>(), samples: 0 });
  const [register, setRegister] = useState<CircuitEvent[]>([]);
  const [digestShown, setDigestShown] = useState<EodDigest | null>(null);

  /* the selected stock's intraday profile feeds R(t) for the multi-signal confirmation */
  useEffect(() => {
    const b = baselines[symbol.toUpperCase()];
    profileRef.current = b?.status === 'ok' && b.profile && b.profile.cum.length === BUCKETS ? { cum: b.profile.cum, sessions: b.profile.sessions, status: 'ok' } : null;
  }, [baselines, symbol]);

  /* user's rules + their baselines (refreshed every 30 s) */
  useEffect(() => {
    if (!cloud) return;
    let on = true;
    const load = async () => {
      try {
        const r = await cloud.listRules();
        if (!on) return;
        setRules(r);
        const syms = [...r.filter((x) => x.kind === 'volume_surge').map((x) => x.symbol), symbol];
        const b = await cloud.listBaselines(syms);
        if (on) setBaselines(Object.fromEntries(b.map((x) => [x.symbol.toUpperCase(), x])));
      } catch { /* the panels show their own empty states */ }
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => { on = false; clearInterval(t); };
  }, [cloud, symbol]);

  /* daemon-recorded heuristic flags (refreshed every 15 s) */
  useEffect(() => {
    if (!cloud) return;
    let on = true;
    const load = () => cloud.listDepthFlags(30).then((r) => { if (on) setStored(r); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 15_000);
    return () => { on = false; clearInterval(t); };
  }, [cloud]);

  /* today's circuit register rows (refreshed every minute) */
  useEffect(() => {
    if (!cloud) return;
    let on = true;
    const load = () => cloud.listRegister(100).then((r) => { if (on) setRegister(r); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => { on = false; clearInterval(t); };
  }, [cloud]);

  /* browser-side detection on the selected stock's live depth, sampled twice a second (the daemon sees every tick; this view sees a sample) */
  useEffect(() => {
    if (symRef.current !== symbol) { tracker.current.reset(); volWin.current.clear(); symRef.current = symbol; setLive([]); }
    const t = setInterval(() => {
      force((n) => (n + 1) % 1_000_000);
      const q = engine.quotes.get(symbol);
      if (isMarketOpen(Date.now())) {                                  // circuit touches across every quote the terminal holds (first touch of the day kept)
        for (const x of engine.quotes.values()) {
          const dir = x.upperCircuit > 0 && x.ltp >= x.upperCircuit ? 'UPPER' : x.lowerCircuit > 0 && x.ltp > 0 && x.ltp <= x.lowerCircuit ? 'LOWER' : null;
          if (dir && !peaks.current.touch.has(`${x.symbol}|${dir}`)) peaks.current.touch.set(`${x.symbol}|${dir}`, { symbol: x.symbol, direction: dir, price: x.ltp, at: Date.now(), source: 'session' });
        }
      }
      if (!engine.depthReal || !q || !(q.ltp > 0)) return;
      const nowMs = Date.now();
      if (q.volume > 0) volWin.current.push(symbol, nowMs, q.volume);
      const rt = q.volume > 0 ? volWin.current.ratio(symbol, profileRef.current, nowMs, q.volume) : null;
      const imb = topFiveImbalance(engine.depth.bids, engine.depth.asks);
      peaks.current.samples++;
      if (rt !== null && rt > (peaks.current.surge.get(symbol)?.rt ?? -1)) peaks.current.surge.set(symbol, { symbol, rt, at: nowMs });
      if (imb) { const v = obiValue(imb, 'weighted'); if (Math.abs(v) > Math.abs(peaks.current.obi.get(symbol)?.value ?? -1)) peaks.current.obi.set(symbol, { symbol, value: v, at: nowMs }); }
      const fresh = tracker.current.observe(symbol, engine.depth, q.ltp, nowMs, { volRatio: rt });
      if (fresh.length) setLive((cur) => [...fresh.map((f) => ({ ...f, source: 'browser' as const })), ...cur].slice(0, 20));
    }, 500);
    return () => clearInterval(t);
  }, [engine, symbol]);

  /* ───── derived ───── */
  const near = circuitWatchlist(engine.quotes.values(), NEAR_PCT, 8);
  const volRules = useMemo(() => rules.filter((r) => r.kind === 'volume_surge' && r.enabled), [rules]);
  const imbRules = useMemo(() => rules.filter((r) => r.symbol === symbol && r.enabled), [rules, symbol]);
  const thresholds = useMemo(() => ({
    above: imbRules.find((r) => r.kind === 'order_imbalance_above')?.threshold,
    below: imbRules.find((r) => r.kind === 'order_imbalance_below')?.threshold,
  }), [imbRules]);
  const depth = engine.depth;

  const flags: LiveFlag[] = useMemo(() => {
    const seen = new Set<string>();
    const rows: LiveFlag[] = [
      ...live,
      ...stored.map((r): LiveFlag => ({ key: `${r.symbol}|${r.kind}|${r.side}`, symbol: r.symbol, kind: r.kind, side: r.side, severity: r.severity, price: r.price, qty: r.qty, detail: r.detail, ts: Date.parse(r.flagged_at), label: FLAG_LABEL, heuristic: true, definitive: false, confirmation: confirmationFromHits(r.confirmed_by), source: 'daemon' })),
    ].sort((a, b) => b.ts - a.ts);
    return rows.filter((f) => { const k = `${f.key}|${Math.floor(f.ts / 60_000)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
  }, [live, stored]);

  const digestInput: DigestInput | null = (() => {
    const today = istDate(Date.now()), pk = peaks.current;
    const fl = flags.filter((f) => istDate(f.ts) === today).map((f) => ({ symbol: f.symbol, kind: f.kind, side: f.side, at: f.ts, confirmed: !!f.confirmation?.confirmed, hits: f.confirmation?.hits ?? [], obi: f.confirmation?.obi ?? null, volRatio: f.confirmation?.volRatio ?? null, origin: f.source }));
    const reg = register.filter((c) => c.trade_date === today).map((c) => ({ symbol: c.symbol, direction: c.direction, price: c.price, at: Date.parse(c.detected_at), source: c.source }));
    const circuit = [...reg, ...pk.touch.values()];
    if (!fl.length && !pk.surge.size && !pk.obi.size && !circuit.length) return null;
    return { date: today, source: 'live', flags: fl, surges: [...pk.surge.values()], obi: [...pk.obi.values()], circuit, ticks: pk.samples };
  })();

  const onSel = useCallback((s: string) => onOpenStock(s), [onOpenStock]);

  return (
    <div data-testid="surveillance-desk" className={`rounded-2xl border border-white/10 p-3 sm:p-4 ${className}`} style={{ background: SLATE }}>
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-[15px] font-bold text-ink"><span style={{ color: GOLD }}>◆</span> Surveillance desk</h2>
          <p className="text-[12px] text-muted">Feed health, circuit proximity, volume surges, order-book imbalance and alert delivery in one view.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {instruments && onSwitchSymbol && <DeskSymbolSwitcher instruments={instruments} symbol={symbol} onSwitch={onSwitchSymbol} />}
          <FeedHealthStatus {...feed} cloud={cloud} variant="pill" />
        </div>
      </header>

      <DefenseGuideDrawer className="mb-3" />
      <div id="desk-sec-daemon"><FeedHealthStatus {...feed} cloud={cloud} variant="panel" className="mb-3" /></div>
      <AuditExport engine={engine} symbol={symbol} feed={feed} cloud={cloud} digest={digestShown} flags={flags} profile={profileRef.current} surge15={volWin.current.ratio(symbol, profileRef.current, Date.now(), engine.quotes.get(symbol)?.volume ?? 0)} className="mb-3" />

      <RuleSandbox className="mb-3" symbol={symbol} />

      <div className="grid gap-3 lg:grid-cols-2">
        {/* circuit proximity */}
        <section className={pane} data-testid="desk-circuit" aria-label="Circuit proximity">
          <PaneHead icon={<ShieldAlert size={14} />} title="Circuit proximity" right={`within ${NEAR_PCT}% of a limit`} />
          <div className="p-3">
            {!near.length ? (
              <p data-testid="desk-circuit-empty" className="py-3 text-center text-[12px] text-muted">No stock in the loaded universe is within {NEAR_PCT}% of a circuit limit right now.</p>
            ) : (
              <ul className="divide-y divide-white/5">
                {near.map((p) => (
                  <li key={p.symbol} data-testid="desk-circuit-row" className="flex items-center gap-3 py-1.5 text-[12px]">
                    <button type="button" onClick={() => onSel(p.symbol)} className="w-24 truncate text-left font-bold text-ink hover:underline">{p.symbol}</button>
                    <span className={p.dir === 'upper' ? 'text-up' : 'text-down'}>{p.dir === 'upper' ? '▲ upper' : '▼ lower'} {p.band}%</span>
                    {p.inferred && <span className="rounded border border-white/15 px-1 text-[10px] text-muted" title="The exchange band was not supplied; this is the next 5 / 10 / 20 % band, a heads-up rather than a halt forecast">inferred band</span>}
                    <span className="num ml-auto text-muted">LTP {p.ltp.toFixed(2)} · limit {p.limit.toFixed(2)}</span>
                    <span className="num w-14 text-right font-semibold" style={{ color: p.proximityPct <= 0.5 ? GOLD : undefined }}>{p.proximityPct.toFixed(2)}%</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted">Circuit-proximity alert rules are time-critical: they bypass Quiet Hours.</p>
          </div>
        </section>

        {/* volume surge */}
        <section className={pane} data-testid="desk-volume" aria-label="Volume surge rules">
          <PaneHead icon={<Flame size={14} />} title="Volume surge" right="× typical volume by this time of day" />
          <div className="p-3">
            {!cloud ? (
              <p className="py-3 text-center text-[12px] text-muted">Sign in with a Supabase account to see your volume-surge rules.</p>
            ) : !volRules.length ? (
              <p data-testid="desk-volume-empty" className="py-3 text-center text-[12px] text-muted">No volume-surge rule yet. Add one under Alert rules → “Volume surge”.</p>
            ) : (
              <ul className="divide-y divide-white/5">
                {volRules.map((r) => {
                  const b = baselines[r.symbol.toUpperCase()];
                  const q = engine.quotes.get(r.symbol);
                  const base = b?.status === 'ok' ? b.median_volume : null;
                  const prof: IntradayProfile | null = b?.profile && b.profile.cum.length === BUCKETS ? { cum: b.profile.cum, sessions: b.profile.sessions, status: 'ok' } : null;
                  const vm = q ? volumeMultipleAt(q.volume, prof, base, Date.now()) : null;
                  const m = vm ? vm.multiple : null;
                  const na = vm === null;
                  const hit = !na && m !== null && m >= r.threshold;
                  const why = !b ? 'baseline not computed yet' : b.status === 'insufficient' ? `only ${b.sessions} of ${MIN_BASELINE_SESSIONS} sessions of history` : b.status === 'unavailable' ? 'history unavailable' : !q ? 'no live quote' : '';
                  return (
                    <li key={r.id} data-testid="desk-volume-row" data-state={na ? 'na' : hit ? 'surge' : 'normal'} className="py-1.5 text-[12px]">
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => onSel(r.symbol)} className="w-24 truncate text-left font-bold text-ink hover:underline">{r.symbol}</button>
                        <span className="text-muted">alert at {fmtMult(r.threshold)}</span>
                        <span className="num ml-auto font-semibold" style={{ color: na ? undefined : hit ? GOLD : TEAL }} data-testid="desk-volume-mult">{na ? 'N/A' : fmtMult(m as number)}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/10" aria-hidden>
                        <div className="h-full rounded" style={{ width: `${na ? 0 : Math.min(100, ((m as number) / r.threshold) * 100)}%`, background: hit ? GOLD : TEAL }} />
                      </div>
                      <div className="num mt-0.5 text-[11px] text-muted">{na ? `N/A — ${why}` : `today ${fmtN(q!.volume)} · ${vm!.basis === 'time-of-day' ? `typical by ${bucketLabel(vm!.bucket as number)}+ ${fmtN(Math.round(vm!.expected))}` : `typical full day ${fmtN(Math.round(vm!.expected))} (no intraday profile)`} (${b!.sessions} sessions)${hit ? ' · above your multiple' : ''}`}</div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted" data-testid="desk-volume-note">Compared with the median volume the stock traded by the same 15-minute mark over its last ≤ 20 sessions; when that intraday history is missing it falls back to the typical full day.</p>
          </div>
        </section>

        {/* depth imbalance + heuristic flags */}
        <div className="grid gap-3" data-testid="desk-depth">
          <OrderImbalanceGauge bids={depth.bids} asks={depth.asks} symbol={symbol} live={engine.depthReal} thresholds={thresholds} />
          <SlippageCard engine={engine} symbol={symbol} />
        </div>

        <section id="desk-sec-obi" className={pane} data-testid="desk-flags" aria-label="Heuristic depth flags">
          <PaneHead icon={<Waves size={14} />} title="Depth flags" right={<span data-testid="desk-flags-tag" className="rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase" style={{ borderColor: GOLD, color: GOLD }}>Heuristic</span>} />
          <div className="p-3">
            {!flags.length ? (
              <p data-testid="desk-flags-empty" className="py-3 text-center text-[12px] text-muted">
                {engine.depthReal || stored.length ? 'No wall or rapid add/cancel pattern flagged recently.' : 'N/A — order-book depth is streamed by SmartAPI only while the market is live.'}
              </p>
            ) : (
              <ul className="space-y-2">
                {flags.map((f, i) => (
                  <li key={`${f.key}-${f.ts}-${i}`} data-testid="desk-flag" data-kind={f.kind} data-severity={f.severity} data-source={f.source} className="rounded-lg border border-white/10 bg-white/[0.02] p-2 text-[12px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={() => onSel(f.symbol)} className="font-bold text-ink hover:underline">{f.symbol}</button>
                      <span className="text-muted">{f.kind === 'wall' ? 'Resting-order wall' : 'Rapid add / cancel'} · {f.side}</span>
                      <span data-testid="desk-flag-tag" data-tag={f.confirmation?.confirmed ? 'confirmed' : 'baseline'} title={f.confirmation?.confirmed ? `Corroborated by ${f.confirmation.hits.join(' + ')}` : 'Single-rule pattern; not corroborated by a second signal'} className="rounded border px-1.5 text-[10px] font-bold uppercase" style={f.confirmation?.confirmed ? { borderColor: TEAL, color: TEAL } : { borderColor: 'rgb(255 255 255 / 0.25)', color: LO }}>{flagTag(f)}{f.confirmation?.confirmed ? ` · ${f.confirmation.hits.join('+')}` : ''}</span>
                      <span className="rounded px-1.5 text-[10px] font-bold uppercase" style={{ background: f.severity === 'elevated' ? `${GOLD}33` : 'rgb(255 255 255 / 0.08)', color: f.severity === 'elevated' ? GOLD : undefined }}>{f.severity}</span>
                      <span className="num ml-auto text-[11px] text-muted">{ist(f.ts)} IST · {f.source === 'daemon' ? 'daemon' : 'this browser (sampled)'}</span>
                    </div>
                    <p className="mt-1 text-muted">{f.detail}</p>
                    <p data-testid="desk-flag-label" className="mt-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: GOLD }}>{f.label}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted" data-testid="desk-flags-disclaimer">{FLAG_DISCLAIMER}</p>
          </div>
        </section>
      </div>

      <EodDigestCard className="mt-3" input={digestInput} marketOpen={isMarketOpen(Date.now())} onDigest={setDigestShown} />

      <div className="mt-3">
        <BacktestCurveCard
          symbol={symbol}
          profile={(() => { const b = baselines[symbol.toUpperCase()]; return b?.status === 'ok' && b.profile && b.profile.cum.length === BUCKETS ? { cum: b.profile.cum, sessions: b.profile.sessions, status: 'ok' as const } : null; })()}
          volume={engine.quotes.get(symbol)?.volume ?? null}
          sessionFlags={{ wall: flags.filter((f) => f.kind === 'wall').length, add_cancel: flags.filter((f) => f.kind === 'add_cancel').length }}
        />
      </div>

      {cloud && (
        <section className={`${pane} mt-3 px-3 pb-3`} data-testid="desk-deliveries" aria-label="Live alert deliveries">
          <PaneHead icon={<Activity size={14} />} title="Live alert deliveries" right="refreshes every 15 s" />
          <AlertDeliveryLog cloud={cloud} limit={20} />
        </section>
      )}
    </div>
  );
}
