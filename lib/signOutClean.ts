// "Clean logout": before the session token is dropped, push anything this browser still holds to the account, then purge the per-user
// offline cache (so the next person on a shared computer sees nothing). Accounts with no cloud keep their data — it is their only copy.
import type { CloudClient, NotifyPrefs } from './cloud';
import { forceSync, readSnapshot, type ReadKey } from './backup';

export interface KeyStore { readonly length: number; key(i: number): string | null; removeItem(k: string): void }
/** removes every `upcircuit:…:<userId>` key except the one-time migration flag; returns what was removed */
export function purgeUserCache(store: KeyStore, userId: string): string[] {
  const hit: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith('upcircuit:') && k.endsWith(`:${userId}`) && !k.startsWith('upcircuit:cloud-migrated:')) hit.push(k);
  }
  hit.forEach((k) => store.removeItem(k));
  return hit;
}

export interface CleanResult { synced: boolean | null; purged: string[]; kept: boolean }
/** `cloud` null → nothing to push and nothing purged (local-only accounts). A failed push keeps the cache so no edit is lost. */
export async function cleanBeforeSignOut(i: { cloud: CloudClient | null; userId: string; read: ReadKey; prefs: NotifyPrefs; store: KeyStore; removePush?: () => Promise<void> }): Promise<CleanResult> {
  if (!i.cloud) return { synced: null, purged: [], kept: true };
  const r = await forceSync(i.cloud, i.userId, readSnapshot(i.read), i.prefs).catch(() => null);
  const ok = !!r?.ok;
  await i.removePush?.().catch(() => undefined);
  if (!ok) return { synced: false, purged: [], kept: true };
  return { synced: true, purged: purgeUserCache(i.store, i.userId), kept: false };
}
