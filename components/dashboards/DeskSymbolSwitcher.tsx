'use client';
// Inline symbol switcher for the Surveillance Desk: change the stock whose depth, OBI and R(t) are shown without going back to the main search bar.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildIndex, searchInstruments } from '@/lib/fuzzy';
import type { Instrument } from '@/lib/types';

export function DeskSymbolSwitcher({ instruments, symbol, onSwitch, className = '' }: { instruments: Instrument[]; symbol: string; onSwitch: (symbol: string) => void; className?: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const index = useMemo(() => buildIndex(instruments), [instruments]);
  const results = useMemo(() => (q.trim() ? searchInstruments(index, q, 6) : []), [index, q]);
  useEffect(() => setAct(0), [q]);
  useEffect(() => { const f = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', f); return () => document.removeEventListener('mousedown', f); }, []);
  const pick = (s: string) => { onSwitch(s); setQ(''); setOpen(false); };
  return (
    <div ref={wrap} className={`relative ${className}`} data-testid="desk-switcher">
      <label className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-2 py-1 text-[12px]">
        <span className="text-muted">Stock</span>
        <b className="text-ink" data-testid="desk-switcher-current">{symbol}</b>
        <input
          value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAct((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAct((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && results[act]) { e.preventDefault(); pick(results[act].symbol); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Switch symbol…" aria-label="Switch the surveillance desk symbol" role="combobox" aria-expanded={open && results.length > 0} aria-controls="desk-switcher-list" autoComplete="off" data-testid="desk-switcher-input"
          className="w-32 min-w-0 bg-transparent text-ink outline-none placeholder:text-muted sm:w-40"
        />
      </label>
      {open && q.trim() && (
        <ul id="desk-switcher-list" role="listbox" data-testid="desk-switcher-list" className="absolute left-0 top-full z-30 mt-1 max-h-64 w-72 overflow-auto rounded-lg border border-white/15 bg-[#0b1220] py-1 shadow-2xl">
          {results.length ? results.map((r, i) => (
            <li key={r.symbol} role="option" aria-selected={i === act}><button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r.symbol)} className={`flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-[12px] ${i === act ? 'bg-white/10' : ''}`}><b className="text-ink">{r.symbol}</b><span className="min-w-0 truncate text-[11px] text-muted">{r.name}</span></button></li>
          )) : <li className="px-3 py-2 text-[12px] text-muted">No match</li>}
        </ul>
      )}
    </div>
  );
}
