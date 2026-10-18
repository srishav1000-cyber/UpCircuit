'use client';

import { useCallback, useEffect, useState } from 'react';
import { FOCUS_KEY, parseFocus, toggleFocus, type FocusResult } from '@/lib/focus';
import { scoped } from '@/lib/scope';

/** Per-user focus basket persisted to localStorage. */
export function useFocus() {
  const [focus, setFocus] = useState<string[]>([]);
  useEffect(() => {
    try {
      setFocus(parseFocus(localStorage.getItem(scoped(FOCUS_KEY))));
    } catch {
      /* ignore */
    }
  }, []);
  const toggle = useCallback(
    (sym: string): FocusResult => {
      const r = toggleFocus(focus, sym);
      if (r.ok) {
        setFocus(r.list);
        try {
          localStorage.setItem(scoped(FOCUS_KEY), JSON.stringify(r.list));
        } catch {
          /* in-memory only */
        }
      }
      return r;
    },
    [focus],
  );
  return { focus, toggle };
}
