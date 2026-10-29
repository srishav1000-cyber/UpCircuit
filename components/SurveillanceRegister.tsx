'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CloudClient, CircuitEvent } from '@/lib/cloud';
import { can, type AppRole } from '@/lib/rbac';
import { audit } from '@/lib/auditBus';
import { downloadText, toCsv } from '@/lib/csvOut';
import { fmt } from '@/lib/format';

const STATUSES = ['all', 'open', 'acknowledged', 'escalated', 'closed'] as const;
const TONE: Record<CircuitEvent['status'], string> = { open: 'bg-warn/15 text-warn', acknowledged: 'bg-accent/15 text-accent', escalated: 'bg-down/15 text-down', closed: 'bg-line text-muted' };
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** Which review actions a role may take on an event (mirrors review_circuit_event in the database, which enforces it). */
export function reviewActions(role: AppRole | null, e: Pick<CircuitEvent, 'status'>): ('acknowledge' | 'escalate' | 'close')[] {
  if (!can(role, 'register.review') || e.status === 'closed') return [];
  if (e.status === 'open') return ['acknowledge', 'escalate', 'close'];
  if (e.status === 'acknowledged') return ['escalate', 'close'];
  return can(role, 'register.close_escalated') ? ['close'] : [];
}

export function SurveillanceRegister({ cloud, role, onOpenStock }: { cloud: CloudClient; role: AppRole; onOpenStock?: (s: string) => void }) {
  const [rows, setRows] = useState<CircuitEvent[] | null>(null);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<{ id: string; action: 'escalate' | 'close' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await cloud.listRegister(300)); setErr(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the register'); }
  }, [cloud]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);

  const shown = useMemo(() => (rows ?? []).filter((r) => (status === 'all' || r.status === status) && (!q || r.symbol.includes(q.trim().toUpperCase()))), [rows, status, q]);
  const counts = useMemo(() => Object.fromEntries(STATUSES.map((s) => [s, (rows ?? []).filter((r) => s === 'all' || r.status === s).length])), [rows]);

  async function act(e: CircuitEvent, action: 'acknowledge' | 'escalate' | 'close', n?: string) {
    setBusy(true);
    try { await cloud.reviewEvent(e.id, action, n); setPending(null); setNote(''); await load(); } catch (x) { setErr(x instanceof Error ? x.message.replace(/^cloud \d+: /, '') : 'Review failed'); } finally { setBusy(false); }
  }
  function exportCsv() {
    const csv = toCsv(['Symbol', 'Direction', 'Band %', 'Price', 'Prev close', 'Trade date', 'Detected (IST)', 'Source', 'Status', 'Reviewed at', 'Note'], shown.map((r) => [r.symbol, r.direction, r.band, r.price, r.prev_close, r.trade_date, when(r.detected_at), r.source, r.status, r.reviewed_at ? when(r.reviewed_at) : '', r.note]));
    downloadText(`circuit-register-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    audit({ action: 'register.export', entity: 'circuit_events', meta: { rows: shown.length } });
  }

  return (
    <section data-testid="register" aria-label="Circuit surveillance register">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button key={s} data-testid={`reg-filter-${s}`} aria-pressed={status === s} onClick={() => setStatus(s)} className={`rounded-full border px-3 py-1 text-[12px] font-semibold capitalize ${status === s ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted hover:text-ink'}`}>{s} <span className="num opacity-70">{counts[s] ?? 0}</span></button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter symbol…" aria-label="Filter by symbol" className="ml-auto h-8 w-36 rounded-md border border-line bg-transparent px-2 text-[12px] text-ink outline-none focus:border-accent" />
        <button onClick={exportCsv} disabled={!shown.length} data-testid="reg-export" className="h-8 rounded-md border border-line px-3 text-[12px] font-semibold text-ink hover:bg-line disabled:opacity-40">⬇ CSV</button>
      </div>
      {err && <div role="alert" data-testid="reg-error" className="mb-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      <p className="mb-2 text-[11px] text-muted">One row per stock · direction · trading day, reported by whichever signed-in client saw it first (real feed data only — the demo simulator never registers). Reviews are written to the tamper-evident audit trail.</p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[760px] text-left text-[12px]">
          <thead className="bg-line/40 text-[11px] uppercase tracking-wide text-muted"><tr>{['Stock', 'Limit', 'Price', 'Detected (IST)', 'Source', 'Status', 'Review'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {rows === null && !err && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted">Loading…</td></tr>}
            {rows !== null && !shown.length && <tr><td colSpan={7} data-testid="reg-empty" className="px-3 py-8 text-center text-muted">{rows.length ? 'No events match this filter.' : 'No circuit events registered yet. They appear here when a stock on any signed-in terminal reaches its band during live data.'}</td></tr>}
            {shown.map((r) => {
              const acts = reviewActions(role, r);
              return (
                <tr key={r.id} data-testid="reg-row" data-status={r.status} className="border-t border-line align-top">
                  <td className="px-3 py-2"><button onClick={() => onOpenStock?.(r.symbol)} className="font-bold text-ink hover:text-accent">{r.symbol}</button></td>
                  <td className={`px-3 py-2 font-semibold ${r.direction === 'UPPER' ? 'text-up' : 'text-down'}`}>{r.direction === 'UPPER' ? '▲ UPPER' : '▼ LOWER'} {r.band}%</td>
                  <td className="num px-3 py-2">₹{fmt(r.price)}</td>
                  <td className="px-3 py-2 text-muted">{when(r.detected_at)}</td>
                  <td className="px-3 py-2 text-muted">{r.source}</td>
                  <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-[11px] font-bold capitalize ${TONE[r.status]}`}>{r.status}</span>{r.note && <div className="mt-1 max-w-[220px] text-[11px] text-muted" title={r.note}>“{r.note}”</div>}</td>
                  <td className="px-3 py-2">
                    {pending?.id === r.id ? (
                      <div className="flex flex-col gap-1">
                        <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={`Note for ${pending.action} (required)`} aria-label="Review note" data-testid="reg-note" className="h-8 w-52 rounded-md border border-line bg-transparent px-2 text-[12px] text-ink outline-none focus:border-accent" />
                        <div className="flex gap-1">
                          <button disabled={busy || !note.trim()} onClick={() => void act(r, pending.action, note.trim())} data-testid="reg-confirm" className="rounded bg-accent px-2 py-1 text-[11px] font-bold text-white disabled:opacity-40">Confirm {pending.action}</button>
                          <button onClick={() => { setPending(null); setNote(''); }} className="rounded border border-line px-2 py-1 text-[11px] text-muted">Cancel</button>
                        </div>
                      </div>
                    ) : acts.length ? (
                      <div className="flex flex-wrap gap-1">
                        {acts.map((a) => (
                          <button key={a} disabled={busy} data-testid={`reg-${a}`} onClick={() => (a === 'acknowledge' ? void act(r, a) : (setPending({ id: r.id, action: a }), setNote('')))} className="rounded border border-line px-2 py-1 text-[11px] font-semibold capitalize text-ink hover:bg-line">{a}</button>
                        ))}
                      </div>
                    ) : <span className="text-[11px] text-muted">{r.status === 'closed' ? 'Final' : can(role, 'register.review') ? 'Needs compliance' : 'Read-only'}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
