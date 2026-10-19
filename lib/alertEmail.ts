// Client side of the e-mail dispatcher: POSTs a confirmed circuit hit to /api/alerts/email (server sends to the signed-in user's own address).
import type { CircuitHit } from './circuit';
import { scoped } from './scope';

const KEY = 'upcircuit:emailed:v1';
const today = () => new Date(Date.now() + 19800_000).toISOString().slice(0, 10);

/** Once per stock · direction · band per IST day (the server dedupes too — this just saves the request). */
function alreadySent(k: string): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(scoped(KEY)) ?? 'null') as { day: string; keys: string[] } | null;
    return !!v && v.day === today() && v.keys.includes(k);
  } catch {
    return false;
  }
}
function markSent(k: string) {
  try {
    const v = JSON.parse(localStorage.getItem(scoped(KEY)) ?? 'null') as { day: string; keys: string[] } | null;
    const cur = v && v.day === today() ? v : { day: today(), keys: [] as string[] };
    localStorage.setItem(scoped(KEY), JSON.stringify({ day: cur.day, keys: [...cur.keys, k] }));
  } catch {
    /* ignore */
  }
}

export async function sendCircuitEmail(hit: CircuitHit, token: string | null, f: typeof fetch = fetch): Promise<'sent' | 'skipped' | 'failed'> {
  if (!token) return 'skipped'; // demo accounts: no verified e-mail address
  const k = `${hit.symbol}:${hit.dir}:${hit.band}`;
  if (alreadySent(k)) return 'skipped';
  try {
    const r = await f('/api/alerts/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ symbol: hit.symbol, dir: hit.dir, ltp: hit.ltp, limit: hit.limit, band: hit.band, pct: hit.pct, exact: hit.exact }),
    });
    if (r.ok) {
      markSent(k);
      return 'sent';
    }
    return r.status === 501 || r.status === 503 ? 'skipped' : 'failed';
  } catch {
    return 'failed';
  }
}
