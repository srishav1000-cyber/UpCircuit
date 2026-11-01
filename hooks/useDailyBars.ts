'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/authBus';
import type { Bar } from '@/lib/chartScanner';

const istDay = (ms: number) => Math.floor((ms / 1000 + 19800) / 86400);
/** Real daily bars (/api/bars, 1Y) for a symbol, refreshed every 5 min. While the stream is live and the last bar IS today, the live LTP is folded into that bar (never invents one). */
export function useDailyBars(symbol: string, ltp: number, live: boolean) {
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [err, setErr] = useState('');
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    let dead = false; setBars(null); setErr('');
    const load = async () => {
      try { const r = await apiFetch(`/api/bars/${encodeURIComponent(symbol)}?tf=1Y`); const j = (await r.json()) as { ok?: boolean; bars?: Bar[] }; if (dead) return; if (j.ok && j.bars) { setBars(j.bars); setStamp(Date.now()); } else setErr('No daily history available for this scrip.'); }
      catch { if (!dead) setErr('Could not load daily history.'); }
    };
    void load(); const iv = setInterval(load, 5 * 60_000); return () => { dead = true; clearInterval(iv); };
  }, [symbol]);
  const ok = live && Number.isFinite(ltp) && ltp > 0;
  const series = useMemo(() => {
    if (!bars?.length) return null; const last = bars[bars.length - 1];
    if (!ok || Math.floor(last.time / 86400) !== istDay(Date.now())) return bars;
    return [...bars.slice(0, -1), { ...last, close: ltp, high: Math.max(last.high, ltp), low: Math.min(last.low, ltp) }];
  }, [bars, ok, ltp]);
  /** index of the last COMPLETED session: the final bar, unless the final bar is today's still-forming one */
  const prevIdx = series ? (Math.floor(series[series.length - 1].time / 86400) === istDay(Date.now()) && ok ? series.length - 2 : series.length - 1) : -1;
  return { series, err, stamp, live: ok, prevIdx };
}
