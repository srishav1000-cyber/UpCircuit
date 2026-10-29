/**
 * Tiny in-memory TTL cache + rate limiter. Per server instance / edge isolate, best-effort:
 * for a hard guarantee across instances back these with Vercel KV or Upstash Redis.
 */
export class TtlCache<V> {
  private store = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number, private max = 300) {}

  get(key: string): { value: V; ageMs: number } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return { value: e.v, ageMs: this.ttlMs - (e.exp - Date.now()) };
  }

  set(key: string, v: V) {
    if (this.store.size >= this.max) {
      const now = Date.now();
      this.store.forEach((e, k) => e.exp <= now && this.store.delete(k));
      if (this.store.size >= this.max) this.store.delete(this.store.keys().next().value as string);
    }
    this.store.set(key, { v, exp: Date.now() + this.ttlMs });
  }
}

const buckets = new Map<string, number[]>();
/** Sliding-window limiter: returns false when `key` has made ≥ `limit` calls in the last `windowMs`. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 2000) buckets.clear();
  return true;
}

/**
 * Distributed limiter. With UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set, counts live in Redis (fixed window: INCR + PEXPIRE, shared by every instance);
 * otherwise — or if Redis is unreachable — it falls back to the per-instance sliding window above, so a Redis outage never takes the API down.
 */
export async function allowAsync(key: string, limit: number, windowMs: number, f: typeof fetch = fetch): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return allow(key, limit, windowMs);
  try {
    const win = Math.floor(Date.now() / windowMs);
    const k = `rl:${key}:${win}`;
    const r = await f(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', k], ['PEXPIRE', k, String(windowMs), 'NX']]),
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return allow(key, limit, windowMs);
    const out = (await r.json()) as { result?: unknown }[];
    const n = Number(out?.[0]?.result);
    return Number.isFinite(n) ? n <= limit : allow(key, limit, windowMs);
  } catch {
    return allow(key, limit, windowMs);
  }
}
