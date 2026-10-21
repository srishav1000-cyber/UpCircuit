'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '../ui';
import { proximityOf, NEAR_PCT } from '@/lib/analytics/proximity';
import { DEFAULT_LIMITS, evaluateLimits, logBreaches, sanitiseLimits, type BreachEntry, type LimitId, type Limits } from '@/lib/analytics/limits';
import { scoped } from '@/lib/scope';
import type { MarketEngine } from '@/lib/market';
import type { Holding } from '@/lib/types';

const LIM_KEY = 'upcircuit:limits:v1';
const LOG_KEY = 'upcircuit:breachlog:v1';
const TONE = { pass: 'text-up border-up/40 bg-up/10', near: 'text-warn border-warn/40 bg-warn/10', breach: 'text-down border-down/40 bg-down/10' } as const;
const LABEL = { pass: 'PASS', near: 'NEAR', breach: 'BREACH' } as const;
const ID_LABEL: Record<LimitId, string> = { stock: 'Single stock', sector: 'Sector', hhi: 'HHI', circuit: 'Circuit exposure' };

const read = <T,>(k: string, fb: T): T => { try { const r = localStorage.getItem(scoped(k)); return r ? (JSON.parse(r) as T) : fb; } catch { return fb; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(scoped(k), JSON.stringify(v)); } catch { /* ignore */ } };

/** Policy limit & circuit breach monitor: user-set exposure limits checked against the live portfolio; breaches are logged once per rule per day (this browser). */
export function LimitMonitor({ engine, holdings, className = '' }: { engine: MarketEngine; holdings: Holding[]; className?: string }) {
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [log, setLog] = useState<BreachEntry[]>([]);
  useEffect(() => { setLimits(sanitiseLimits(read(LIM_KEY, null))); setLog(read<BreachEntry[]>(LOG_KEY, [])); }, []);

  const positions = holdings.map((h) => {
    const q = engine.quotes.get(h.symbol);
    const p = q ? proximityOf(q) : null;
    return { symbol: h.symbol, sector: q?.sector ?? 'Others', value: h.qty * (q?.ltp ?? 0), nearCircuit: !!p && p.proximityPct <= NEAR_PCT };
  });
  const posKey = positions.map((p) => `${p.symbol}:${Math.round(p.value)}:${p.nearCircuit ? 1 : 0}`).join(',');
  const rows = useMemo(() => evaluateLimits({ positions }, limits), [posKey, limits]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rows) return;
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    setLog((cur) => {
      const r = logBreaches(cur, rows, Date.now(), day);
      if (r.added.length === 0) return cur;
      write(LOG_KEY, r.log);
      return r.log;
    });
  }, [rows]);

  const setLimit = (id: LimitId, v: string) => {
    const n = Number(v);
    setLimits((cur) => { const next = sanitiseLimits({ ...cur, [id]: n }); write(LIM_KEY, next); return next; });
  };
  const breaches = rows?.filter((r) => r.status === 'breach').length ?? 0;
  return (
    <Card title="Policy limits & circuit breach monitor" badges={['computed']} className={className} right={rows ? <span data-testid="limit-summary" className={`num text-[11px] font-semibold ${breaches ? 'text-down' : 'text-up'}`}>{breaches ? `${breaches} breach${breaches === 1 ? '' : 'es'}` : 'all within limits'}</span> : undefined}>
      <div data-testid="limit-monitor" data-breaches={rows ? breaches : 'na'}>
        {!rows ? (
          <p className="py-4 text-center text-[12px] text-muted" data-testid="limit-na">N/A — import holdings to check policy limits.</p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {rows.map((r) => (
                <li key={r.id} data-testid="limit-row" data-status={r.status} className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className={`w-16 rounded border px-1.5 py-0.5 text-center text-[10px] font-bold ${TONE[r.status]}`}>{LABEL[r.status]}</span>
                  <span className="min-w-[8.5rem] flex-1 text-ink">{r.label} <span className="text-muted">· {r.detail}</span></span>
                  <span className="num text-ink">{r.unit === '%' ? r.actual.toFixed(1) + '%' : Math.round(r.actual).toLocaleString('en-IN')}</span>
                  <label className="num flex items-center gap-1 text-[11px] text-muted">limit
                    <input aria-label={`${ID_LABEL[r.id]} limit`} data-testid={`limit-input-${r.id}`} inputMode="decimal" defaultValue={limits[r.id]} key={limits[r.id]} onBlur={(e) => setLimit(r.id, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className="num w-16 rounded border border-line bg-bg px-1.5 py-0.5 text-right text-[11px] text-ink outline-none focus:border-accent" />
                    {r.unit}
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-line pt-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Breach log (this browser)</div>
              {log.length === 0 ? <p className="mt-1 text-[11px] text-muted" data-testid="breach-empty">No breaches recorded.</p> : (
                <ul className="num mt-1 space-y-0.5 text-[11px] text-muted" data-testid="breach-log">
                  {log.slice(0, 5).map((e) => <li key={e.day + e.id}>{new Date(e.ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} · <b className="text-down">{ID_LABEL[e.id]}</b> {e.id === 'hhi' ? Math.round(e.actual) : e.actual.toFixed(1) + '%'} &gt; limit {e.limit}</li>)}
                </ul>
              )}
            </div>
            <p className="mt-2 text-[10px] text-muted">BREACH = above the limit · NEAR = at or above 90 % of it. Circuit exposure = share of portfolio value in holdings locked at, or within {NEAR_PCT}% of, a price limit. Limits and the log live in this browser only; one log row per rule per day.</p>
          </>
        )}
      </div>
    </Card>
  );
}
