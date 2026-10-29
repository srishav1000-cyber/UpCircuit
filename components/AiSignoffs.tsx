'use client';

import { useEffect, useState } from 'react';
import type { AiSignoff, CloudClient } from '@/lib/cloud';
import { downloadText, toCsv } from '@/lib/csvOut';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** Compliance view of every human review of AI output: which model + prompt revision, which data classes, which exact text (SHA-256), who decided. */
export function AiSignoffs({ cloud }: { cloud: CloudClient }) {
  const [rows, setRows] = useState<AiSignoff[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { cloud.listSignoffs(200).then(setRows, (e) => setErr(e instanceof Error ? e.message : 'Could not load sign-offs')); }, [cloud]);
  const csv = () => downloadText(`ai-signoffs-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(['Signed (IST)', 'Kind', 'Symbol', 'Model', 'Prompt', 'Data used', 'Output SHA-256', 'Decision', 'Role', 'Note'], (rows ?? []).map((r) => [when(r.signed_at), r.kind, r.symbol, r.model, r.prompt_version, (r.data_used ?? []).join('; '), r.output_hash, r.decision, r.signer_role, r.note])));
  return (
    <section data-testid="ai-signoffs" aria-label="AI sign-offs">
      <div className="mb-2 flex items-center gap-2"><p className="text-[11px] text-muted">Human review records for AI-generated text. The hash identifies the exact text that was reviewed.</p><button onClick={csv} disabled={!rows?.length} className="ml-auto h-8 rounded-md border border-line px-3 text-[12px] font-semibold text-ink hover:bg-line disabled:opacity-40">⬇ CSV</button></div>
      {err && <div role="alert" className="mb-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[760px] text-left text-[12px]">
          <thead className="bg-line/40 text-[11px] uppercase tracking-wide text-muted"><tr>{['Signed (IST)', 'Output', 'Model · prompt', 'Data used', 'Decision', 'Reviewer', 'Hash'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {rows !== null && !rows.length && <tr><td colSpan={7} data-testid="ai-empty" className="px-3 py-6 text-center text-muted">No AI output has been signed off yet.</td></tr>}
            {(rows ?? []).map((r) => (
              <tr key={r.id} data-testid="ai-row" className="border-t border-line align-top">
                <td className="px-3 py-2 text-muted">{when(r.signed_at)}</td>
                <td className="px-3 py-2 text-ink">{r.kind}{r.symbol ? ` · ${r.symbol}` : ''}</td>
                <td className="px-3 py-2 text-muted">{r.model} · {r.prompt_version}</td>
                <td className="px-3 py-2 text-muted">{(r.data_used ?? []).join(', ')}</td>
                <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-[11px] font-bold ${r.decision === 'approved' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>{r.decision}</span>{r.note && <div className="mt-1 max-w-[200px] text-[11px] text-muted">“{r.note}”</div>}</td>
                <td className="px-3 py-2 text-muted">{r.signer_role}</td>
                <td className="px-3 py-2 font-mono text-[10px] text-muted" title={r.output_hash}>{r.output_hash.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
