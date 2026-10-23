// Coalesces rapid edits into one cloud save, and tells readers whether an edit is still unsaved (so a background pull never overwrites it).
export interface SaverDeps { setTimer: (cb: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void }
const real: SaverDeps = { setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

export function createSaver<T>(save: (v: T) => Promise<void>, ms = 700, deps: SaverDeps = real) {
  let timer: unknown = null;
  let pending: { v: T } | null = null;
  let inflight = false;
  const run = async (): Promise<void> => {
    timer = null;
    if (!pending || inflight) return;
    const { v } = pending;
    pending = null;
    inflight = true;
    try {
      await save(v);
    } catch {
      if (!pending) pending = { v }; // keep it dirty: the next edit / focus / retry saves the newest value
    } finally {
      inflight = false;
    }
    if (pending && timer === null) timer = deps.setTimer(() => void run(), ms * 4); // retry after a failure, slower
  };
  return {
    schedule(v: T) {
      pending = { v };
      if (timer !== null) deps.clearTimer(timer);
      timer = deps.setTimer(() => void run(), ms);
    },
    /** save now (page hide / sign-out) */
    async flush() {
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      await run();
    },
    dirty: () => pending !== null || inflight,
    cancel() {
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}
