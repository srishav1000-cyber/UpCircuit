// One alert per (symbol, direction) per trading day, re-armed ONLY when the stock escalates to a higher band (5 → 10 → 20 %).
// Composite key: `${symbol}_${tradingDate}_${band}_${direction}`. Persisted in localStorage per IST day so a reload does not re-chime.
// (The e-mail route additionally dedupes server-side per user · symbol · direction · band · day.)

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem?(k: string): void;
}

export const istDate = (ms: number): string => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
export const dedupeKey = (symbol: string, tradingDate: string, band: number, dir: string) => `${symbol}_${tradingDate}_${band}_${dir}`;

const PREFIX = 'uc:circuit-fired:';

export class CircuitDedupe {
  private fired = new Set<string>();
  private maxBand = new Map<string, number>();
  private date = '';

  constructor(private store?: KV, private scope = 'anon') {}

  private load(date: string) {
    if (this.date === date) return;
    this.date = date;
    this.fired = new Set();
    this.maxBand = new Map();
    try {
      const raw = this.store?.getItem(`${PREFIX}${this.scope}:${date}`);
      if (raw) for (const k of JSON.parse(raw) as string[]) this.add(k, false);
    } catch { /* corrupt or unavailable storage → start empty for the day */ }
  }

  private add(key: string, persist: boolean) {
    this.fired.add(key);
    const parts = key.split('_');
    const dir = parts.pop()!;
    const band = parts.pop()!;
    parts.pop(); // trading date
    const sym = parts.join('_');
    const mk = `${sym}_${dir}`;
    this.maxBand.set(mk, Math.max(this.maxBand.get(mk) ?? 0, Number(band)));
    if (persist) {
      try { this.store?.setItem(`${PREFIX}${this.scope}:${this.date}`, JSON.stringify([...this.fired])); } catch { /* quota / private mode */ }
    }
  }

  /** True exactly once per key, and only when `band` is higher than any band already fired for this symbol+direction today. */
  shouldFire(symbol: string, band: number, dir: string, now: number): boolean {
    const date = istDate(now);
    this.load(date);
    const key = dedupeKey(symbol, date, band, dir);
    if (this.fired.has(key)) return false;
    if (band <= (this.maxBand.get(`${symbol}_${dir}`) ?? 0)) return false;
    this.add(key, true);
    return true;
  }

  reset() {
    this.fired = new Set();
    this.maxBand = new Map();
    try { this.store?.removeItem?.(`${PREFIX}${this.scope}:${this.date}`); } catch { /* ignore */ }
  }
}
