import type { CircuitHit } from './circuit';

/** Ask the server to push this circuit hit to the user's OTHER devices (`exclude` = this device's endpoint). Fire-and-forget; same contract as sendCircuitEmail. */
export async function sendCircuitPush(hit: CircuitHit, token: string | null, exclude?: string | null, f: typeof fetch = fetch): Promise<'sent' | 'skipped' | 'failed'> {
  if (!token) return 'skipped';
  try {
    const r = await f('/api/alerts/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ symbol: hit.symbol, dir: hit.dir, ltp: hit.ltp, band: hit.band, pct: hit.pct, ...(exclude ? { exclude } : {}) }),
    });
    return r.ok ? 'sent' : r.status === 501 ? 'skipped' : 'failed';
  } catch {
    return 'failed';
  }
}
