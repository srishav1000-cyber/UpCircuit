'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useCloud, ensureMigrated } from '@/hooks/useCloud';
import { createSaver } from '@/lib/debouncedSaver';
import { getUi, getUiServer, hydrateUi, onUiChange, patchUi, readLocalUi, resetUi, subscribeUi, writeLocalUi } from '@/lib/uiStore';
import { pickNewer } from '@/lib/uiPrefs';

/** read the synced UI preferences (timeframe, indicator toggles) anywhere */
export function useUi() {
  return [useSyncExternalStore(subscribeUi, getUi, getUiServer), patchUi] as const;
}

/**
 * Mount ONCE (in the terminal). Hydrates from this device, then from the account — the newer copy wins and untouched defaults never overwrite a saved
 * choice — and saves every user edit to Supabase (debounced, flushed when the tab is hidden).
 */
export function useUiSync() {
  const { cloud, userId } = useCloud();
  useEffect(() => {
    let alive = true;
    const local = readLocalUi();
    hydrateUi(pickNewer(local, null).value);
    if (!cloud || !userId) return () => { alive = false; resetUi(); };
    const saver = createSaver((v: ReturnType<typeof getUi>) => cloud.saveUi(userId, v), 700);
    const off = onUiChange((s) => saver.schedule(s));
    void (async () => {
      try {
        await ensureMigrated(cloud, userId);
        const remote = await cloud.loadUi(userId);
        if (!alive) return;
        if (saver.dirty()) return;                                   // the user edited while we were loading: keep their edit (it is already scheduled)
        const r = pickNewer(readLocalUi(), remote);
        hydrateUi(r.value);
        if (r.source === 'cloud') writeLocalUi(r.value);
        if (r.pushLocal) saver.schedule(r.value);
      } catch { /* offline: the local copy stays; the next change retries */ }
    })();
    const flush = () => void saver.flush();
    const hide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hide);
    return () => { alive = false; off(); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hide); flush(); resetUi(); };
  }, [cloud, userId]);
}
