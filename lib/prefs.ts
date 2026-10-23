// Notification toggles (Settings): web push, e-mail circuit alerts, audio alarm. Stored per user in localStorage and synced to Supabase.
import { scoped } from './scope';
import type { NotifyPrefs } from './cloudStore';

export type { NotifyPrefs };
export const NOTIFY_KEY = 'upcircuit:notify:v1';
/** same key / format ('1' | '0') the audio hook has always used */
export const AUDIO_KEY = 'upcircuit:audio:v1';
export const PREFS_EVENT = 'uc:prefs';
export const DEFAULT_PREFS: NotifyPrefs = { push: true, email: true, audio: true };

export function parseNotify(raw: string | null): Partial<NotifyPrefs> {
  try {
    const v = JSON.parse(raw ?? 'null') as Partial<NotifyPrefs> | null;
    const out: Partial<NotifyPrefs> = {};
    if (v && typeof v.push === 'boolean') out.push = v.push;
    if (v && typeof v.email === 'boolean') out.email = v.email;
    return out;
  } catch {
    return {};
  }
}
export function readPrefs(): NotifyPrefs {
  try {
    const n = parseNotify(localStorage.getItem(scoped(NOTIFY_KEY)));
    return { ...DEFAULT_PREFS, ...n, audio: localStorage.getItem(scoped(AUDIO_KEY)) !== '0' };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
/** true once this user has stored any toggle on this device (so an untouched device does not push defaults over their cloud settings) */
export function hasSavedPrefs(): boolean {
  try {
    return localStorage.getItem(scoped(NOTIFY_KEY)) !== null || localStorage.getItem(scoped(AUDIO_KEY)) !== null;
  } catch {
    return false;
  }
}
export function writePrefs(p: NotifyPrefs): void {
  try {
    localStorage.setItem(scoped(NOTIFY_KEY), JSON.stringify({ push: p.push, email: p.email }));
    localStorage.setItem(scoped(AUDIO_KEY), p.audio ? '1' : '0');
  } catch {
    /* in-memory only */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PREFS_EVENT));
}
export const samePrefs = (a: NotifyPrefs, b: NotifyPrefs) => a.push === b.push && a.email === b.email && a.audio === b.audio;
