// Volume baselines for volume_surge rules: typical full-day volume per symbol, computed from real daily bars (lib/volumeBaseline.computeBaseline).
// Loaded lazily for exactly the symbols that have a volume rule, cached for hours, retried sooner after a failure, and published to
// public.volume_baselines so the rule manager can show "N/A — only 4 sessions of history" instead of a rule that silently never fires.
import { computeBaseline, istDayOf, type BaselineResult } from '../lib/volumeBaseline';

export interface DailyBar { time: number; volume: number }
export interface BaselineRecord extends BaselineResult { symbol: string; computedAt: number }
export interface BaselineStoreOptions {
  /** daily bars for a symbol (≥ 1 year back is plenty); throw or return [] when unavailable */
  fetchDaily: (symbol: string) => Promise<DailyBar[]>;
  /** called with every freshly computed batch (persist / publish) — failures are logged, never thrown into the loader */
  onComputed?: (rows: BaselineRecord[]) => void | Promise<void>;
  now?: () => number;
  /** reuse a good baseline this long (default 6 h; it is also recomputed when the IST day changes so yesterday's session is included) */
  okTtlMs?: number;
  /** retry an insufficient / unavailable symbol after this long (default 30 min) */
  badTtlMs?: number;
  concurrency?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export class BaselineStore {
  private readonly rows = new Map<string, BaselineRecord>();
  private readonly loading = new Set<string>();
  private readonly queue: string[] = [];
  private active = 0;
  private waiters: (() => void)[] = [];
  private readonly now: () => number;
  private readonly okTtl: number;
  private readonly badTtl: number;
  private readonly conc: number;
  constructor(private readonly o: BaselineStoreOptions) {
    this.now = o.now ?? Date.now;
    this.okTtl = o.okTtlMs ?? 6 * 3600_000;
    this.badTtl = o.badTtlMs ?? 30 * 60_000;
    this.conc = o.concurrency ?? 3;
  }

  /** typical full-day volume, or null (N/A: not loaded yet, history too short, or unavailable) */
  get(symbol: string): number | null {
    const r = this.rows.get(symbol.toUpperCase());
    return r && r.status === 'ok' ? r.medianVolume : null;
  }
  info(symbol: string): BaselineRecord | undefined { return this.rows.get(symbol.toUpperCase()); }
  stats(): { symbols: number; ok: number; insufficient: number; unavailable: number; loading: number } {
    const all = [...this.rows.values()];
    return { symbols: all.length, ok: all.filter((r) => r.status === 'ok').length, insufficient: all.filter((r) => r.status === 'insufficient').length, unavailable: all.filter((r) => r.status === 'unavailable').length, loading: this.loading.size + this.queue.length };
  }

  private fresh(r: BaselineRecord | undefined): boolean {
    if (!r) return false;
    const age = this.now() - r.computedAt;
    if (r.status === 'ok') return age < this.okTtl && istDayOf(r.computedAt) === istDayOf(this.now());
    return age < this.badTtl;
  }

  /** schedule loads for every symbol whose baseline is missing or stale (idempotent — safe to call on every rule change) */
  want(symbols: Iterable<string>): void {
    for (const raw of symbols) {
      const s = raw.toUpperCase();
      if (this.loading.has(s) || this.queue.includes(s) || this.fresh(this.rows.get(s))) continue;
      this.queue.push(s);
    }
    this.pump();
  }

  private pump(): void {
    while (this.active < this.conc && this.queue.length) {
      const s = this.queue.shift() as string;
      this.loading.add(s); this.active++;
      void this.load(s).finally(() => {
        this.loading.delete(s); this.active--;
        if (!this.active && !this.queue.length) this.waiters.splice(0).forEach((w) => w()); else this.pump();
      });
    }
  }

  private async load(symbol: string): Promise<void> {
    let rec: BaselineRecord;
    try {
      const bars = await this.o.fetchDaily(symbol);
      rec = { symbol, computedAt: this.now(), ...computeBaseline(bars, this.now()) };
    } catch (e) {
      this.o.log?.('warn', 'baseline fetch failed', { symbol, error: e instanceof Error ? e.message : String(e) });
      rec = { symbol, computedAt: this.now(), medianVolume: null, sessions: 0, status: 'unavailable' };
    }
    this.rows.set(symbol, rec);
    try { await this.o.onComputed?.([rec]); } catch (e) { this.o.log?.('warn', 'baseline publish failed', { symbol, error: e instanceof Error ? e.message : String(e) }); }
  }

  /** resolves when nothing is queued or loading */
  idle(): Promise<void> {
    return this.active || this.queue.length ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }
}
