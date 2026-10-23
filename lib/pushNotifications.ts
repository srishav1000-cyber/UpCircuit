// Browser side of Web Push: permission → service-worker subscription (VAPID) → stored in Supabase `push_subscriptions`.
import type { CloudClient, PushSub } from './cloud';

export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

/** base64url → bytes (the format `applicationServerKey` wants) */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export const pushSupported = (): boolean => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushConfigured = (): boolean => VAPID_PUBLIC_KEY.length > 20;

/** PushSubscription → the {endpoint, keys} row we store (null if the browser gave no keys) */
export function toPushSub(sub: { toJSON(): { endpoint?: string; keys?: Record<string, string> } }): PushSub | null {
  const j = sub.toJSON();
  return j.endpoint && j.keys?.p256dh && j.keys?.auth ? { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } } : null;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? (await navigator.serviceWorker.register('/sw.js')) ?? (await navigator.serviceWorker.ready);
}
export async function currentPushEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

export type PushResult = { ok: true; endpoint: string } | { ok: false; error: string };

/** Ask permission, subscribe this device and save the subscription to the account. Call from a click handler. */
export async function enablePush(cloud: CloudClient, userId: string): Promise<PushResult> {
  if (!pushSupported()) return { ok: false, error: 'This browser does not support web push (on iPhone, add UpCircuit to the Home Screen first).' };
  if (!pushConfigured()) return { ok: false, error: 'Push is not configured on this deployment (NEXT_PUBLIC_VAPID_PUBLIC_KEY is missing).' };
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, error: perm === 'denied' ? 'Notifications are blocked — allow them in the browser’s site settings, then try again.' : 'Permission was dismissed.' };
  try {
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource }));
    const row = toPushSub(sub);
    if (!row) return { ok: false, error: 'The browser returned an incomplete push subscription.' };
    await cloud.savePushSubscription(userId, row);
    return { ok: true, endpoint: row.endpoint };
  } catch {
    return { ok: false, error: 'Could not enable push notifications — check your connection and try again.' };
  }
}

/** Unsubscribe this device and remove it from the account. */
export async function disablePush(cloud: CloudClient | null, userId: string | null): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      if (cloud && userId) await cloud.deletePushSubscription(userId, endpoint);
    }
  } catch {
    /* best effort */
  }
}
