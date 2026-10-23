'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FOCUS_KEY, FOCUS_SEEDED_KEY, WELCOME_KEY, initFocus, toggleFocus, type FocusResult } from '@/lib/focus';
import { scoped } from '@/lib/scope';
import { createSaver } from '@/lib/debouncedSaver';
import { ensureMigrated, useCloud, useCloudPull } from './useCloud';

const get = (k: string) => { try { return localStorage.getItem(scoped(k)); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(scoped(k), v); } catch { /* in-memory only */ } };

/** Per-user focus basket persisted to localStorage. New users (nothing saved) start with six NIFTY 50 blue-chips and a one-time welcome banner. */
export function useFocus() {
  const [focus, setFocus] = useState<string[]>([]);
  const [welcome, setWelcome] = useState(false);
  const { cloud, userId } = useCloud();
  const saver = useMemo(() => (cloud && userId ? createSaver<string[]>((v) => cloud.savePrefs(userId, { focus: v })) : null), [cloud, userId]);
  const cur = useRef<string[]>([]);
  cur.current = focus;
  useEffect(() => {
    const r = initFocus(get(FOCUS_KEY), get(FOCUS_SEEDED_KEY) !== null);
    setFocus(r.list);
    if (r.seeded) {
      put(FOCUS_KEY, JSON.stringify(r.list));
      put(FOCUS_SEEDED_KEY, '1');
      if (get(WELCOME_KEY) !== 'done') put(WELCOME_KEY, 'pending');
    }
    setWelcome(get(WELCOME_KEY) === 'pending');
  }, []);
  // signed in with Supabase: the focus basket follows the account across devices
  useCloudPull(!!(cloud && userId && saver), async () => {
    if (!cloud || !userId || !saver || saver.dirty()) return;
    await ensureMigrated(cloud, userId);
    const { focus: remote } = await cloud.loadPrefs(userId);
    if (!remote || !remote.length || saver.dirty()) return;
    const list = remote.map((x) => x.toUpperCase()).slice(0, 6);
    if (list.join() !== cur.current.join()) {
      setFocus(list);
      put(FOCUS_KEY, JSON.stringify(list));
      put(FOCUS_SEEDED_KEY, '1');
    }
    if (get(WELCOME_KEY) === 'pending' && get(FOCUS_KEY) !== null) { put(WELCOME_KEY, 'done'); setWelcome(false); } // a returning user on a new device
  });
  useEffect(() => {
    if (!saver) return;
    return () => void saver.flush();
  }, [saver]);
  const toggle = useCallback(
    (sym: string): FocusResult => {
      const r = toggleFocus(focus, sym);
      if (r.ok) {
        setFocus(r.list);
        put(FOCUS_KEY, JSON.stringify(r.list));
        put(FOCUS_SEEDED_KEY, '1');
        saver?.schedule(r.list);
      }
      return r;
    },
    [focus, saver],
  );
  const dismissWelcome = useCallback(() => {
    put(WELCOME_KEY, 'done');
    setWelcome(false);
  }, []);
  return { focus, toggle, welcome, dismissWelcome };
}
