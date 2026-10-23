'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildIndex, searchInstruments } from '@/lib/fuzzy';
import type { Instrument } from '@/lib/types';

interface Props {
  /** the FULL master (8k names once synced), not a pre-suggested subset */
  instruments: Instrument[];
  /** add the stock; return an error message to show, or null/undefined on success */
  onAdd: (inst: Instrument) => string | null | undefined | Promise<string | null | undefined>;
  /** symbols already added: shown with a ✓ and not re-added */
  exclude?: ReadonlySet<string> | string[];
  placeholder?: string;
  testid: string;
  priceOf?: (symbol: string) => number | undefined;
  autoFocus?: boolean;
  /** extra fields rendered between the input and the + Add button (e.g. quantity / buy price) */
  children?: React.ReactNode;
  /** called with the highlighted stock as the user picks / types (lets a parent form show the chosen name) */
  onPick?: (inst: Instrument | null) => void;
  /** when true the dropdown pick only SELECTS the stock (a parent form submits later) */
  selectOnly?: boolean;
  addLabel?: string;
}

/**
 * Live autocomplete over the whole instrument master: symbol, company name, or BSE scrip code.
 * Enter adds the highlighted result (the exact ticker match ranks first); clicking a result adds it; "+ Add" adds the highlighted / exact match.
 */
export function StockAutocomplete({ instruments, onAdd, exclude, placeholder = 'Search any NSE / BSE stock…', testid, priceOf, autoFocus, children, onPick, selectOnly = false, addLabel = '+ Add' }: Props) {
  const index = useMemo(() => buildIndex(instruments), [instruments]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [chosen, setChosen] = useState<Instrument | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const lid = useId();
  const has = (s: string) => (Array.isArray(exclude) ? exclude.includes(s) : !!exclude?.has(s));
  const results = useMemo(() => (chosen ? [] : searchInstruments(index, q, 8)), [index, q, chosen]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const commit = async (inst: Instrument | undefined) => {
    if (!inst) return setMsg({ kind: 'err', text: q.trim() ? `No instrument matches “${q.trim()}”.` : 'Type a ticker, company name or BSE code first.' });
    if (selectOnly) {
      setChosen(inst);
      setQ(`${inst.symbol} — ${inst.name}`);
      setOpen(false);
      setMsg(null);
      onPick?.(inst);
      return;
    }
    if (has(inst.symbol)) return setMsg({ kind: 'err', text: `${inst.symbol} is already added.` });
    const err = await onAdd(inst);
    if (err) return setMsg({ kind: 'err', text: err });
    setMsg({ kind: 'ok', text: `Added ${inst.symbol}.` });
    setQ('');
    setOpen(false);
  };
  const target = chosen ?? results[active] ?? results[0];

  return (
    <div ref={wrap} className="relative" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <input
            value={q}
            autoFocus={autoFocus}
            onChange={(e) => { setQ(e.target.value); setChosen(null); onPick?.(null); setOpen(true); setMsg(null); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (!selectOnly || !chosen) void commit(results[active] ?? results[0]); }
              else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls={lid}
            aria-autocomplete="list"
            data-testid={`${testid}-input`}
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
          />
          {open && q.trim() && !chosen && (
            <ul id={lid} role="listbox" data-testid={`${testid}-results`} className="absolute left-0 right-0 top-full z-[70] mt-1 max-h-[280px] overflow-auto rounded-md border border-line bg-panel shadow-2xl shadow-black/60">
              {results.length === 0 && <li className="px-3 py-2 text-[12px] text-muted">No instruments match “{q}”</li>}
              {results.map((r, i) => (
                <li
                  key={r.symbol}
                  role="option"
                  aria-selected={i === active}
                  data-testid={`${testid}-opt-${r.symbol}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); void commit(r); }}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-[12px] ${i === active ? 'bg-line' : ''}`}
                >
                  <span className="min-w-0 truncate"><b className="text-ink">{r.symbol}</b> <span className="text-muted">· {r.name}</span></span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {has(r.symbol) && <span className="text-up" title="Already added">✓</span>}
                    <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] uppercase text-muted">{r.exch ?? 'NSE'}{r.code ? ` · ${r.code}` : ''}</span>
                    {priceOf && (() => { const p = priceOf(r.symbol); return <span className="num w-[64px] text-right font-semibold text-ink">{p ? `₹${p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</span>; })()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {children}
        <button type="button" onClick={() => void commit(target)} data-testid={`${testid}-add`} className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-bold text-white hover:opacity-90">{selectOnly ? 'Select' : addLabel}</button>
      </div>
      {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} data-testid={`${testid}-msg`} className={`mt-1 text-[11px] ${msg.kind === 'err' ? 'text-down' : 'text-up'}`}>{msg.text}</p>}
    </div>
  );
}
