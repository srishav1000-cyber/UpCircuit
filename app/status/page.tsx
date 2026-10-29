'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

interface Health { ok: boolean; time: string; version: string; database: string; dbMs: number | null; worker: { configured: boolean }; redis: { configured: boolean }; errorReporting: { configured: boolean } }
interface Ext { gemini?: { configured: boolean; valid: boolean | null; model: string }; smartapi?: { serverCreds: boolean; publicKeyConfigured: boolean } }

const Row = ({ name, state, note }: { name: string; state: 'ok' | 'warn' | 'down'; note?: string }) => (
  <li data-testid="status-row" data-state={state} className="flex items-center gap-3 px-4 py-3">
    <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${state === 'ok' ? 'bg-up' : state === 'warn' ? 'bg-warn' : 'bg-down'}`} />
    <span className="font-semibold text-ink">{name}</span>
    <span className="ml-auto text-[12px] text-muted">{note}</span>
  </li>
);

export default function StatusPage() {
  const [h, setH] = useState<Health | null>(null);
  const [x, setX] = useState<Ext>({});
  const [err, setErr] = useState(false);
  const load = useCallback(async () => {
    try { const r = await fetch('/api/health', { cache: 'no-store' }); setH((await r.json()) as Health); setErr(false); } catch { setErr(true); }
    try { setX((await (await fetch('/api/status', { cache: 'no-store' })).json()) as Ext); } catch { /* optional */ }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);
  const all = h?.ok && !err;
  return (
    <main className="mx-auto max-w-xl px-4 py-8 text-ink" data-testid="status-page">
      <Link href="/" className="text-[12px] text-accent hover:underline">← Back to UpCircuit</Link>
      <h1 className="mt-3 text-2xl font-bold">System status</h1>
      <p data-testid="status-summary" className={`mb-4 mt-1 text-[13px] font-semibold ${err ? 'text-down' : all ? 'text-up' : h ? 'text-down' : 'text-muted'}`}>{err ? 'Status service unreachable' : !h ? 'Checking…' : all ? 'All core systems operational' : 'Degraded — a core dependency is down'}</p>
      {h && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-panel text-[13px]">
          <Row name="Web app & API" state="ok" note={`version ${h.version}`} />
          <Row name="Database & sign-in (Supabase)" state={h.database === 'ok' ? 'ok' : h.database === 'down' ? 'down' : 'warn'} note={h.database === 'ok' ? `${h.dbMs} ms` : h.database === 'not_configured' ? 'demo mode (not configured)' : 'unreachable'} />
          <Row name="Live market feed (SmartAPI)" state={x.smartapi?.publicKeyConfigured ? 'ok' : 'warn'} note={x.smartapi?.publicKeyConfigured ? 'configured · connects from your browser' : 'not configured — delayed fallback data'} />
          <Row name="AI Copilot (Gemini)" state={x.gemini?.valid ? 'ok' : 'warn'} note={x.gemini?.configured ? (x.gemini.valid === false ? 'key rejected — local rules engine' : x.gemini.model) : 'local rules engine'} />
          <Row name="Alert worker" state={h.worker.configured ? 'ok' : 'warn'} note={h.worker.configured ? 'configured' : 'not configured'} />
          <Row name="Distributed rate limits (Redis)" state={h.redis.configured ? 'ok' : 'warn'} note={h.redis.configured ? 'Upstash' : 'in-memory fallback'} />
          <Row name="Error reporting" state={h.errorReporting.configured ? 'ok' : 'warn'} note={h.errorReporting.configured ? 'Sentry' : 'logs only'} />
        </ul>
      )}
      <p className="mt-3 text-[11px] text-muted">Checked {h ? new Date(h.time).toLocaleTimeString() : '—'} · refreshes every 30 s. Exchange sessions: NSE equities trade 09:15–15:30 IST, Mon–Fri.</p>
    </main>
  );
}
