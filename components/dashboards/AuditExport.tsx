'use client';
// "Export Surveillance Audit Pack (JSON + Printable Report)": gathers what the desk is showing right now plus the account's alert/daemon state, builds the dossier
// (lib/auditDossier.ts), downloads the JSON and opens a clean printable page (Print → Save as PDF). Nothing is sent anywhere; secrets are redacted in buildDossier.
import { useState } from 'react';
import { FileDown } from 'lucide-react';
import type { CloudClient } from '@/lib/cloud';
import { isMarketOpen, type MarketEngine } from '@/lib/market';
import { readAck } from '@/lib/disclosure';
import { buildDossier, dossierFileName, dossierToHtml, sealDossier, type DossierInput } from '@/lib/auditDossier';
import { slippageReport, defaultQty } from '@/lib/analytics/slippage';
import { expectedVolume, type IntradayProfile } from '@/lib/volumeBaseline';
import type { DepthFlag } from '@/lib/heuristicFlags';
import type { FeedHealthStatusProps } from './FeedHealthStatus';

type FlagIn = DossierInput['flags'][number];
export interface AuditExportProps {
  engine: MarketEngine; symbol: string; feed: FeedHealthStatusProps; cloud?: CloudClient | null;
  flags: (DepthFlag & { source?: string })[];
  profile: IntradayProfile | null; surge15: number | null; className?: string;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function AuditExport({ engine, symbol, feed, cloud = null, flags, profile, surge15, className = '' }: AuditExportProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const now = Date.now();
      const safe = async <T,>(p: Promise<T> | undefined, d: T): Promise<T> => { try { return p ? await p : d; } catch { return d; } };
      const [session, daemon, rules, quiet, deliveries, bt] = await Promise.all([
        safe(cloud?.sessionInfo(), null), safe(cloud?.daemonHealthAll(), null), safe(cloud?.listRules(), []),
        safe(cloud?.getQuietHours(), null), safe(cloud?.listDeliveries(50), []),
        fetch('/backtest-heuristics.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const q = engine.quotes.get(symbol) ?? null;
      const live = engine.depthReal && isMarketOpen(now);
      const ev = q && q.volume > 0 ? expectedVolume(profile, null, now) : null;
      const rep = live && q ? slippageReport({ bids: engine.depth.bids, asks: engine.depth.asks, side: 'sell', qty: defaultQty(q.ltp), ltp: q.ltp, upperCircuit: q.upperCircuit, lowerCircuit: q.lowerCircuit, bandKnown: q.bandKnown, marketOpen: true }) : null;
      const input: DossierInput = {
        now, session: session ?? null,
        disclosureAcknowledged: !!session?.userId && readAck(session.userId, session.sessionId ?? ''),
        feed: { mode: feed.mode, connection: feed.conn, lastTickAgeMs: feed.getLastTickAt() > 0 ? now - feed.getLastTickAt() : null },
        daemon: cloud ? (daemon as DossierInput['daemon']) : null,
        rules: rules as DossierInput['rules'], quietHours: quiet, deliveries: deliveries as DossierInput['deliveries'],
        symbol, ltp: q?.ltp ?? null, depth: { bids: engine.depth.bids, asks: engine.depth.asks, live },
        volume: { cumulative: q?.volume ?? null, expectedByNow: ev?.expected ?? null, multiple: ev && q && q.volume > 0 ? q.volume / ev.expected : null, surge15, profileSessions: profile?.sessions ?? null },
        exitRisk: rep && rep.status === 'ok' ? rep.exit : null,
        flags: flags.map((f): FlagIn => ({ symbol: f.symbol, kind: f.kind, side: f.side, severity: f.severity, ts: f.ts, detail: f.detail, label: f.label, confirmation: f.confirmation ?? null, source: f.source })),
        backtest: bt,
      };
      const sealed = await sealDossier(buildDossier(input));
      download(dossierFileName(now), JSON.stringify(sealed, null, 2), 'application/json');
      const w = window.open('', '_blank');
      if (w) {
        w.document.open(); w.document.write(dossierToHtml(sealed)); w.document.close();
        w.document.getElementById('print')?.addEventListener('click', () => w.print());   // no inline script: the opener wires the button
        setMsg('JSON downloaded; the printable report opened in a new tab (Print → Save as PDF).');
      } else setMsg('JSON downloaded. Allow pop-ups to open the printable report.');
    } catch { setMsg('Could not build the audit pack.'); }
    finally { setBusy(false); }
  }

  return (
    <div className={className} data-testid="audit-export">
      <button type="button" onClick={run} disabled={busy} data-testid="audit-export-btn" className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-white/[0.08] disabled:opacity-50">
        <FileDown size={14} aria-hidden /> Export Surveillance Audit Pack (JSON + Printable Report)
      </button>
      {msg && <p role="status" data-testid="audit-export-msg" className="mt-1 text-[11px] text-muted">{msg}</p>}
      <p className="mt-1 text-[10px] text-muted">A white-box record of rules, formulas and readings — not investment advice, and not a statement of regulatory compliance.</p>
    </div>
  );
}
