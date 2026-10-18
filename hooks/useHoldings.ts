'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Holding } from '@/lib/types';
import { scoped } from '@/lib/scope';

const BASE = 'upcircuit:holdings:v1';

const valid = (x: unknown): x is Holding =>
  !!x && typeof (x as Holding).symbol === 'string' && Number.isFinite((x as Holding).qty) && (x as Holding).qty > 0 && Number.isFinite((x as Holding).avg) && (x as Holding).avg > 0;

/** Portfolio state persisted to localStorage (imports survive a refresh). */
export function useHoldings(demo: Holding[]) {
  const [holdings, setState] = useState<Holding[]>(demo);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(scoped(BASE));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(valid)) setState(parsed);
    } catch {
      /* storage blocked or corrupt — keep the demo portfolio */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback((next: Holding[] | ((cur: Holding[]) => Holding[])) => {
    setState((cur) => {
      const value = typeof next === 'function' ? next(cur) : next;
      try {
        localStorage.setItem(scoped(BASE), JSON.stringify(value));
      } catch {
        /* ignore */
      }
      return value;
    });
  }, []);

  const reset = useCallback(() => set(demo), [set, demo]);
  return { holdings, setHoldings: set, resetHoldings: reset };
}
