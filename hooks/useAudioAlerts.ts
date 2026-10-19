'use client';

import { useCallback, useEffect, useState } from 'react';
import { audioState, onAudioStateChange, playChime, unlockAudioContext, type AudioStateName } from '@/lib/chime';
import { scoped } from '@/lib/scope';

const KEY = 'upcircuit:audio:v1';

/** 🔔 Audio Alerts ON/OFF (per user, default ON). Browsers keep audio locked until a gesture, so the first click anywhere unlocks it. */
export function useAudioAlerts() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    try {
      const v = localStorage.getItem(scoped(KEY));
      if (v === '0') setOn(false);
    } catch {
      /* default ON */
    }
    const unlock = () => void unlockAudioContext();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  const toggle = useCallback(() => {
    void unlockAudioContext();
    setOn((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(scoped(KEY), next ? '1' : '0');
      } catch {
        /* in-memory only */
      }
      if (next) setTimeout(() => playChime('upper', 0.08), 50); // soft confirmation
      return next;
    });
  }, []);
  const [state, setState] = useState<AudioStateName>('running'); // assume fine until measured (no SSR flash)
  useEffect(() => {
    const sync = () => setState(audioState());
    sync();
    return onAudioStateChange(sync);
  }, []);
  /** true while the browser still blocks sound — show the "Click to Enable Live Audio Alerts" prompt */
  const locked = on && state === 'suspended';
  const unlock = useCallback(() => void unlockAudioContext(), []);
  return { on, toggle, locked, unlock };
}
