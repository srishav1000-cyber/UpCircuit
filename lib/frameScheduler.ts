// Frame-coalesced render pump for the live tick path.
//
// Audit (Round 23): SmartAPI ticks were ALREADY applied to the engine synchronously the moment they arrive (no setTimeout / debounce
// in lib/smartapiDirect.ts or in the tick handler). What the screen saw was gated by a 250 ms housekeeping loop that bumped React every
// other pass, i.e. a repaint every 500 ms, so a price could sit up to 0.5 s in memory before it was drawn.
//
// This pump removes that gate. `request()` is called once per tick:
//   • idle      → one repaint on the very next animation frame (≈ 16 ms)
//   • busy      → ticks that arrive within `minGapMs` of the last repaint share ONE trailing frame, so the screen is refreshed at most
//                 1000 ÷ minGapMs times a second (10/s at the 100 ms default) no matter how fast ticks stream (no re-render thrash)
// Worst case from tick to paint is therefore ≈ minGapMs + one frame. If the tab is hidden the browser pauses animation frames; the
// slow 500 ms interval in useMarket keeps state fresh and the pump resumes when the tab is visible again.

export interface FrameDeps {
  raf: (cb: () => void) => unknown;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  now: () => number;
}

export interface FramePump {
  request(): void;
  cancel(): void;
  /** repaints performed / requests received — lets tests and diagnostics see the coalescing ratio */
  stats(): { requests: number; flushes: number };
}

export function createFramePump(flush: () => void, minGapMs = 100, deps?: Partial<FrameDeps>): FramePump {
  const d: FrameDeps = {
    raf: deps?.raf ?? ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16))),
    setTimer: deps?.setTimer ?? ((cb, ms) => setTimeout(cb, ms)),
    clearTimer: deps?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    now: deps?.now ?? (() => Date.now()),
  };
  let pending = false;
  let timer: unknown = null;
  let last = -Infinity;
  let requests = 0;
  let flushes = 0;
  const frame = () => {
    d.raf(() => {
      pending = false;
      timer = null;
      last = d.now();
      flushes++;
      flush();
    });
  };
  return {
    request() {
      requests++;
      if (pending) return;
      pending = true;
      const wait = Math.max(0, last + minGapMs - d.now());
      if (wait > 0) timer = d.setTimer(frame, wait);
      else frame();
    },
    // clears a waiting trailing frame; the pump stays usable (React strict mode mounts, unmounts and re-mounts effects)
    cancel() {
      if (timer !== null) d.clearTimer(timer);
      timer = null;
      pending = false;
    },
    stats: () => ({ requests, flushes }),
  };
}

/** React DOM cadence for high-frequency ticks (header ticker, watchlists, cards, screener). The chart canvas bypasses it via engine.onTick. */
export const DOM_BATCH_MS = 250;

/**
 * Off-market freeze: with the session closed (and no demo simulator running) prices are the verified closing prices and must stay strictly
 * static — no sub-second React re-renders, no replay wobble. A late closing-price tick may still arrive (SmartAPI snapshot on subscribe);
 * it is applied to the engine and painted ONCE after `FREEZE_SETTLE_MS` of quiet instead of through the 250 ms pump.
 */
export const FREEZE_SETTLE_MS = 1000;
export const isFrozen = (marketOpen: boolean, demoActive: boolean): boolean => !marketOpen && !demoActive;
