'use client';

import { useEffect, useState } from 'react';
import type { LiveFundamentals } from '@/lib/yahooFundamentals';

type Entry = { data: LiveFundamentals | null; t: number };
const cache = new Map<string, Entry>();
const TTL_OK = 30 * 60_000;
const TTL_MISS = 2 * 60_000;
const fresh = (e?: Entry) => !!e && Date.now() - e.t < (e.data ? TTL_OK : TTL_MISS);

/** Real fundamentals for up to 6 peer symbols (one /api/fundamentals call each, cached 30 min). Missing → null → "N/A". */
export function usePeerFundamentals(symbols: string[]): { data: Record<string, LiveFundamentals | null>; loading: boolean } {
  const key = symbols.slice(0, 6).join(',');
  const [, bump] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    const todo = key.split(',').filter(Boolean).filter((s) => !fresh(cache.get(s)));
    if (todo.length === 0) return;
    void Promise.all(
      todo.map((s) =>
        fetch(`/api/fundamentals/${encodeURIComponent(s)}?exch=NSE`, { signal: ac.signal })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => { cache.set(s, { data: j?.ok ? (j.data as LiveFundamentals) : null, t: Date.now() }); })
          .catch(() => { if (!ac.signal.aborted) cache.set(s, { data: null, t: Date.now() }); }),
      ),
    ).then(() => { if (!ac.signal.aborted) bump((n) => n + 1); });
    return () => ac.abort();
  }, [key]);
  const data: Record<string, LiveFundamentals | null> = {};
  let loading = false;
  for (const s of key.split(',').filter(Boolean)) {
    const e = cache.get(s);
    if (!fresh(e)) loading = true;
    data[s] = e?.data ?? null;
  }
  return { data, loading };
}
