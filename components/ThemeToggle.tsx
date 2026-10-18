'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z" /> },
  { value: 'dark', label: 'Dark', icon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /> },
  { value: 'system', label: 'System', icon: <path d="M3 5h18v11H3zM8 21h8m-4-5v5" /> },
] as const;

/** Light / Dark / System switcher (next-themes). Renders a neutral placeholder until mounted to avoid a hydration mismatch. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div role="radiogroup" aria-label="Theme" className="flex overflow-hidden rounded-md border border-line bg-bg">
      {OPTIONS.map((o) => {
        const active = mounted && theme === o.value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            aria-label={`${o.label} theme`}
            title={`${o.label} theme`}
            onClick={() => setTheme(o.value)}
            className={`flex h-7 w-7 items-center justify-center ${active ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {o.icon}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
