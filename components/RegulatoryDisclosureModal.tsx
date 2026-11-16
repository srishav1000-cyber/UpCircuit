'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { DISCLOSURE_POINTS, DISCLOSURE_VERSION, readAck, saveMetadataAck, sessionStamp, writeAck } from '@/lib/disclosure';

/** Blocking Regulatory & Risk Disclosure, shown right after sign-in until accepted (no Esc / backdrop dismissal). */
export function RegulatoryDisclosureModal() {
  const { user, backend, getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const id = user?.id ?? null;

  const [stamp, setStamp] = useState<string | null>(null);        // the login session (null while it is being read)

  // every login / fresh browser session starts un-acknowledged; the acknowledgement is only valid for this user AND this login session
  useEffect(() => {
    if (!id) { setStamp(null); return setOpen(false); }
    let alive = true;
    void getToken().catch(() => null).then((t) => {
      if (!alive) return;
      const st = sessionStamp(t);
      setStamp(st);
      setOpen(!readAck(id, st));
    });
    return () => { alive = false; };
  }, [id, getToken]);

  useEffect(() => { if (open) btn.current?.focus(); }, [open]);
  if (!open || !id || stamp === null) return null;

  const accept = () => {
    writeAck(id, stamp);
    setOpen(false);
    if (backend === 'supabase' && id !== 'guest') void getToken().then((t) => (t ? saveMetadataAck(t) : false)).catch(() => undefined);
  };
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-3" data-testid="disclosure-backdrop">
      <div role="alertdialog" aria-modal="true" aria-labelledby="disclosure-title" aria-describedby="disclosure-body" data-testid="disclosure-modal" data-version={DISCLOSURE_VERSION}
        onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault(); }}
        className="w-full max-w-[560px] rounded-lg border border-line bg-panel p-5 shadow-2xl">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">Before you continue</p>
        <h2 id="disclosure-title" className="mt-1 text-lg font-bold text-ink">Regulatory &amp; Risk Disclosure</h2>
        <ul id="disclosure-body" className="mt-3 space-y-2.5 text-[13px] leading-relaxed text-ink">
          {DISCLOSURE_POINTS.map((p, i) => (
            <li key={i} className="flex gap-2"><span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /><span>{p}</span></li>
          ))}
        </ul>
        <button ref={btn} type="button" onClick={accept} data-testid="disclosure-accept" className="mt-5 w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent/60">I Understand &amp; Accept</button>
      </div>
    </div>
  );
}
