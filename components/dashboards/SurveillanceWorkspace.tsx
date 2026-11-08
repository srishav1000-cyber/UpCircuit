'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Flame, ShieldAlert, Waves } from 'lucide-react';
import type { CloudClient, AlertRuleRow, DepthFlagRow, VolumeBaselineRow } from '@/lib/cloud';
import type { MarketEngine } from '@/lib/market';
import { circuitWatchlist, NEAR_PCT } from '@/lib/analytics/proximity';
import { volumeMultiple, MIN_BASELINE_SESSIONS } from '@/lib/volumeBaseline';
import { DepthFlagTracker, FLAG_DISCLAIMER, FLAG_LABEL, type DepthFlag } from '@/lib/heuristicFlags';
import { FeedHealthStatus, type FeedHealthStatusProps } from './FeedHealthStatus';
import { OrderImbalanceGauge } from './OrderImbalanceGauge';
import { AlertDeliveryLog } from './AlertDeliveryLog';

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
  className?: string;
}

export function SurveillanceWorkspace({ engine, symbol, feed, cloud, onOpenStock, className = '' }: SurveillanceWorkspaceProps) {
  const [rules, setRules] = useState<AlertRuleRow[]>([]);
  const [baselines, setBaselines] = useState<Record<string, VolumeBaselineRow>>({});
  const [stored, setStored] = useState<DepthFlagRow[]>([]);
  const [live, setLive] = useState<LiveFlag[]>([]);
  const [, force] = useState(0);
  const tracker = useRef(new DepthFlagTracker());
  const symRef = useRef(symbol);

  /* user's rules + their baselines (refreshed every 30 s) */
  useEffect(() => {
    if (!cloud) return;
    let on = true;
    const load = async () => {
      try {
        const r = await cloud.listRules();
        if (!on) return;
        setRules(r);
        const syms = r.filter((x) => x.kind === 'volume_surge').map((x) => x.symbol);
        const b = await cloud.listBaselines(syms);
        if (on) setBaselines(Object.fromEntries(b.map((x) => [x.symbol.toUpperCase(), x])));
      } catch { /* the panels show their own empty states */ }
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => { on = false; clearInterval(t); };
  }, [cloud]);

  /* daemon-recorded heuristic flags (refreshed every 15 s) */
  useEffect(() => {
    if (!cloud) return;
    let on = true;
    const load = () => cloud.listDepthFlags(30).then((r) => { if (on) setStored(r); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 15_000);
    return () => { on = false; clearInterval(t); };
  }, [cloud]);

  /* browser-side detection on the selected stock's live depth, sampled twice a second (the daemon sees every tick; this view sees a sample) */
  useEffect(() => {
    if (symRef.current !== symbol) { tracker.current.reset(); symRef.current = symbol; setLive([]); }
    const t = setInterval(() => {
      force((n) => (n + 1) % 1_000_000);
      const q = engine.quotes.get(symbol);
      if (!engine.depthReal || !q || !(q.ltp > 0)) return;
      const fresh = tracker.current.observe(symbol, engine.depth, q.ltp, Date.now());
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
      ...stored.map((r): LiveFlag => ({ key: `${r.symbol}|${r.kind}|${r.side}`, symbol: r.symbol, kind: r.kind, side: r.side, severity: r.severity, price: r.price, qty: r.qty, detail: r.detail, ts: Date.parse(r.flagged_at), label: FLAG_LABEL, heuristic: true, definitive: false, source: 'daemon' })),
    ].sort((a, b) => b.ts - a.ts);
    return rows.filter((f) => { const k = `${f.key}|${Math.floor(f.ts / 60_000)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
  }, [live, stored]);

  const onSel = useCallback((s: string) => onOpenStock(s), [onOpenStock]);

  return (
    <div data-testid="surveillance-desk" className={`rounded-2xl border border-white/10 p-3 sm:p-4 ${className}`} style={{ background: SLATE }}>
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-[15px] font-bold text-ink"><span style={{ color: GOLD }}>◆</span> Surveillance desk</h2>
          <p className="text-[12px] text-muted">Feed health, circuit proximity, volume surges, order-book imbalance and alert delivery in one view.</p>
        </div>
        <FeedHealthStatus {...feed} cloud={cloud} variant="pill" className="ml-auto" />
      </header>

      <FeedHealthStatus {...feed} cloud={cloud} variant="panel" className="mb-3" />

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
          <PaneHead icon={<Flame size={14} />} title="Volume surge" right="× typical full-day volume" />
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
                  const m = q ? volumeMultiple(q.volume, base) : null;
                  const na = base === null || m === null;
                  const hit = !na && m >= r.threshold;
                  const why = !b ? 'baseline not computed yet' : b.status === 'insufficient' ? `only ${b.sessions} of ${MIN_BASELINE_SESSIONS} sessions of history` : b.status === 'unavailable' ? 'history unavailable' : !q ? 'no live quote' : '';
                  return (
                    <li key={r.id} data-testid="desk-volume-row" data-state={na ? 'na' : hit ? 'surge' : 'normal'} className="py-1.5 text-[12px]">
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => onSel(r.symbol)} className="w-24 truncate text-left font-bold text-ink hover:underline">{r.symbol}</button>
                        <span className="text-muted">alert at {fmtMult(r.threshold)}</span>
                        <span className="num ml-auto font-semibold" style={{ color: na ? undefined : hit ? GOLD : TEAL }} data-testid="desk-volume-mult">{na ? 'N/A' : fmtMult(m)}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/10" aria-hidden>
                        <div className="h-full rounded" style={{ width: `${na ? 0 : Math.min(100, (m / r.threshold) * 100)}%`, background: hit ? GOLD : TEAL }} />
                      </div>
                      <div className="num mt-0.5 text-[11px] text-muted">{na ? `N/A — ${why}` : `today ${fmtN(q!.volume)} · typical day ${fmtN(Math.round(base))} (${b!.sessions} sessions)${hit ? ' · above your multiple' : ''}`}</div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted">Compared with a full-day baseline, not time-of-day adjusted — early in the session a low multiple is the realistic setting.</p>
          </div>
        </section>

        {/* depth imbalance + heuristic flags */}
        <div className="grid gap-3" data-testid="desk-depth">
          <OrderImbalanceGauge bids={depth.bids} asks={depth.asks} symbol={symbol} live={engine.depthReal} thresholds={thresholds} />
        </div>

        <section className={pane} data-testid="desk-flags" aria-label="Heuristic depth flags">
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

      {cloud && (
        <section className={`${pane} mt-3 px-3 pb-3`} data-testid="desk-deliveries" aria-label="Live alert deliveries">
          <PaneHead icon={<Activity size={14} />} title="Live alert deliveries" right="refreshes every 15 s" />
          <AlertDeliveryLog cloud={cloud} limit={20} />
        </section>
      )}
    </div>
  );
}
