'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { buildIndex, searchInstruments } from '@/lib/fuzzy';
import type { Instrument } from '@/lib/types';

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-bold text-accent">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

interface Props {
  instruments: Instrument[];
  onSelect: (symbol: string) => void;
  inputRef: RefObject<HTMLInputElement>;
  /** live LTP for a symbol (only called for the few visible results) */
  priceOf?: (symbol: string) => number | undefined;
}

export function SearchBox({ instruments, onSelect, inputRef, priceOf }: Props) {
  const index = useMemo(() => buildIndex(instruments), [instruments]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchInstruments(index, q, 8), [index, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = (i: Instrument) => {
    onSelect(i.symbol);
    setQ('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault(); // otherwise the keypress lands on whatever the selection focuses next (e.g. a modal's close button)
      pick(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const show = open && q.trim().length > 0;

  return (
    <div ref={wrap} className="relative w-full min-w-0 max-w-[420px]">
      <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-3 py-1.5 focus-within:border-accent">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={`Search ${instruments.length.toLocaleString('en-IN')} stocks (NSE + BSE)…`}
          className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
          role="combobox"
          aria-expanded={show}
          aria-controls="search-results"
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
        />
        <kbd>/</kbd>
      </div>

      {show && (
        <ul id="search-results" role="listbox" className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[360px] overflow-auto rounded-md border border-line bg-panel shadow-2xl shadow-black/60">
          {results.length === 0 && <li className="px-3 py-3 text-[13px] text-muted">No instruments match “{q}”</li>}
          {results.map((r, i) => (
            <li
              key={r.symbol}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 ${i === active ? 'bg-line' : ''}`}
            >
              <div className="min-w-0 text-[13px]">
                <span className="font-semibold text-ink">
                  <Highlight text={r.symbol} q={q} />
                </span>
                <span className="text-muted"> - </span>
                <span className="text-muted">
                  <Highlight text={r.name} q={q} />
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{r.exch ?? 'NSE'}{r.sector !== 'Others' ? ` · ${r.sector}` : ''}</span>
                {priceOf && <span className="num w-[68px] text-right text-[12px] font-semibold text-ink">{(() => { const p = priceOf(r.symbol); return p ? `₹${p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; })()}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
