'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FOCUS_KEY, FOCUS_SEEDED_KEY, WELCOME_KEY, initFocus, normalizeFocus, toggleFocus, type FocusResult } from '@/lib/focus';
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
  // Hydration. Signed in with Supabase, the account's saved list is read BEFORE any starter stocks are seeded, so a fresh device / new
  // session can never overwrite a saved MY FOCUS list with the six defaults. A local list that the cloud does not have yet is pushed up.
  const hydrated = useRef(false);
  useEffect(() => {
    let alive = true;
    hydrated.current = false;                                        // new identity → rehydrate
    const finish = (r: { list: string[]; seeded: boolean }) => {
      if (!alive) return;
      if (hydrated.current && cur.current.length) return;           // the user already edited while we waited: keep their list
      setFocus(r.list);
      if (r.seeded) {
        put(FOCUS_KEY, JSON.stringify(r.list));
        put(FOCUS_SEEDED_KEY, '1');
        if (get(WELCOME_KEY) !== 'done') put(WELCOME_KEY, 'pending');
      }
      setWelcome(get(WELCOME_KEY) === 'pending');
      hydrated.current = true;
    };
    const local = () => initFocus(get(FOCUS_KEY), get(FOCUS_SEEDED_KEY) !== null);
    if (!cloud || !userId) { finish(local()); return () => { alive = false; }; }
    void (async () => {
      try {
        await ensureMigrated(cloud, userId);
        const { focus: remote } = await cloud.loadPrefs(userId);
        if (!alive) return;
        const saved = remote && remote.length ? normalizeFocus(remote) : [];
        if (saved.length) {                                          // the account list wins over defaults and over a stale local copy
          put(FOCUS_KEY, JSON.stringify(saved));
          put(FOCUS_SEEDED_KEY, '1');
          put(WELCOME_KEY, 'done');
          return finish({ list: saved, seeded: false });
        }
        const l = local();
        if (!l.seeded && l.list.length) void cloud.savePrefs(userId, { focus: l.list }).catch(() => undefined);   // local-only edits → account
        finish(l);
      } catch {
        finish(local());                                             // offline: local state; the next pull reconciles with the account
      }
    })();
    return () => { alive = false; };
  }, [cloud, userId]);
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
    const flush = () => void saver.flush();
    const hide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hide);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hide); flush(); };
  }, [saver]);
  const toggle = useCallback(
    (sym: string): FocusResult => {
      const r = toggleFocus(focus, sym);
      if (r.ok) {
        setFocus(r.list);
        put(FOCUS_KEY, JSON.stringify(r.list));
        put(FOCUS_SEEDED_KEY, '1');
        hydrated.current = true;
        saver?.schedule(r.list);
        void saver?.flush();                                         // sync to the account right away (not after the debounce)
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
