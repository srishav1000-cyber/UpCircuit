'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { scoped } from '@/lib/scope';
import { addAlert, checkAlerts, parseAlerts, type AddResult, type PriceAlert } from '@/lib/alerts';

const BASE = 'upcircuit:alerts';

/** Price alerts persisted to localStorage. `evaluate` is called from the market tick loop. */
export function usePriceAlerts() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const ref = useRef<PriceAlert[]>([]);
  const hydrated = useRef(false);

  const commit = useCallback((next: PriceAlert[]) => {
    ref.current = next;
    setAlerts(next);
    try {
      localStorage.setItem(scoped(BASE), JSON.stringify(next));
    } catch {
      /* storage unavailable — alerts still work for this session */
    }
  }, []);

  useEffect(() => {
    try {
      const saved = parseAlerts(localStorage.getItem(scoped(BASE)));
      ref.current = saved;
      setAlerts(saved);
    } catch {
      /* ignore */
    }
    hydrated.current = true;
  }, []);

  const add = useCallback(
    (symbol: string, target: number, ltp: number): AddResult => {
      const r = addAlert(ref.current, symbol, target, ltp);
      if (r.ok) commit(r.alerts);
      return r;
    },
    [commit],
  );
  const remove = useCallback((id: string) => commit(ref.current.filter((a) => a.id !== id)), [commit]);
  const clearTriggered = useCallback(() => commit(ref.current.filter((a) => !a.triggeredAt)), [commit]);

  const evaluate = useCallback(
    (ltpOf: (symbol: string) => number | undefined): PriceAlert[] => {
      if (!hydrated.current || ref.current.length === 0) return [];
      const { alerts: next, fired } = checkAlerts(ref.current, ltpOf);
      if (fired.length) commit(next);
      return fired;
    },
    [commit],
  );

  return { alerts, add, remove, clearTriggered, evaluate };
}
