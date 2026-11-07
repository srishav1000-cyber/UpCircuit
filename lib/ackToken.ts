// Delivery-ACK tokens. The push payload (end-to-end encrypted to the device) carries { delivery_id, ack }; the service worker
// echoes them to /api/alerts/ack, which has no session cookie — so the token is an HMAC proving the sender was our daemon.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ALERT_ACK_SECRET if set, otherwise a key derived from VAPID_PRIVATE_KEY (domain-separated, never used as the VAPID key itself). */
export function ackSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.ALERT_ACK_SECRET) return env.ALERT_ACK_SECRET;
  return env.VAPID_PRIVATE_KEY ? createHmac('sha256', env.VAPID_PRIVATE_KEY).update('upcircuit/ack-key/v1').digest('hex') : undefined;
}
export const ackToken = (deliveryId: string, secret: string): string => createHmac('sha256', secret).update(`ack:${deliveryId}`).digest('base64url');
export function verifyAckToken(deliveryId: unknown, token: unknown, secret: string | undefined): boolean {
  if (!secret || typeof deliveryId !== 'string' || typeof token !== 'string' || !UUID_RE.test(deliveryId) || token.length > 100) return false;
  const want = Buffer.from(ackToken(deliveryId, secret));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}
