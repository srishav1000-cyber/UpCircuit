'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Holding } from '@/lib/types';
import { scoped } from '@/lib/scope';
import { HOLDINGS_BASE, validHolding } from '@/lib/holdingsStore';
import { createSaver } from '@/lib/debouncedSaver';
import { ensureMigrated, useCloud, useCloudPull } from './useCloud';

const BASE = HOLDINGS_BASE;
const same = (a: Holding[], b: Holding[]) => a.length === b.length && a.every((h, i) => h.symbol === b[i].symbol && h.qty === b[i].qty && h.avg === b[i].avg);

/**
 * Portfolio state. Signed in with Supabase: the account's `portfolios` rows are the source of truth (synced across devices, refreshed on focus
 * and every minute); localStorage is only an offline cache. Otherwise (demo accounts / guest) it is localStorage as before.
 */
export function useHoldings(demo: Holding[]) {
  const [holdings, setState] = useState<Holding[]>(demo);
  const { cloud, userId } = useCloud();
  const cur = useRef(holdings);
  cur.current = holdings;

  const saver = useMemo(() => (cloud && userId ? createSaver<Holding[]>((v) => cloud.savePortfolio(userId, v)) : null), [cloud, userId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(scoped(BASE));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(validHolding)) setState(parsed);
    } catch {
      /* storage blocked or corrupt — keep the demo portfolio */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cache = (value: Holding[]) => {
    try { localStorage.setItem(scoped(BASE), JSON.stringify(value)); } catch { /* ignore */ }
  };

  useCloudPull(!!(cloud && userId && saver), async () => {
    if (!cloud || !userId || !saver || saver.dirty()) return; // never overwrite an edit that has not reached the cloud
    const rep = await ensureMigrated(cloud, userId);
    const rows = await cloud.loadPortfolio(userId);
    if (saver.dirty()) return;
    if (rows.length) {
      if (!same(rows, cur.current)) { setState(rows); cache(rows); }
    } else if (!rep.errors.length && !same(cur.current, demo)) {
      setState(demo); // emptied / reset on another device
      cache(demo);
    }
  });

  useEffect(() => {
    if (!saver) return;
    const hide = () => void saver.flush();
    window.addEventListener('pagehide', hide);
    return () => {
      window.removeEventListener('pagehide', hide);
      void saver.flush();
    };
  }, [saver]);

  const set = useCallback((next: Holding[] | ((cur: Holding[]) => Holding[])) => {
    const value = typeof next === 'function' ? next(cur.current) : next;
    cur.current = value;
    setState(value);
    cache(value);
    saver?.schedule(value);
  }, [saver]);

  const reset = useCallback(() => set(demo), [set, demo]);
  return { holdings, setHoldings: set, resetHoldings: reset };
}
