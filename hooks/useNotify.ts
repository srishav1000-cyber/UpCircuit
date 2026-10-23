'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { createSaver } from '@/lib/debouncedSaver';
import { applyCloudNotify, attachNotifySaver, getNotify, loadNotifyLocal, serverNotify, setNotify, subscribeNotify } from '@/lib/notifyStore';
import { ensureMigrated, useCloud, useCloudPull } from './useCloud';

/** Current notification toggles ({push, email, audio}); `set` persists locally and (Supabase accounts) to preferences.notify. */
export function useNotify() {
  const prefs = useSyncExternalStore(subscribeNotify, getNotify, serverNotify);
  return { prefs, set: setNotify };
}

/** Mount once per page: loads this user's toggles and keeps them in sync with the cloud. */
export function useNotifySync(): void {
  const { user } = useAuth();
  const { cloud, userId } = useCloud();
  const uid = user?.id ?? null;
  const { prefs } = useNotify();
  useEffect(() => {
    if (uid) loadNotifyLocal();
  }, [uid]);
  // compact density = a smaller root font size (every rem-based Tailwind size follows)
  useEffect(() => {
    document.documentElement.dataset.density = prefs.density;
  }, [prefs.density]);
  const saver = useMemo(() => (cloud && userId ? createSaver((p: ReturnType<typeof getNotify>) => cloud.savePrefs(userId, { notify: p })) : null), [cloud, userId]);
  useEffect(() => {
    attachNotifySaver(saver ? (p) => saver.schedule(p) : null);
    return () => {
      attachNotifySaver(null);
      void saver?.flush();
    };
  }, [saver]);
  useCloudPull(!!(cloud && userId && saver), async () => {
    if (!cloud || !userId || !saver || saver.dirty()) return;
    await ensureMigrated(cloud, userId);
    const { notify } = await cloud.loadPrefs(userId);
    if (notify && !saver.dirty() && JSON.stringify(notify) !== JSON.stringify(getNotify())) applyCloudNotify(notify);
  });
}
