'use client';
// Post-market Historical Session Replay ("Market DVR"): replays ONE recorded NSE session (09:15–15:30 IST) from precomputed frames fetched
// from GET /api/market/session-replay. Read-only: this component owns its own state (clock, speed, loaded session) and never touches the live
// engine, live quotes or any database; the only network call is the GET below.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Film } from 'lucide-react';
import { AuthCtx } from '@/hooks/useAuth';
import {
  REPLAY_SPEEDS, SESSION_MINUTES, SESSION_SECONDS, advanceClock, clockForMinute, clockLabel, frameIndexAt, fullDaySeconds, lastTradingDays, minuteOfClock, speedById,
  DEPTH_DISCLOSURE, SYNTHETIC_DISCLOSURE, SURGE_THRESHOLD, CIRCUIT_NEAR_PCT, type ReplaySession, type MomentKind,
} from '@/lib/sessionReplay';

const GOLD = '#d4a64a', TEAL = '#2dd4bf', UP = '#34d399', DOWN = '#f87171';
const PRESETS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'ITC', 'LT', 'BHARTIARTL', 'TATAMOTORS'];
const KIND_COLOR: Record<MomentKind, string> = { orb_up: UP, orb_down: DOWN, surge: GOLD, vwap_cross_up: TEAL, vwap_cross_down: '#fb923c', circuit_near: '#c084fc', circuit_touch: '#f43f5e' };
const KIND_TAG: Record<MomentKind, string> = { orb_up: 'ORB ↑', orb_down: 'ORB ↓', surge: 'R(t)', vwap_cross_up: 'VWAP ↑', vwap_cross_down: 'VWAP ↓', circuit_near: 'CIRCUIT', circuit_touch: 'CIRCUIT' };
const fmt = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? 'N/A' : n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const dur = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(s % 3600 ? 1 : 0)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

type Load = { state: 'idle' | 'loading' } | { state: 'ok'; session: ReplaySession } | { state: 'error'; message: string; canSynth: boolean };

export function SessionReplayPlayer({ symbol = 'RELIANCE', className = '' }: { symbol?: string; className?: string }) {
  const getToken = useContext(AuthCtx)?.getToken;
  const days = useMemo(() => lastTradingDays(Date.now()), []);
  const [sym, setSym] = useState(symbol.toUpperCase());
  const [draft, setDraft] = useState(symbol.toUpperCase());
  const [date, setDate] = useState(days[0]);
  const [band, setBand] = useState<number | null>(null);
  const [speedId, setSpeedId] = useState('express');
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [synth, setSynth] = useState(false);
  const speed = speedById(speedId);
  const clockRef = useRef(0); clockRef.current = clock;

  useEffect(() => { const s = symbol.toUpperCase(); setSym(s); setDraft(s); }, [symbol]);

  useEffect(() => {
    let dead = false;
    setLoad({ state: 'loading' }); setPlaying(false); setClock(0);
    (async () => {
      try {
        const token = await getToken?.().catch(() => null);
        const qs = new URLSearchParams({ symbol: sym, date, ...(band ? { band: String(band) } : {}), ...(synth ? { synthetic: '1' } : {}) });
        const r = await fetch(`/api/market/session-replay?${qs}`, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000) });
        const j = await r.json().catch(() => null);
        if (dead) return;
        if (j?.ok) setLoad({ state: 'ok', session: j.session as ReplaySession });
        else setLoad({ state: 'error', message: `${j?.error ?? `HTTP ${r.status}`}${j?.notes?.length ? ` — ${j.notes.join(' ')}` : ''}${j?.availableDates?.length ? ` Yahoo has: ${j.availableDates.join(', ')}.` : ''}`, canSynth: !!j?.canUseSynthetic });
      } catch (e) {
        if (!dead) setLoad({ state: 'error', message: `request failed (${(e as Error).message})`, canSynth: true });
      }
    })();
    return () => { dead = true; };
  }, [sym, date, band, synth, getToken]);

  const session = load.state === 'ok' ? load.session : null;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const { clock: c, done } = advanceClock(clockRef.current, now - last, speed);
      last = now; setClock(c); if (done) setPlaying(false);
    }, 100);
    return () => clearInterval(id);
  }, [playing, speed]);

  const idx = session ? frameIndexAt(session.frames, clock) : -1;
  const f = session && idx >= 0 ? session.frames[idx] : null;
  const shown = session ? session.moments.filter((m) => m.i <= idx) : [];
  const scrubTo = useCallback((minute: number) => setClock(clockForMinute(minute)), []);

  // chart geometry (fixed full-day price axis so the picture does not rescale while it plays)
  const W = 640, H = 210, PL = 8, PR = 50, PT = 10, PB = 20;
  const fr = session?.frames ?? [];
  const lo = fr.length ? Math.min(...fr.map((x) => x.low)) : 0, hi = fr.length ? Math.max(...fr.map((x) => x.high)) : 1, span = hi - lo || 1;
  const X = (i: number) => PL + (i / (SESSION_MINUTES - 1)) * (W - PL - PR);
  const Y = (p: number) => PT + (1 - (p - lo) / span) * (H - PT - PB);
  const path = (get: (x: (typeof fr)[number]) => number | null) => fr.slice(0, idx + 1).map((x, k, a) => { const v = get(x); return v == null ? '' : `${a.slice(0, k).some((y) => get(y) != null) ? 'L' : 'M'}${X(x.i).toFixed(1)},${Y(v).toFixed(1)}`; }).join('');
  const orEnd = fr.findIndex((x) => x.orState !== 'forming');

  const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.05] px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-white/[0.09]';
  const field = 'rounded border border-white/15 bg-transparent px-2 py-1 text-[12px] text-ink';
  const card = (label: string, value: string, sub: string, tid: string, color?: string) => (
    <div key={tid} className="min-w-0 rounded-lg border border-white/10 p-2" data-testid={tid}>
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="num truncate text-[14px] font-bold" style={{ color: color ?? undefined }}>{value}</div>
      <div className="num truncate text-[10px] text-muted">{sub}</div>
    </div>
  );

  return (
    <div className={`p-3 text-[12px] ${className}`} data-testid="replay-player">
      <p data-testid="replay-disclosure" className="mb-2 text-[11px] text-muted">
        <Film size={11} className="mr-1 inline" aria-hidden />Historical session replay: one recorded NSE session, 09:15–15:30 IST ({SESSION_MINUTES} one-minute bars). Read-only — it never changes live quotes, the surveillance engine or any stored data. Speeds are multiples of real time (1× = a full day takes 6 h 15 min); a minute appears once it has closed.
      </p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); const s = draft.trim().toUpperCase(); if (/^[A-Z0-9&._-]{1,24}$/.test(s)) { setSynth(false); setSym(s); } }}>
        <label className="text-[11px] text-muted">Symbol <input data-testid="replay-symbol" list="replay-syms" value={draft} onChange={(e) => setDraft(e.target.value.toUpperCase())} className={`${field} ml-1 w-28`} /></label>
        <datalist id="replay-syms">{[...new Set([symbol.toUpperCase(), ...PRESETS])].map((s) => <option key={s} value={s} />)}</datalist>
        <button type="submit" className="rounded border border-white/15 px-2 py-1 text-[11px] text-ink hover:bg-white/[0.06]" data-testid="replay-load">Load</button>
        <label className="text-[11px] text-muted">Date <select data-testid="replay-date" value={date} onChange={(e) => { setSynth(false); setDate(e.target.value); }} className={`${field} ml-1`}>{days.map((d) => <option key={d} value={d} className="bg-black">{d}</option>)}</select></label>
        <label className="text-[11px] text-muted" title="NSE price band of the stock; Yahoo does not carry it, so circuit proximity is N/A unless you set it">Band <select data-testid="replay-band" value={band ?? ''} onChange={(e) => setBand(e.target.value ? Number(e.target.value) : null)} className={`${field} ml-1`}><option value="" className="bg-black">N/A</option>{[5, 10, 20].map((b) => <option key={b} value={b} className="bg-black">{b}%</option>)}</select></label>
      </form>

      {load.state === 'loading' && <p className="mt-3 text-muted" data-testid="replay-loading">Loading {sym} · {date}…</p>}
      {load.state === 'error' && (
        <div className="mt-3 rounded-lg border border-white/10 p-3" data-testid="replay-error" role="status">
          <p className="text-[12px] text-ink">Replay unavailable for {sym} on {date}: {load.message}</p>
          {load.canSynth && <button type="button" className={`${btn} mt-2`} data-testid="replay-synth" onClick={() => setSynth(true)}>Load labelled synthetic demo session</button>}
        </div>
      )}

      {session && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span data-testid="replay-provenance" className="rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase" style={{ borderColor: session.synthetic ? '#f59e0b' : TEAL, color: session.synthetic ? '#f59e0b' : TEAL }}>[{session.provenance}]</span>
            <span className="text-[11px] text-muted">{session.symbol} · {session.date} · {session.frames.length} bars{session.prevClose ? ` · prev close ${fmt(session.prevClose)}` : ''}</span>
          </div>
          {session.synthetic && <p data-testid="replay-synth-banner" className="mt-1 rounded border border-amber-500/50 px-2 py-1 text-[11px] text-amber-400">{SYNTHETIC_DISCLOSURE}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" data-testid="replay-play" className={btn} onClick={() => { if (clock >= SESSION_SECONDS) setClock(0); setPlaying((p) => !p); }}>{playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}{playing ? 'Pause' : clock >= SESSION_SECONDS ? 'Replay' : clock > 0 ? 'Resume' : 'Play'}</button>
            <button type="button" data-testid="replay-reset" className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-ink hover:bg-white/[0.06]" onClick={() => { setPlaying(false); setClock(0); }}><RotateCcw size={12} aria-hidden /> Reset</button>
            <div role="radiogroup" aria-label="Playback speed" className="flex flex-wrap gap-1">
              {REPLAY_SPEEDS.map((s) => <button key={s.id} type="button" role="radio" aria-checked={s.id === speedId} data-testid={`replay-speed-${s.id}`} onClick={() => setSpeedId(s.id)} className={`rounded border px-2 py-1 text-[11px] font-semibold ${s.id === speedId ? 'border-white/50 bg-white/[0.1] text-ink' : 'border-white/15 text-muted hover:bg-white/[0.06]'}`}>{s.label}</button>)}
            </div>
            <span className="text-[10px] text-muted" data-testid="replay-duration">full day ≈ {dur(fullDaySeconds(speed))}</span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="num w-12 text-[11px] text-ink" data-testid="replay-clock">{clockLabel(clock)}</span>
            <input data-testid="replay-scrub" type="range" aria-label="Session timeline 09:15 to 15:30 IST" min={0} max={SESSION_MINUTES - 1} value={minuteOfClock(clock)} onChange={(e) => scrubTo(Number(e.target.value))} className="w-full" />
            <span className="num text-[10px] text-muted">15:30</span>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="replay-telemetry">
            {card('Price', f ? fmt(f.close) : 'N/A', f ? `O ${fmt(f.open)} H ${fmt(f.high)} L ${fmt(f.low)}` : 'press Play', 'replay-t-price')}
            {card('Running VWAP', f ? fmt(f.vwap) : 'N/A', f?.vwap ? `${f.close >= f.vwap ? 'above' : 'below'} by ${fmt(Math.abs(((f.close - f.vwap) / f.vwap) * 100))}%` : '', 'replay-t-vwap', GOLD)}
            {card('Opening Range', f ? (f.orState === 'forming' ? 'forming' : f.orState) : 'N/A', f && f.orHigh != null ? `H ${fmt(f.orHigh)} · L ${fmt(f.orLow)}` : '09:15–09:30', 'replay-t-or', f?.orState === 'above' ? UP : f?.orState === 'below' ? DOWN : undefined)}
            {card('Volume surge R(t)', f?.r != null ? `${f.r.toFixed(2)}×` : 'N/A', f?.r != null && f.r >= SURGE_THRESHOLD ? `≥ ${SURGE_THRESHOLD} surge` : session.rBasis === 'median-profile' ? 'vs median profile' : 'vs session-average pace', 'replay-t-r', f?.r != null && f.r >= SURGE_THRESHOLD ? GOLD : undefined)}
            {card('Circuit proximity', f?.circuitGapPct != null ? `${fmt(f.circuitGapPct)}%` : 'N/A', f?.circuitGapPct != null ? `to ${f.circuitSide} limit${f.nearCircuit ? ` (≤ ${CIRCUIT_NEAR_PCT}%)` : ''}` : 'needs prev close + band', 'replay-t-circuit', f?.nearCircuit ? '#c084fc' : undefined)}
            {card('Day volume', f ? f.cumVolume.toLocaleString('en-IN') : 'N/A', f ? `this minute ${f.volume.toLocaleString('en-IN')}` : '', 'replay-t-volume')}
            {card('L2 depth (OBI)', 'N/A', 'OHLCV-only replay', 'replay-t-depth')}
            {card('Moments so far', String(shown.length), `of ${session.moments.length} in session`, 'replay-t-moments')}
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label={`${session.symbol} intraday price, running VWAP and Opening Range, ${session.date}`} data-testid="replay-chart">
            <rect x="0" y="0" width={W} height={H} fill="transparent" />
            {[0, 0.25, 0.5, 0.75, 1].map((q) => <g key={q}><line x1={PL} x2={W - PR} y1={PT + q * (H - PT - PB)} y2={PT + q * (H - PT - PB)} stroke="currentColor" strokeOpacity="0.08" /><text x={W - PR + 4} y={PT + q * (H - PT - PB) + 3} fontSize="9" fill="currentColor" opacity="0.6">{fmt(hi - q * span)}</text></g>)}
            {[0, 90, 195, 285, 374].map((m) => <text key={m} x={X(m)} y={H - 6} fontSize="9" textAnchor="middle" fill="currentColor" opacity="0.6">{clockLabel(m * 60)}</text>)}
            {session.orHigh != null && session.orLow != null && orEnd > 0 && idx >= orEnd && <>
              <rect x={X(0)} y={Y(session.orHigh)} width={X(Math.min(idx, 374)) - X(0)} height={Math.max(1, Y(session.orLow) - Y(session.orHigh))} fill={TEAL} fillOpacity="0.06" />
              <line x1={X(0)} x2={X(Math.min(idx, 374))} y1={Y(session.orHigh)} y2={Y(session.orHigh)} stroke={TEAL} strokeDasharray="4 3" strokeOpacity="0.8" data-testid="replay-or-high" />
              <line x1={X(0)} x2={X(Math.min(idx, 374))} y1={Y(session.orLow)} y2={Y(session.orLow)} stroke={TEAL} strokeDasharray="4 3" strokeOpacity="0.8" data-testid="replay-or-low" />
            </>}
            {idx >= 0 && <path d={path((x) => x.vwap)} fill="none" stroke={GOLD} strokeWidth="1.5" data-testid="replay-vwap-line" />}
            {idx >= 0 && <path d={path((x) => x.close)} fill="none" stroke="currentColor" strokeWidth="1.5" data-testid="replay-price-line" />}
            {shown.map((m, k) => <circle key={`${m.i}-${m.kind}-${k}`} cx={X(m.i)} cy={Y(fr[m.i].close)} r="3.5" fill={KIND_COLOR[m.kind]} stroke="#000" strokeOpacity="0.4"><title>{`${m.time} ${m.label}`}</title></circle>)}
            {f && <line x1={X(idx)} x2={X(idx)} y1={PT} y2={H - PB} stroke="currentColor" strokeOpacity="0.3" />}
          </svg>
          <p className="text-[10px] text-muted">— price · <span style={{ color: GOLD }}>— running VWAP</span> · <span style={{ color: TEAL }}>- - Opening Range (09:15–09:30)</span></p>

          <h4 className="mt-3 text-[11px] font-semibold text-ink">Key Session Moments Log <span className="font-normal text-muted">(IST · click to jump)</span></h4>
          <ul data-testid="replay-moments" className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
            {shown.length ? [...shown].reverse().map((m, k) => (
              <li key={`${m.i}-${m.kind}-${k}`}>
                <button type="button" data-testid="replay-moment" data-kind={m.kind} onClick={() => scrubTo(m.i)} className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-white/[0.05]">
                  <span className="num text-[11px] font-semibold text-ink">{m.time}</span>
                  <span className="rounded px-1 text-[9px] font-bold" style={{ color: KIND_COLOR[m.kind], border: `1px solid ${KIND_COLOR[m.kind]}` }}>{KIND_TAG[m.kind]}</span>
                  <span className="min-w-0 truncate text-[11px] text-ink">{m.label}</span><span className="num hidden truncate text-[10px] text-muted sm:inline">{m.detail}</span>
                </button>
              </li>
            )) : <li className="text-[11px] text-muted">No moments yet — press Play or drag the timeline.</li>}
          </ul>

          <p data-testid="replay-depth-na" className="mt-3 text-[11px] text-muted">{DEPTH_DISCLOSURE}</p>
          {session.notes.length > 0 && <ul data-testid="replay-notes" className="mt-1 list-disc pl-4 text-[10px] text-muted">{session.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </>
      )}
    </div>
  );
}
