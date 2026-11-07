'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AlertDelivery, CloudClient } from '@/lib/cloud';
import { fmtMs, latencyTone, stagesOf, summarize } from '@/lib/deliveryLatency';

type Filter = 'all' | 'push' | 'failed';
const tone = { up: 'text-up', warn: 'text-warn', down: 'text-down', muted: 'text-muted' } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');

/** Alert delivery history with per-stage latency: tick → daemon match → push accepted → device display. Rows come from alert_deliveries (RLS: your own). */
export function AlertDeliveryLog({ cloud, limit = 50 }: { cloud: CloudClient; limit?: number }) {
  const [rows, setRows] = useState<AlertDelivery[] | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try { setRows(await cloud.listDeliveries(limit)); setErr(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load deliveries'); } finally { setBusy(false); }
  }, [cloud, limit]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);

  const shown = useMemo(() => (rows ?? []).filter((r) => (filter === 'push' ? r.channel === 'push' : filter === 'failed' ? r.status === 'failed' : true)), [rows, filter]);
  const sum = useMemo(() => summarize(rows ?? []), [rows]);
  const hasLatency = (rows ?? []).some((r) => r.daemon_matched_at);

  const stat = (label: string, v: number | null, hint?: string) => (
    <div className="rounded-lg border border-line bg-panel/60 px-3 py-2" title={hint}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`num text-[15px] font-bold ${tone[latencyTone(label.startsWith('Cross') ? v : null)]}`}>{fmtMs(v)}</div>
    </div>
  );

  return (
    <section data-testid="delivery-log" aria-label="Alert delivery log" className="mt-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Delivery log · latency</h3>
        <div role="group" aria-label="Filter deliveries" className="ml-auto flex gap-1">
          {(['all', 'push', 'failed'] as Filter[]).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={`dl-filter-${f}`} className={`rounded-md border px-2 py-1 text-[11px] font-semibold capitalize ${filter === f ? 'border-accent bg-accent/15 text-ink' : 'border-line text-muted hover:text-ink'}`}>{f}</button>
          ))}
          <button type="button" onClick={() => void load()} disabled={busy} title="Refresh" className="rounded-md border border-line px-2 py-1 text-muted hover:text-ink disabled:opacity-50"><RefreshCw size={12} aria-hidden /><span className="sr-only">Refresh</span></button>
        </div>
      </div>

      {hasLatency && (
        <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="dl-summary">
          {stat('Cross→push p50', sum.p50.crossToPush, 'exchange tick → first device accepted by its push service; target < 1 s (p50), < 2 s (p99)')}
          {stat('Cross→push p95', sum.p95.crossToPush)}
          {stat('Tick→match p50', sum.p50.tickToMatch, 'exchange timestamp has 1 s resolution')}
          {stat('Match→push p50', sum.p50.matchToPush)}
          {stat('Push→shown p50', sum.p50.pushToDisplay, 'device clock; skewed clocks are excluded')}
          <p className="col-span-full text-[11px] text-muted">{sum.rows} sent push alert{sum.rows === 1 ? '' : 's'} in view · {sum.acked} confirmed displayed by a device · measured, not estimated.</p>
        </div>
      )}

      {err && <div role="alert" className="mb-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[760px] text-left text-[12px]">
          <thead className="bg-line/40 text-[11px] uppercase tracking-wide text-muted">
            <tr>{['Fired (IST)', 'Stock', 'Kind', 'Channel', 'Status', 'Tick→match', 'Match→push', 'Push→shown', 'Cross→push', 'Detail'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows !== null && !shown.length && <tr><td colSpan={10} data-testid="dl-empty" className="px-3 py-6 text-center text-muted">{rows.length ? 'No deliveries match this filter.' : 'Nothing has fired yet. Use “Send Test Push Notification” in Settings → Alerts to see your first row.'}</td></tr>}
            {shown.map((d) => {
              const s = stagesOf(d);
              const acked = !!d.sw_ack_at;
              return (
                <tr key={d.id} data-testid="dl-row" className="border-t border-line">
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{when(d.fired_at)}</td>
                  <td className="px-3 py-2 font-bold text-ink">{d.symbol}</td>
                  <td className="px-3 py-2 text-muted">{d.kind}</td>
                  <td className="px-3 py-2 text-muted">{d.channel}</td>
                  <td className={`px-3 py-2 ${d.status === 'sent' ? 'text-up' : d.status === 'failed' ? 'text-down' : 'text-warn'}`}>{d.status}{d.channel === 'push' && d.status === 'sent' && <span className={`ml-1 ${acked ? 'text-up' : 'text-muted'}`} title={acked ? 'A device confirmed it displayed the notification' : 'No device confirmation (yet)'}>{acked ? '· shown' : '· no ACK'}</span>}</td>
                  <td className="num px-3 py-2">{fmtMs(s.tickToMatchMs)}</td>
                  <td className="num px-3 py-2">{fmtMs(s.matchToPushMs)}</td>
                  <td className="num px-3 py-2" title={s.skew ? 'device clock differs from the server — value hidden' : undefined}>{s.skew && s.pushToDisplayMs === null ? 'clock skew' : fmtMs(s.pushToDisplayMs)}</td>
                  <td className={`num px-3 py-2 font-semibold ${tone[latencyTone(s.crossToPushMs)]}`}>{fmtMs(s.crossToPushMs)}</td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-muted" title={d.detail ?? ''}>{d.detail}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted">Alerts before the live daemon was running (or rules on the 5-minute cron backstop) have no latency stamps and show “—”.</p>
    </section>
  );
}
