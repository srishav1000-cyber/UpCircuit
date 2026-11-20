'use client';
// Live Alert & Rule Sandbox: replays a scripted multi-stock tick + 5-level depth burst through the real pipeline (heuristicFlags → depthImbalance → volumeBaseline),
// so the OBI gauge, R(t), confirmation badges and alert triggers can be demonstrated at any hour. It owns private in-memory state: no engine mutation, no cloud
// writes, no stored records, and the "push" is a labelled simulation (a local chime + an on-screen row — nothing is sent to any device).
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlaskConical, Play, Pause, RotateCcw } from 'lucide-react';
import { OrderImbalanceGauge } from './OrderImbalanceGauge';
import { ReplayRunner, REPLAY_DISCLOSURE, REPLAY_PHASES, REPLAY_MINUTES, SIM_RULES, type ReplayReading, type SimAlert } from '@/lib/surveillanceReplay';
import { flagTag, type DepthFlag } from '@/lib/heuristicFlags';
import { playChime } from '@/lib/audioAlerts';
import { unlockAudio } from '@/lib/chime';

const GOLD = '#d4a64a', TEAL = '#2dd4bf';
const ist = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const SPEEDS = [{ k: '1×', ms: 400 }, { k: '4×', ms: 100 }, { k: '16×', ms: 25 }] as const;

export function RuleSandbox({ className = '' }: { className?: string }) {
  const run = useRef<ReplayRunner | null>(null);
  if (!run.current) run.current = new ReplayRunner();
  const [, bump] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(SPEEDS[1]);
  const [sound, setSound] = useState(true);
  const [pick, setPick] = useState('RELIANCE');
  const last = useRef<Map<string, ReplayReading>>(new Map());
  const soundRef = useRef(sound); soundRef.current = sound;

  const tick = useCallback(() => {
    const r = run.current!;
    for (const x of r.stepTick()) {
      last.current.set(x.symbol, x);
      if (soundRef.current && x.alerts.some((a) => a.kind === 'confirmed_flag')) { try { playChime('upper', 0.6); } catch { /* audio unavailable */ } }
    }
    if (r.done) setPlaying(false);
    bump((n) => (n + 1) % 1_000_000);
  }, []);
  useEffect(() => { if (!playing) return; const t = setInterval(tick, speed.ms); return () => clearInterval(t); }, [playing, speed, tick]);

  const r = run.current, cur = last.current.get(pick) ?? null, started = r.readings.length > 0;
  const reset = () => { setPlaying(false); r.reset(); last.current.clear(); bump((n) => n + 1); };
  const mins = cur ? (cur.t - r.scenario.startMs) / 60_000 : 0;
  const phase = [...REPLAY_PHASES].filter((p) => p.atMin <= mins).pop() ?? null;
  const flags: DepthFlag[] = r.flags.filter((f) => f.symbol === pick).slice(-4).reverse();
  const alerts: SimAlert[] = [...r.alerts].reverse().slice(0, 8);
  const confirmed = r.flags.filter((f) => f.confirmation?.confirmed).length;

  return (
    <section className={`rounded-xl border border-white/10 bg-white/[0.03] ${className}`} data-testid="rule-sandbox" aria-label="Live alert and rule sandbox">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <FlaskConical size={14} aria-hidden /> <h3 className="text-[13px] font-bold text-ink">Alert &amp; rule sandbox · replay simulator</h3>
        <span className="rounded border px-1.5 text-[10px] font-bold uppercase" style={{ borderColor: GOLD, color: GOLD }}>Simulation</span>
      </header>
      <div className="p-3 text-[12px]">
        <p data-testid="sandbox-disclosure" className="mb-2 text-[11px] text-muted">{REPLAY_DISCLOSURE}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-testid="sandbox-start" onClick={() => { unlockAudio(); if (r.done) reset(); setPlaying((p) => !p); }} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.05] px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-white/[0.09]">
            {playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}{playing ? 'Pause' : started && !r.done ? 'Resume' : 'Simulate Live Market Burst'}
          </button>
          <button type="button" data-testid="sandbox-reset" onClick={reset} className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-ink hover:bg-white/[0.06]"><RotateCcw size={12} aria-hidden /> Reset</button>
          <div role="group" aria-label="Replay speed" className="flex gap-1">{SPEEDS.map((s) => <button key={s.k} type="button" onClick={() => setSpeed(s)} aria-pressed={s.k === speed.k} className={`rounded border px-2 py-0.5 text-[11px] ${s.k === speed.k ? 'border-white/40 text-ink' : 'border-white/10 text-muted'}`}>{s.k}</button>)}</div>
          <label className="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> alert sound</label>
          <span className="num ml-auto text-[11px] text-muted" data-testid="sandbox-progress" data-pct={Math.round(r.progress * 100)}>{started ? `${ist(cur?.t ?? r.scenario.startMs)} IST · ${Math.min(REPLAY_MINUTES, mins).toFixed(1)} / ${REPLAY_MINUTES} min` : 'ready'}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="Simulated stock">
          {r.scenario.symbols.map((s) => <button key={s} role="tab" aria-selected={s === pick} type="button" onClick={() => setPick(s)} className={`rounded border px-2 py-0.5 text-[11px] font-bold ${s === pick ? 'border-white/40 text-ink' : 'border-white/10 text-muted'}`}>{s}</button>)}
        </div>
        {phase && <p data-testid="sandbox-phase" className="mt-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-muted"><b className="text-ink">{phase.symbol}</b> · {phase.text}</p>}
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <OrderImbalanceGauge bids={cur?.bids ?? []} asks={cur?.asks ?? []} symbol={`${pick} (simulated)`} live={!!cur} />
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded border border-white/10 p-2"><div className="text-[10px] uppercase text-muted">LTP</div><div className="num font-semibold" data-testid="sandbox-ltp">{cur ? `₹${cur.ltp.toFixed(2)}` : 'N/A'}</div></div>
              <div className="rounded border border-white/10 p-2"><div className="text-[10px] uppercase text-muted">R(t) 15-min</div><div className="num font-semibold" data-testid="sandbox-rt" style={{ color: cur?.volRatio != null && cur.volRatio >= SIM_RULES.surge ? GOLD : undefined }}>{cur?.volRatio != null ? `${cur.volRatio.toFixed(2)}×` : 'N/A'}</div></div>
              <div className="rounded border border-white/10 p-2"><div className="text-[10px] uppercase text-muted">OBI<sub>λ</sub></div><div className="num font-semibold" data-testid="sandbox-obi">{cur?.obi != null ? `${cur.obi >= 0 ? '+' : '−'}${Math.abs(cur.obi).toFixed(2)}` : 'N/A'}</div></div>
            </div>
            <ul data-testid="sandbox-flags" className="space-y-1">
              {flags.length ? flags.map((f, i) => (
                <li key={`${f.ts}-${f.kind}-${i}`} data-testid="sandbox-flag" data-tag={f.confirmation?.confirmed ? 'confirmed' : 'baseline'} className="rounded border border-white/10 px-2 py-1">
                  <span className="rounded border px-1 text-[10px] font-bold uppercase" style={f.confirmation?.confirmed ? { borderColor: TEAL, color: TEAL } : { borderColor: 'rgb(255 255 255 / 0.25)' }}>{flagTag(f)}{f.confirmation?.confirmed ? ` · ${f.confirmation.hits.join('+')}` : ''}</span>{' '}
                  <span className="text-muted">{f.kind === 'wall' ? 'Resting-order wall' : 'Rapid add/cancel'} · {f.side} · {ist(f.ts)}</span>
                </li>
              )) : <li className="text-[11px] text-muted">No flags for {pick} yet.</li>}
            </ul>
          </div>
        </div>
        <h4 className="mt-3 text-[11px] font-semibold text-ink">Simulated alerts ({r.alerts.length}) · {confirmed} confirmed flags</h4>
        <ul data-testid="sandbox-alerts" className="mt-1 space-y-0.5">
          {alerts.length ? alerts.map((a, i) => <li key={`${a.t}-${a.kind}-${i}`} data-testid="sandbox-alert" data-kind={a.kind} className="text-[11px]"><span className="num text-muted">{ist(a.t)}</span> <span className="rounded bg-white/10 px-1 text-[9px] font-bold uppercase">simulated push</span> {a.text}</li>) : <li className="text-[11px] text-muted">Rules: R(t) ≥ {SIM_RULES.surge}×, |OBI| ≥ {SIM_RULES.obi}, circuit within 1.5 %, any confirmed flag. Press the button to start.</li>}
        </ul>
      </div>
    </section>
  );
}
