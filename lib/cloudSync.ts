// Write-through cloud sync for ONE collection. Local state stays the instant source of truth for the UI; the cloud is reconciled behind it:
//   start()   → first load: cloud wins when it has data and differs; if the cloud has never been written, the local data seeds it
//   change(v) → user edit: debounced push (retried every `retryMs` while offline)
//   refresh() → poll / tab focus: pull and apply remote edits from another device (skipped while a local edit is unsent)
// Conflict policy: last write wins per collection (the whole list is replaced), which is right for a personal watchlist / portfolio.
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline';

export interface SyncOpts<T> {
  pull: () => Promise<T | null>;
  push: (v: T) => Promise<void>;
  equal: (a: T, b: T) => boolean;
  /** put a remote value into local state (must NOT call change()) */
  apply: (v: T) => void;
  /** what this device has saved locally, or null when the user has never saved anything (demo / defaults) */
  getLocal: () => T | null;
  onStatus?: (s: SyncStatus) => void;
  debounceMs?: number;
  retryMs?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

export class Syncer<T> {
  private pending: { v: T } | null = null;
  private inflight = false;
  private timer: unknown = null;
  private stopped = false;
  status: SyncStatus = 'idle';
  constructor(private o: SyncOpts<T>) {}

  private set(s: SyncStatus) {
    if (this.status !== s) {
      this.status = s;
      this.o.onStatus?.(s);
    }
  }
  private timers() {
    return this.o.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }
  private schedule(ms: number) {
    const t = this.timers();
    if (this.timer) t.clear(this.timer);
    this.timer = t.set(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  async start(): Promise<void> {
    this.set('syncing');
    try {
      const remote = await this.o.pull();
      if (this.stopped) return;
      const local = this.o.getLocal();
      if (this.pending) await this.flush(); // the user edited before the first pull finished — their edit wins
      else if (remote !== null && (local === null || !this.o.equal(remote, local))) {
        this.o.apply(remote);
        this.set('synced');
      } else if (remote === null && local !== null) await this.pushNow(local);
      else this.set('synced');
    } catch {
      this.set('offline');
    }
  }

  change(v: T): void {
    if (this.stopped) return;
    this.pending = { v };
    this.set('syncing');
    this.schedule(this.o.debounceMs ?? 800);
  }

  private async pushNow(v: T) {
    this.inflight = true;
    try {
      await this.o.push(v);
      this.set('synced');
    } finally {
      this.inflight = false;
    }
  }

  private async flush(): Promise<void> {
    if (this.stopped || !this.pending || this.inflight) return;
    const sent = this.pending;
    try {
      await this.pushNow(sent.v);
      if (this.pending === sent) this.pending = null;
      else this.schedule(this.o.debounceMs ?? 800); // edited again while the push was in flight
    } catch {
      this.set('offline');
      this.schedule(this.o.retryMs ?? 8000);
    }
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.pending || this.inflight) return;
    try {
      const remote = await this.o.pull();
      if (this.stopped || this.pending || this.inflight || remote === null) return;
      const local = this.o.getLocal();
      if (local === null || !this.o.equal(remote, local)) this.o.apply(remote);
      this.set('synced');
    } catch {
      this.set('offline');
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.timers().clear(this.timer);
    this.timer = null;
  }
}
