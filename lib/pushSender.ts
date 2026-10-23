// Server side of circuit push: build the notification and fan it out to a user's saved device subscriptions.
import type { CircuitHit } from './circuit';
import type { PushSub } from './cloud';
import { terminalUrl } from './appUrl';

export interface PushPayload { title: string; body: string; url: string; tag: string }

export function circuitPushPayload(hit: Pick<CircuitHit, 'symbol' | 'dir' | 'band' | 'ltp' | 'pct'>): PushPayload {
  const upper = hit.dir === 'upper';
  const pct = `${hit.pct >= 0 ? '+' : '−'}${Math.abs(hit.pct).toFixed(2)}%`;
  return {
    title: `${upper ? '▲ UPPER' : '▼ LOWER'} CIRCUIT · ${hit.symbol}`,
    body: `₹${hit.ltp.toFixed(2)} (${pct}) hit the ${upper ? '+' : '−'}${hit.band}% band. ${upper ? 'Buyers only — circuit lock active.' : 'Sellers only — liquidity frozen.'}`,
    url: terminalUrl(hit.symbol),
    tag: `circuit-${hit.symbol}-${hit.dir}-${hit.band}`,
  };
}

export type SendFn = (sub: PushSub, body: string) => Promise<void>;
export interface FanOut { sent: number; failed: number; gone: string[] }

/** Send to every subscription (except `exclude`, the device that raised the alert). 404/410 mean the subscription is dead → returned in `gone` for cleanup. */
export async function fanOut(subs: PushSub[], payload: PushPayload, send: SendFn, exclude?: string): Promise<FanOut> {
  const out: FanOut = { sent: 0, failed: 0, gone: [] };
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.filter((s) => s.endpoint !== exclude).map(async (s) => {
      try {
        await send(s, body);
        out.sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) out.gone.push(s.endpoint);
        else out.failed++;
      }
    }),
  );
  return out;
}

/** Push services the browsers use. The server only ever POSTs to these (the endpoint comes from a user-written row, so anything else would be an SSRF hole). */
export const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
/** `extra` = comma-separated extra hosts (env PUSH_ENDPOINT_ALLOW — self-hosted push services / tests) */
export function isPushEndpoint(e: unknown, extra = ''): e is string {
  if (typeof e !== 'string' || e.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(e);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname.length < 2) return false;
  const host = u.hostname.toLowerCase();
  const ok = [...PUSH_HOST_SUFFIXES, ...extra.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)];
  return ok.some((h) => host === h || host.endsWith('.' + h));
}
/** web-push keys are base64url */
export const isB64Url = (x: unknown, min = 16, max = 200): x is string => typeof x === 'string' && x.length >= min && x.length <= max && /^[\w-]+={0,2}$/.test(x);
