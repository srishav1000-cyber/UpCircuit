'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AuditRow, CloudClient } from '@/lib/cloud';
import { audit } from '@/lib/auditBus';
import { downloadText, toCsv } from '@/lib/csvOut';
import { AUDIT_ACTIONS } from '@/lib/audit';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function AuditTrail({ cloud, canVerify, canExport }: { cloud: CloudClient; canVerify: boolean; canExport: boolean }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [action, setAction] = useState('');
  const [err, setErr] = useState('');
  const [chain, setChain] = useState<{ ok: boolean; checked: number; first_bad_seq: number | null } | null>(null);
  const load = useCallback(async () => {
    try { setRows(await cloud.listAudit({ action: action || undefined, limit: 300 })); setErr(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the audit trail'); }
  }, [cloud, action]);
  useEffect(() => { void load(); }, [load]);

  async function verify() {
    try { const r = await cloud.verifyAudit(); setChain(r); audit({ action: 'audit.verify', entity: 'audit_log', meta: { ok: r.ok, checked: r.checked } }); } catch (e) { setErr(e instanceof Error ? e.message.replace(/^cloud \d+: /, '') : 'Verification failed'); }
  }
  function exportCsv() {
    downloadText(`audit-trail-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(['Seq', 'Time (IST)', 'User', 'Role', 'Action', 'Entity', 'Entity id', 'Meta', 'Hash'], (rows ?? []).map((r) => [r.seq, when(r.at), r.user_id, r.actor_role, r.action, r.entity, r.entity_id, r.meta, r.hash])));
    audit({ action: 'audit.export', entity: 'audit_log', meta: { rows: rows?.length ?? 0 } });
  }
  return (
    <section data-testid="audit" aria-label="Audit trail">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action" data-testid="audit-filter" className="h-8 rounded-md border border-line bg-transparent px-2 text-[12px] text-ink">
          <option value="" className="bg-panel">All actions</option>
          {AUDIT_ACTIONS.map((a) => <option key={a} value={a} className="bg-panel">{a}</option>)}
        </select>
        <button onClick={() => void load()} className="h-8 rounded-md border border-line px-3 text-[12px] font-semibold text-ink hover:bg-line">↻ Refresh</button>
        {canVerify && <button onClick={() => void verify()} data-testid="audit-verify" className="h-8 rounded-md border border-accent/60 bg-accent/10 px-3 text-[12px] font-semibold text-accent hover:bg-accent/20">🔗 Verify hash chain</button>}
        {canExport && <button onClick={exportCsv} disabled={!rows?.length} data-testid="audit-export" className="ml-auto h-8 rounded-md border border-line px-3 text-[12px] font-semibold text-ink hover:bg-line disabled:opacity-40">⬇ CSV</button>}
      </div>
      {chain && <div data-testid="audit-chain" role="status" className={`mb-2 rounded-md border px-3 py-2 text-[12px] ${chain.ok ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down'}`}>{chain.ok ? `Chain intact — ${chain.checked} entries recomputed, none altered.` : `Chain BROKEN at entry #${chain.first_bad_seq} — entries were modified or removed outside the application.`}</div>}
      {err && <div role="alert" className="mb-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      <p className="mb-2 text-[11px] text-muted">Append-only: each entry stores the SHA-256 of its content plus the previous entry’s hash, and the database rejects UPDATE / DELETE. The chain proves tampering by anyone without database-owner access is detectable; it is not a substitute for off-site backups.</p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[720px] text-left text-[12px]">
          <thead className="bg-line/40 text-[11px] uppercase tracking-wide text-muted"><tr>{['#', 'Time (IST)', 'Role', 'Action', 'Entity', 'Details'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {rows !== null && !rows.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted">No audit entries.</td></tr>}
            {(rows ?? []).map((r) => (
              <tr key={r.seq} data-testid="audit-row" className="border-t border-line align-top">
                <td className="num px-3 py-2 text-muted">{r.seq}</td>
                <td className="px-3 py-2 text-muted">{when(r.at)}</td>
                <td className="px-3 py-2 text-muted">{r.actor_role ?? 'system'}</td>
                <td className="px-3 py-2 font-mono text-[11px] font-semibold text-ink">{r.action}</td>
                <td className="px-3 py-2 text-muted">{[r.entity, r.entity_id].filter(Boolean).join(' · ')}</td>
                <td className="max-w-[260px] truncate px-3 py-2 font-mono text-[11px] text-muted" title={JSON.stringify(r.meta)}>{Object.keys(r.meta ?? {}).length ? JSON.stringify(r.meta) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
