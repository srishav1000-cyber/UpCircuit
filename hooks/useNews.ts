'use client';

import { useEffect, useState } from 'react';
import type { NewsResponse } from '@/lib/types';

/** Polls /api/news every 5 minutes (the server caches for the same period). */
export function useNews() {
  const [news, setNews] = useState<NewsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/news');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = (await r.json()) as NewsResponse;
        if (alive) {
          setNews(j);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'failed');
      }
    };
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return { news, error, loading: news === null && error === null };
}
