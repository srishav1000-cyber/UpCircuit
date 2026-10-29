'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { rank, type Command } from '@/lib/palette';

interface Props { open: boolean; onClose: () => void; commands: Command[]; /** extra, query-dependent commands (e.g. matching stocks) */ dynamic?: (q: string) => Command[]; /** when set, the input collects a name and calls this on Enter */ namePrompt?: { label: string; onSubmit: (name: string) => void } | null }

/** Ctrl/Cmd+K launcher: type to filter, ↑↓ to move, Enter to run, Esc to close. ARIA combobox + listbox; focus returns to the opener. */
export function CommandPalette({ open, onClose, commands, dynamic, namePrompt }: Props) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => { if (open) { opener.current = document.activeElement; setQ(''); setIdx(0); input.current?.focus(); } else (opener.current as HTMLElement | null)?.focus?.(); }, [open]);
  const list = useMemo(() => (namePrompt ? [] : rank([...(dynamic?.(q) ?? []), ...commands], q)), [commands, dynamic, q, namePrompt]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }; document.addEventListener('keydown', h, true); return () => document.removeEventListener('keydown', h, true); }, [open, onClose]);
  if (!open) return null;
  const run = (c: Command) => { c.run(); if (!c.keepOpen) onClose(); };
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-slate-950/60 px-3 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-overlay="palette">
      <div role="dialog" aria-modal="true" aria-label="Command palette" data-testid="palette" className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <input
          ref={input} value={q} onChange={(e) => setQ(e.target.value)}
          role="combobox" aria-expanded={!namePrompt} aria-controls="palette-list" aria-activedescendant={list[idx] ? `pal-${list[idx].id}` : undefined} aria-label={namePrompt ? namePrompt.label : 'Type a command or a stock symbol'}
          placeholder={namePrompt ? namePrompt.label : 'Type a command or a stock symbol…'} data-testid="palette-input" autoComplete="off" spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Tab') e.preventDefault(); // modal: focus stays in the input
            else if (namePrompt && e.key === 'Enter') { e.preventDefault(); if (q.trim()) { namePrompt.onSubmit(q.trim()); onClose(); } }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(list.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter' && list[idx]) { e.preventDefault(); run(list[idx]); }
          }}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[14px] text-ink outline-none placeholder:text-muted"
        />
        <ul id="palette-list" role="listbox" aria-label="Commands" className="max-h-[50vh] overflow-y-auto py-1">
          {namePrompt && <li className="px-4 py-3 text-[12px] text-muted">Press Enter to save · Esc to cancel</li>}
          {!namePrompt && !list.length && <li data-testid="palette-empty" className="px-4 py-6 text-center text-[12px] text-muted">No matching command.</li>}
          {list.map((c, i) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <li key={c.id} role="presentation">
                {head && <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{head}</div>}
                <div id={`pal-${c.id}`} role="option" aria-selected={i === idx} data-testid="palette-item" onMouseEnter={() => setIdx(i)} onClick={() => run(c)} className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-[13px] ${i === idx ? 'bg-accent/15 text-ink' : 'text-ink'}`}>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="shrink-0 text-[11px] text-muted">{c.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-4 border-t border-line px-4 py-1.5 text-[10px] text-muted"><span>↑↓ move</span><span>↵ run</span><span>esc close</span></div>
      </div>
    </div>
  );
}
