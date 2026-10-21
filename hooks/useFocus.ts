'use client';

import { useCallback, useEffect, useState } from 'react';
import { FOCUS_KEY, FOCUS_SEEDED_KEY, WELCOME_KEY, initFocus, toggleFocus, type FocusResult } from '@/lib/focus';
import { scoped } from '@/lib/scope';

const get = (k: string) => { try { return localStorage.getItem(scoped(k)); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(scoped(k), v); } catch { /* in-memory only */ } };

/** Per-user focus basket persisted to localStorage. New users (nothing saved) start with six NIFTY 50 blue-chips and a one-time welcome banner. */
export function useFocus() {
  const [focus, setFocus] = useState<string[]>([]);
  const [welcome, setWelcome] = useState(false);
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
  const toggle = useCallback(
    (sym: string): FocusResult => {
      const r = toggleFocus(focus, sym);
      if (r.ok) {
        setFocus(r.list);
        put(FOCUS_KEY, JSON.stringify(r.list));
        put(FOCUS_SEEDED_KEY, '1');
      }
      return r;
    },
    [focus],
  );
  const dismissWelcome = useCallback(() => {
    put(WELCOME_KEY, 'done');
    setWelcome(false);
  }, []);
  return { focus, toggle, welcome, dismissWelcome };
}
