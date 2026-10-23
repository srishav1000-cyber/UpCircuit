// Cloud-sync health for the profile popover: "🟢 Supabase Synced" vs "🟡 Local Cache Only". A tiny external store fed by every REST call.
export type SyncState = 'synced' | 'local' | 'offline';
export interface SyncInfo { state: SyncState; lastOkAt: number | null; lastFailAt: number | null }
let info: SyncInfo = { state: 'local', lastOkAt: null, lastFailAt: null };
const subs = new Set<() => void>();
const emit = () => subs.forEach((l) => l());
export const getSync = (): SyncInfo => info;
export const serverSync = (): SyncInfo => SERVER;
const SERVER: SyncInfo = { state: 'local', lastOkAt: null, lastFailAt: null };
export const subscribeSync = (l: () => void) => (subs.add(l), () => void subs.delete(l));
/** a Supabase account is signed in (or not) → baseline state */
export function setSyncAvailable(on: boolean): void {
  info = on ? { state: info.lastFailAt && (!info.lastOkAt || info.lastFailAt > info.lastOkAt) ? 'offline' : 'synced', lastOkAt: info.lastOkAt, lastFailAt: info.lastFailAt } : { state: 'local', lastOkAt: null, lastFailAt: null };
  emit();
}
export function reportSync(ok: boolean, now = Date.now()): void {
  if (info.state === 'local') return; // no cloud account → stays "local"
  info = ok ? { state: 'synced', lastOkAt: now, lastFailAt: info.lastFailAt } : { state: 'offline', lastOkAt: info.lastOkAt, lastFailAt: now };
  emit();
}
export const syncLabel = (s: SyncState): string => (s === 'synced' ? '🟢 Supabase Synced' : s === 'offline' ? '🟡 Local Cache Only (retrying)' : '🟡 Local Cache Only');
