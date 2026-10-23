'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { createCloud, type CloudClient } from '@/lib/cloud';
import { reportSync, setSyncAvailable } from '@/lib/syncStatus';
import { migrateLocalStorage, type MigrationReport } from '@/lib/migrateLocalStorage';

/** Supabase REST client for the signed-in user — null for demo accounts / guest / no Supabase (everything then stays local). */
export function useCloud(): { cloud: CloudClient | null; userId: string | null } {
  const { user, backend, getToken } = useAuth();
  const tok = useRef(getToken);
  tok.current = getToken;
  const id = user && user.id !== 'guest' ? user.id : null;
  const on = backend === 'supabase' && !!id;
  useEffect(() => {
    setSyncAvailable(on);
  }, [on]);
  return useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (backend !== 'supabase' || !id || !url || !anonKey) return { cloud: null, userId: null };
    return { cloud: createCloud({ url, anonKey, getToken: () => tok.current(), onResult: reportSync }), userId: id };
  }, [backend, id]);
}

const migrations = new Map<string, Promise<MigrationReport>>();
/** Runs the localStorage → Supabase migration once per user per page load; every data hook awaits it before reading the cloud. */
export function ensureMigrated(cloud: CloudClient, userId: string): Promise<MigrationReport> {
  let p = migrations.get(userId);
  if (!p) {
    p = migrateLocalStorage(cloud, userId, localStorage).catch(() => ({ holdings: 0, watchlistSymbols: 0, focus: 0, purged: [], errors: ['migration'], skipped: false }));
    migrations.set(userId, p);
  }
  return p;
}

/** Calls `pull` now, whenever the tab regains focus, and every `ms` — so a change made on another device shows up without a reload. */
export function useCloudPull(enabled: boolean, pull: () => void | Promise<void>, ms = 60_000): void {
  const ref = useRef(pull);
  ref.current = pull;
  useEffect(() => {
    if (!enabled) return;
    const run = () => void Promise.resolve(ref.current()).catch(() => undefined);
    run();
    const vis = () => document.visibilityState === 'visible' && run();
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', vis);
    const t = setInterval(run, ms);
    return () => {
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', vis);
      clearInterval(t);
    };
  }, [enabled, ms]);
}
