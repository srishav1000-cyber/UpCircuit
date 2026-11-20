'use client';
// "Defense Walkthrough": a collapsible quick-jump bar for examiners — five checkpoints that scroll to and briefly outline each core contribution on the page,
// with the exact formulas and honest caveats beside it.
import { useEffect, useRef, useState } from 'react';
import { DEFENSE_CHECKPOINTS } from '@/lib/defenseGuide';

const GOLD = '#d4a64a';

/** scrolls to `id` and outlines it for a couple of seconds; returns false when the element is not on the page */
export function jumpTo(id: string, doc: Document = document): boolean {
  const el = doc.getElementById(id);
  if (!el) return false;
  el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  el.setAttribute('data-defense-highlight', 'on');
  const prev = { outline: el.style.outline, offset: el.style.outlineOffset };
  el.style.outline = `2px solid ${GOLD}`; el.style.outlineOffset = '3px';
  window.setTimeout(() => { el.style.outline = prev.outline; el.style.outlineOffset = prev.offset; el.removeAttribute('data-defense-highlight'); }, 2800);
  return true;
}

export function DefenseGuideDrawer({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [missing, setMissing] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [open]);
  const cp = DEFENSE_CHECKPOINTS[sel];
  const go = (i: number) => { setSel(i); setMissing(!jumpTo(DEFENSE_CHECKPOINTS[i].targetId)); };
  return (
    <div className={className} data-testid="defense-guide">
      <button ref={btn} type="button" aria-expanded={open} aria-controls="defense-guide-panel" data-testid="defense-toggle" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-white/[0.08]">
        <span aria-hidden style={{ color: GOLD }}>◆</span> Defense Walkthrough <span aria-hidden className="text-muted">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div id="defense-guide-panel" role="region" aria-label="Defense walkthrough" data-testid="defense-panel" className="mt-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[12px]">
          <ol className="flex flex-wrap gap-1.5" aria-label="Checkpoints">
            {DEFENSE_CHECKPOINTS.map((c, i) => (
              <li key={c.id}><button type="button" data-testid={`defense-cp-${c.n}`} aria-current={i === sel ? 'step' : undefined} onClick={() => go(i)} className={`rounded-lg border px-2.5 py-1 text-left text-[11px] font-semibold ${i === sel ? 'border-white/40 bg-white/[0.07] text-ink' : 'border-white/10 text-muted hover:text-ink'}`}><span className="num mr-1" style={{ color: GOLD }}>{c.n}</span>{c.title}</button></li>
            ))}
          </ol>
          <div className="mt-3" data-testid="defense-detail" data-cp={cp.id}>
            <h4 className="text-[13px] font-bold text-ink">{cp.n}. {cp.title}</h4>
            <p className="mt-1 text-muted">{cp.summary}</p>
            {missing && <p role="status" data-testid="defense-missing" className="mt-1 text-[11px]" style={{ color: GOLD }}>This section is not on the page right now (the desk is still loading).</p>}
            <h5 className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Formulas</h5>
            <ul className="space-y-1">{cp.formulas.map((f) => <li key={f} className="rounded bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-ink">{f}</li>)}</ul>
            <h5 className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Honest caveats</h5>
            <ul className="list-disc space-y-0.5 pl-4 text-muted">{cp.caveats.map((f) => <li key={f}>{f}</li>)}</ul>
            <div className="mt-2 flex gap-2">
              <button type="button" data-testid="defense-prev" disabled={sel === 0} onClick={() => go(sel - 1)} className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-ink disabled:opacity-40">← Previous</button>
              <button type="button" data-testid="defense-next" disabled={sel === DEFENSE_CHECKPOINTS.length - 1} onClick={() => go(sel + 1)} className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-ink disabled:opacity-40">Next →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
