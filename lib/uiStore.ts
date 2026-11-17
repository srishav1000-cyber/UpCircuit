// Tiny external store for the synced UI preferences, so the page (timeframe) and the chart (indicators) share one source of truth.
import { DEFAULT_UI, UI_KEY, sanitizeUi, type UiPrefs } from './uiPrefs';
import { scoped } from './scope';

let state: UiPrefs = DEFAULT_UI;
const subs = new Set<() => void>();
const changed = new Set<(s: UiPrefs) => void>();          // user-originated changes (what the cloud saver listens to)
export const getUi = (): UiPrefs => state;
export const getUiServer = (): UiPrefs => DEFAULT_UI;
export const subscribeUi = (l: () => void) => (subs.add(l), () => void subs.delete(l));
export const onUiChange = (l: (s: UiPrefs) => void) => (changed.add(l), () => void changed.delete(l));
const emit = () => subs.forEach((l) => l());

export function readLocalUi(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): UiPrefs | null {
  try {
    const cur = sanitizeUi(storage?.getItem(scoped(UI_KEY)));
    if (cur) return cur;
    const legacy = storage?.getItem(scoped('upcircuit:indicators:v1'));        // pre-sync per-device toggles: still honoured on this device, never uploaded as a "choice"
    return legacy ? sanitizeUi({ ind: JSON.parse(legacy) }) : null;
  } catch { return null; }
}
export function writeLocalUi(s: UiPrefs, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem(scoped(UI_KEY), JSON.stringify(s)); } catch { /* per-device cache only */ }
}
/** replace the state from storage / the cloud (no change event: this is hydration, not a user edit) */
export function hydrateUi(s: UiPrefs): void { state = s; emit(); }
export function resetUi(): void { state = DEFAULT_UI; emit(); }
/** a user edit: stamps updatedAt, saves locally right away, and notifies the cloud saver */
export function patchUi(p: Partial<Pick<UiPrefs, 'tf' | 'ind'>>, now = Date.now()): void {
  const next: UiPrefs = { ...state, ...p, ind: p.ind ?? state.ind, updatedAt: Math.max(now, state.updatedAt + 1) };
  if (next.tf === state.tf && JSON.stringify(next.ind) === JSON.stringify(state.ind)) return;
  state = next;
  writeLocalUi(next);
  emit();
  changed.forEach((l) => l(next));
}
