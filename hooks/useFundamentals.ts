'use client';

import { useEffect, useState } from 'react';
import type { LiveFundamentals } from '@/lib/yahooFundamentals';

type Entry = { data: LiveFundamentals | null; t: number };
const cache = new Map<string, Entry>();
const TTL_OK = 30 * 60_000;
const TTL_MISS = 2 * 60_000;
const fresh = (e?: Entry) => !!e && Date.now() - e.t < (e.data ? TTL_OK : TTL_MISS);

export type FundStatus = 'loading' | 'live' | 'none';

/** Real Yahoo Finance fundamentals for the inspected stock (via /api/fundamentals). `none` → the caller keeps its estimate. */
export function useFundamentals(symbol: string, exch: 'NSE' | 'BSE' = 'NSE'): { data: LiveFundamentals | null; status: FundStatus } {
  const key = `${symbol}:${exch}`;
  const [, bump] = useState(0);
  const cur = cache.get(key);
  useEffect(() => {
    if (fresh(cache.get(key))) return;
    const ac = new AbortController();
    fetch(`/api/fundamentals/${encodeURIComponent(symbol)}?exch=${exch}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => cache.set(key, { data: j?.ok ? (j.data as LiveFundamentals) : null, t: Date.now() }))
      .catch((e) => {
        if ((e as Error)?.name === 'AbortError') throw e;
        cache.set(key, { data: null, t: Date.now() });
      })
      .then(() => bump((n) => n + 1))
      .catch(() => {});
    return () => ac.abort();
  }, [key, symbol, exch]);
  const e = fresh(cur) ? cur : undefined;
  return { data: e?.data ?? null, status: !e ? 'loading' : e.data ? 'live' : 'none' };
}
