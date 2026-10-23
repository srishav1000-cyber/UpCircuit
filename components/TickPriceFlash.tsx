'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Price text that pulses green / red when the value ticks up / down. The pulse is a CSS transition (`.tick-flash` in globals.css:
 * background-color + color 250 ms ease) — class toggling only, no animation loop, no layout shift. Respects prefers-reduced-motion.
 */
export function TickPriceFlash({ value, children, className = '', testid }: { value: number | null | undefined; children: ReactNode; className?: string; testid?: string }) {
  const prev = useRef<number | null | undefined>(value);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    if (typeof value !== 'number' || typeof p !== 'number' || value === p) return;
    setDir(value > p ? 'up' : 'down');
    const t = setTimeout(() => setDir(null), 450); // hold the colour briefly, the CSS transition eases it back over 250 ms
    return () => clearTimeout(t);
  }, [value]);
  return (
    <span className={`tick-flash ${className}`} data-flash={dir ?? undefined} data-testid={testid}>
      {children}
    </span>
  );
}
