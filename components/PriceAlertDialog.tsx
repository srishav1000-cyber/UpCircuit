'use client';

import { useEffect, useRef, useState } from 'react';
import type { PriceAlert } from '@/lib/alerts';
import { fmt } from '@/lib/format';
import { roundTick } from '@/lib/market';

interface Props {
  symbol: string;
  ltp: number;
  alerts: PriceAlert[];
  onAdd: (target: number) => string | null;
  onRemove: (id: string) => void;
  onClearTriggered: () => void;
  onClose: () => void;
}

const STEPS = [-5, -2, 2, 5];

/** 🔔 Set Price Alert — fires a toast when LTP reaches the level while UpCircuit is open. */
export function PriceAlertDialog({ symbol, ltp, alerts, onAdd, onRemove, onClearTriggered, onClose }: Props) {
  const [text, setText] = useState(() => roundTick(ltp * 1.02).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const target = Number(text.replace(/,/g, ''));
  const valid = Number.isFinite(target) && target > 0;
  const rel = valid ? ((target / ltp - 1) * 100) : null;
  const mine = alerts.filter((a) => a.symbol === symbol);
  const others = alerts.filter((a) => a.symbol !== symbol && !a.triggeredAt).length;
  const triggered = alerts.filter((a) => a.triggeredAt).length;

  const submit = () => {
    const err = onAdd(target);
    setError(err);
    if (!err) setText(roundTick(ltp * 1.02).toFixed(2));
  };

  return (
    <div data-overlay className="fixed inset-0 z-[85] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={`Price alert for ${symbol}`} onMouseDown={(e) => e.stopPropagation()} className="flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-xl border border-line bg-panel shadow-2xl sm:rounded-xl">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-[15px] font-bold text-ink">🔔 Set Price Alert · {symbol}</h2>
            <p className="num text-[12px] text-muted">Current price ₹{fmt(ltp)}</p>
          </div>
          <button onClick={onClose} aria-label="Close (Esc)" className="flex h-8 w-8 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
        </div>

        <form
          className="space-y-3 overflow-y-auto px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Alert me when the price reaches</span>
            <div className="mt-1 flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent">
              <span className="text-muted">₹</span>
              <input ref={input} value={text} onChange={(e) => { setText(e.target.value.replace(/[^\d.,]/g, '').slice(0, 12)); setError(null); }} inputMode="decimal" aria-label="Target price" className="num h-10 flex-1 bg-transparent px-2 text-[16px] text-ink outline-none" />
            </div>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {STEPS.map((s) => (
              <button key={s} type="button" onClick={() => { setText(roundTick(ltp * (1 + s / 100)).toFixed(2)); setError(null); }} className={`num rounded-full border border-line px-2.5 py-1 text-[11px] hover:border-accent hover:text-accent ${s > 0 ? 'text-up' : 'text-down'}`}>
                {s > 0 ? '+' : '−'}{Math.abs(s)}%
              </button>
            ))}
          </div>
          <p className="text-[12px] text-muted" aria-live="polite">
            {valid && rel !== null && Math.abs(target - ltp) >= 0.005
              ? <>Fires when {symbol} rises to / falls to <b className="num text-ink">₹{fmt(target)}</b> ({rel > 0 ? '+' : '−'}{Math.abs(rel).toFixed(2)}% from now, {target > ltp ? 'upward' : 'downward'} cross).</>
              : 'Enter a price above or below the current price.'}
          </p>
          {error && <p role="alert" className="rounded border border-down/40 bg-down/10 px-2.5 py-1.5 text-[12px] text-down">{error}</p>}
          <button type="submit" disabled={!valid} className="h-10 w-full rounded-md bg-accent text-[13px] font-bold text-white hover:brightness-110 disabled:opacity-40">Set alert</button>
          <p className="text-[10px] text-muted">Alerts are stored in this browser and fire only while UpCircuit is open — no push, SMS or email. Prices are real; see the feed badge for the current source.</p>
        </form>

        <div className="max-h-48 overflow-y-auto border-t border-line px-4 py-2" data-testid="alert-list">
          <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted">
            <span>{symbol} alerts</span>
            {triggered > 0 && <button onClick={onClearTriggered} className="normal-case text-accent hover:underline">Clear {triggered} triggered</button>}
          </div>
          {mine.length === 0 ? (
            <p className="py-1 text-[12px] text-muted">None yet.{others > 0 ? ` (${others} active on other stocks)` : ''}</p>
          ) : (
            <ul className="space-y-1">
              {mine.map((a) => (
                <li key={a.id} className="num flex items-center justify-between rounded border border-line bg-bg px-2.5 py-1.5 text-[12px]">
                  <span className={a.triggeredAt ? 'text-muted line-through' : 'text-ink'}>{a.dir === 'above' ? '≥' : '≤'} ₹{fmt(a.target)}</span>
                  <span className="flex items-center gap-2">
                    {a.triggeredAt && <span className="text-[10px] text-warn">fired @ ₹{fmt(a.triggeredPrice ?? a.target)}</span>}
                    <button onClick={() => onRemove(a.id)} aria-label={`Remove alert ${fmt(a.target)}`} className="text-muted hover:text-down">✕</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
