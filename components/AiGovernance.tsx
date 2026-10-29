'use client';

import { useState } from 'react';
import type { CloudClient } from '@/lib/cloud';
import { PROMPT_VERSION, sha256Hex } from '@/lib/aiGovernance';

export interface GovInfo { text: string; symbol?: string; model?: string; promptVersion?: string; dataUsed: string[] }

/** Provenance strip under an AI answer + human sign-off (approve / reject-with-note), recorded server-side with a hash of the exact text. */
export function AiGovernance({ info, cloud, canSign }: { info: GovInfo; cloud: CloudClient | null; canSign: boolean }) {
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'approved' | 'rejected' | 'error'>('idle');
  const [err, setErr] = useState('');
  const model = info.model ?? 'unknown';
  async function sign(decision: 'approved' | 'rejected') {
    if (!cloud) return;
    setState('busy');
    try {
      const outputHash = await sha256Hex(info.text);
      await cloud.signOffAi({ kind: 'copilot', symbol: info.symbol, model, promptVersion: info.promptVersion ?? PROMPT_VERSION, dataUsed: info.dataUsed, outputHash, decision, note: note.trim() || undefined });
      setState(decision); setRejecting(false);
    } catch (e) { setErr(e instanceof Error ? e.message.replace(/^cloud \d+: /, '') : 'Sign-off failed'); setState('error'); }
  }
  return (
    <div data-testid="ai-gov" className="mt-1.5 text-[10px] text-muted">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="ai-gov-toggle" className="underline decoration-dotted hover:text-ink">AI provenance{state === 'approved' ? ' · ✔ signed off' : state === 'rejected' ? ' · ✖ rejected' : ''}</button>
      {open && (
        <div className="mt-1 space-y-1 rounded border border-line bg-bg p-2">
          <div data-testid="ai-gov-model"><b>Model:</b> {model} · <b>Prompt:</b> {info.promptVersion ?? PROMPT_VERSION}</div>
          <div data-testid="ai-gov-data"><b>Data used:</b> {info.dataUsed.join(', ') || '—'}</div>
          <div>AI-generated; may be wrong or stale. Not investment advice.</div>
          {cloud && canSign && state !== 'approved' && state !== 'rejected' && (
            rejecting ? (
              <div className="flex flex-wrap items-center gap-1">
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Why is it rejected? (required)" aria-label="Rejection note" data-testid="ai-gov-note" className="h-7 min-w-[160px] flex-1 rounded border border-line bg-transparent px-2 text-[11px] text-ink outline-none focus:border-accent" />
                <button disabled={!note.trim() || state === 'busy'} onClick={() => void sign('rejected')} data-testid="ai-gov-reject-go" className="rounded bg-down px-2 py-1 font-bold text-white disabled:opacity-40">Reject</button>
                <button onClick={() => setRejecting(false)} className="rounded border border-line px-2 py-1">Cancel</button>
              </div>
            ) : (
              <div className="flex gap-1">
                <button disabled={state === 'busy'} onClick={() => void sign('approved')} data-testid="ai-gov-approve" className="rounded border border-up/50 bg-up/10 px-2 py-1 font-semibold text-up">Approve as reviewed</button>
                <button onClick={() => setRejecting(true)} data-testid="ai-gov-reject" className="rounded border border-down/50 bg-down/10 px-2 py-1 font-semibold text-down">Reject…</button>
              </div>
            )
          )}
          {cloud && !canSign && <div>Sign-off needs the Analyst role or above.</div>}
          {state === 'error' && <div role="alert" className="text-down">{err}</div>}
        </div>
      )}
    </div>
  );
}
