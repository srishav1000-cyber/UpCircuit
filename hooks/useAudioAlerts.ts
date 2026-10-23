'use client';

import { useCallback, useEffect, useState } from 'react';
import { audioState, onAudioStateChange, unlockAudioContext, type AudioStateName } from '@/lib/chime';
import { playChime } from '@/lib/audioAlerts';
import { useNotify } from './useNotify';

/**
 * 🔔 Audio Alarm Chimes ON/OFF — the `audio` toggle of the notification settings (per user, default ON, synced to the account).
 * Browsers keep audio locked until a gesture, so the first click anywhere unlocks it.
 */
export function useAudioAlerts() {
  const { prefs, set } = useNotify();
  const on = prefs.audio;
  useEffect(() => {
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
    const next = !on;
    set({ audio: next });
    if (next) setTimeout(() => playChime('upper', 0.2), 50); // soft confirmation
  }, [on, set]);
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
