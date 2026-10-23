// Notification toggles ([✓] Web Push, [✓] Email circuit alerts, [✓] Audio alarm chimes): one tiny external store so Settings, the audio
// hook and the alert dispatcher always agree. Persisted per user in localStorage and mirrored to Supabase (preferences.notify).
import { DEFAULT_NOTIFY, parseNotify, type NotifyPrefs } from './cloud';
import { scoped } from './scope';

export const NOTIFY_KEY = 'upcircuit:notify:v1';
const LEGACY_AUDIO_KEY = 'upcircuit:audio:v1'; // '0' = muted (the pre-settings audio toggle)

let state: NotifyPrefs = DEFAULT_NOTIFY;
let saver: ((p: NotifyPrefs) => void) | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((l) => l());

export const getNotify = (): NotifyPrefs => state;
export const subscribeNotify = (l: () => void) => {
  subs.add(l);
  return () => subs.delete(l);
};
export const serverNotify = (): NotifyPrefs => DEFAULT_NOTIFY;

function persist() {
  try { localStorage.setItem(scoped(NOTIFY_KEY), JSON.stringify(state)); } catch { /* in-memory only */ }
}
/** read this user's saved toggles (call after the storage scope is set) */
export function loadNotifyLocal(): void {
  try {
    const raw = localStorage.getItem(scoped(NOTIFY_KEY));
    if (raw) state = parseNotify(JSON.parse(raw));
    else state = { ...DEFAULT_NOTIFY, audio: localStorage.getItem(scoped(LEGACY_AUDIO_KEY)) !== '0' }; // keep an old mute
  } catch {
    state = DEFAULT_NOTIFY;
  }
  emit();
}
/** user changed a toggle */
export function setNotify(patch: Partial<NotifyPrefs>): NotifyPrefs {
  state = { ...state, ...patch };
  persist();
  emit();
  saver?.(state);
  return state;
}
/** values arriving from the cloud (no echo back) */
export function applyCloudNotify(p: NotifyPrefs): void {
  state = p;
  persist();
  emit();
}
export const attachNotifySaver = (fn: ((p: NotifyPrefs) => void) | null) => {
  saver = fn;
};
