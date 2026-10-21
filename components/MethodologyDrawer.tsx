'use client';

import { useEffect, useRef } from 'react';
import { METHODOLOGY } from '@/lib/methodology';
import { DataBadges } from './DataBadge';

/** Right-hand audit drawer: every analytic's formula, inputs, window, data source and caveat. Esc or backdrop closes. */
export function MethodologyDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid="methodology-backdrop">
      <aside ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Methodology audit" data-testid="methodology-drawer" className="flex h-full w-full max-w-lg flex-col border-l border-line bg-panel text-ink outline-none">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-wider">Methodology audit</h2>
            <p className="text-[11px] text-muted">Formula, inputs and caveat behind each analytic. Not investment advice.</p>
          </div>
          <button onClick={onClose} aria-label="Close methodology" data-testid="methodology-close" className="rounded border border-line px-2 py-1 text-[12px] hover:bg-line/40">✕</button>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {METHODOLOGY.map((m) => (
            <article key={m.id} data-testid="method-entry" className="rounded-md border border-line bg-bg p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold">{m.name}</h3>
                <span className="text-[10px] uppercase tracking-wider text-muted">{m.lens}</span>
              </div>
              <p className="num mt-1.5 text-[11px] leading-relaxed text-ink">{m.formula}</p>
              <dl className="mt-2 space-y-0.5 text-[11px] text-muted">
                <div><dt className="inline font-semibold text-ink/80">Inputs: </dt><dd className="inline">{m.inputs}</dd></div>
                <div><dt className="inline font-semibold text-ink/80">Window: </dt><dd className="inline">{m.window}</dd></div>
                <div><dt className="inline font-semibold text-ink/80">Caveat: </dt><dd className="inline">{m.caveat}</dd></div>
              </dl>
              <div className="mt-2"><DataBadges kinds={m.source} /></div>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
