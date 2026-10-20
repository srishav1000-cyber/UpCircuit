'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isMarketOpen, type MarketEngine } from '@/lib/market';
import { DEMO_STEP_MS, demoDone, demoPrice, planDemo, type DemoTarget } from '@/lib/offmarketSimulator';

/** Runs the demo against the engine on a 250 ms timer; restores real prices when it ends (or on unmount / when the market opens). */
export function useDemoSimulator(engine: MarketEngine, fallback: string[]) {
  const [targets, setTargets] = useState<DemoTarget[]>([]);
  const [msg, setMsg] = useState('');
  const fb = useRef(fallback);
  fb.current = fallback;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    engine.demoRestore();
    setTargets([]);
  }, [engine]);

  const start = useCallback(() => {
    if (timer.current) return;
    if (isMarketOpen(Date.now())) return setMsg('Demo is available only while the market is closed.');
    const plan = planDemo((s) => engine.quotes.get(s), fb.current);
    if (!plan.length) return setMsg('No priced stocks yet — try again in a moment.');
    setMsg('');
    setTargets(plan);
    const t0 = Date.now();
    const step = () => {
      const el = Date.now() - t0;
      if (demoDone(el) || isMarketOpen(Date.now())) return stop();
      for (const t of plan) engine.demoSet(t.symbol, demoPrice(t, el), t);
    };
    step();
    timer.current = setInterval(step, DEMO_STEP_MS);
  }, [engine, stop]);

  useEffect(() => stop, [stop]);
  const active = targets.length > 0;
  return { active, targets, symbols: targets.map((t) => t.symbol), start, stop, toggle: () => (active ? stop() : start()), msg };
}
