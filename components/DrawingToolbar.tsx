'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Tool } from '@/lib/drawings';

interface Props {
  tool: Tool;
  onTool: (t: Tool) => void;
  magnet: boolean;
  onMagnet: () => void;
  locked: boolean;
  onLock: () => void;
  visible: boolean;
  onVisible: () => void;
  count: number;
  onClear: () => void;
}

/* Lucide-style icons: 24 × 24 grid, one monochrome 1.5 px stroke, no fills — colour comes from `currentColor`. */
const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
    {children}
  </svg>
);
const ICONS: Record<string, ReactNode> = {
  cursor: (<><circle cx="12" cy="12" r="10" /><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" /></>),
  trend: (<><path d="M4.5 19.5 19.5 4.5" /><circle cx="4.5" cy="19.5" r="1.75" /><circle cx="19.5" cy="4.5" r="1.75" /></>),
  hline: (<><path d="M2 12h20" /><path d="M6 8.5v7M18 8.5v7" /></>),
  fib: (<><path d="M3 4h18M3 9h18M3 15h18M3 20h18" /><path d="M7 4v16" /></>),
  text: (<><path d="M4 7V4h16v3M9 20h6M12 4v16" /></>),
  ruler: (<><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z" /><path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2" /></>),
  brush: (<><path d="m18.37 2.63 3 3a1.5 1.5 0 0 1 0 2.12L11 18.1l-4.1-4.1L16.25 2.63a1.5 1.5 0 0 1 2.12 0Z" /><path d="M6.9 14C4.3 14 3 16 3 18.5c0 1.4-.8 2.5-1.5 3 3.5.5 8.5-.5 8.5-4" /></>),
  range: (<><path d="M12 3v18M8.5 6.5 12 3l3.5 3.5M8.5 17.5 12 21l3.5-3.5" /><path d="M4 8h3M4 16h3M17 8h3M17 16h3" /></>),
  erase: (<><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21" /><path d="M22 21H7M5 11l9 9" /></>),
  magnet: (<><path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15" /><path d="m5 8 4 4M12 15l4 4" /></>),
  lock: (<><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>),
  unlock: (<><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></>),
  eye: (<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: (<><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20" /></>),
  trash: (<><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>),
};

/** `key` is the physical key (Alt + key) — matched on KeyboardEvent.code so macOS Option characters don't interfere */
const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: 'cursor', icon: 'cursor', label: 'Crosshair', key: 'C' },
  { id: 'trend', icon: 'trend', label: 'Trend Line', key: 'T' },
  { id: 'hline', icon: 'hline', label: 'Horizontal Line', key: 'H' },
  { id: 'fib', icon: 'fib', label: 'Fib Retracement', key: 'F' },
  { id: 'text', icon: 'text', label: 'Text Note', key: 'N' },
  { id: 'ruler', icon: 'ruler', label: 'Measure', key: 'R' },
  { id: 'brush', icon: 'brush', label: 'Brush', key: 'B' },
  { id: 'range', icon: 'range', label: 'Price Range', key: 'P' },
  { id: 'erase', icon: 'erase', label: 'Eraser', key: 'E' },
];

// institutional slate palette: quiet at rest, soft glow on hover, slate-blue rail + tint when selected
const btn = 'relative flex h-9 w-full shrink-0 cursor-pointer items-center justify-center border-l-2 transition-colors duration-150 focus-visible:outline focus-visible:outline-1 focus-visible:outline-blue-500 disabled:pointer-events-none disabled:opacity-35';
const idle = 'border-transparent bg-slate-900/60 text-slate-400 hover:bg-slate-800/80 hover:text-slate-100';
const active = 'border-blue-500 bg-blue-600/20 text-blue-400';

/** Vertical TradingView-style drawing toolbar, docked on the left edge of the chart. */
export function DrawingToolbar({ tool, onTool, magnet, onMagnet, locked, onLock, visible, onVisible, count, onClear }: Props) {
  // one fixed-position tooltip (the rail scrolls, so per-button absolute tips would be clipped)
  const [tip, setTip] = useState<{ text: string; key?: string; top: number; left: number } | null>(null);
  const show = useCallback((el: HTMLElement, text: string, key?: string) => {
    const r = el.getBoundingClientRect();
    setTip({ text, key, top: r.top + r.height / 2, left: r.right + 8 });
  }, []);
  const hide = useCallback(() => setTip(null), []);

  // Alt + key shortcuts. Alt-chords never type a character on Windows / Linux, and on macOS preventDefault stops Option inserting one, so they also work while a search box has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.code.replace('Key', '');
      const hit = TOOLS.find((x) => x.key === k);
      if (hit) { if (!(locked && hit.id !== 'cursor')) { e.preventDefault(); onTool(hit.id); } return; }
      if (k === 'M') { e.preventDefault(); onMagnet(); }
      else if (k === 'L') { e.preventDefault(); onLock(); }
      else if (k === 'V') { e.preventDefault(); onVisible(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, onTool, onMagnet, onLock, onVisible]);

  const common = (label: string, key?: string) => ({ onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget, label, key), onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget, label, key), onMouseLeave: hide, onBlur: hide });
  const tipText = (label: string, key?: string) => (key ? `${label} (Alt+${key})` : label);

  return (
    <div role="toolbar" aria-label="Drawing tools" aria-orientation="vertical" data-testid="drawing-toolbar" className="z-20 flex w-10 shrink-0 flex-col items-stretch overflow-y-auto border-r border-slate-800 bg-slate-900/60 py-1.5">
      {TOOLS.map((t) => (
        <button key={t.id} type="button" onClick={() => onTool(t.id)} aria-pressed={tool === t.id} aria-label={tipText(t.label, t.key)} aria-keyshortcuts={`Alt+${t.key}`} data-testid={`tool-${t.id}`} disabled={locked && t.id !== 'cursor'} className={`${btn} ${tool === t.id ? active : idle}`} {...common(t.label, t.key)}>
          <Svg>{ICONS[t.icon]}</Svg>
        </button>
      ))}
      <span className="mx-2 my-1.5 h-px bg-slate-800" aria-hidden />
      <button type="button" onClick={onMagnet} aria-pressed={magnet} aria-label="Magnet Mode (Alt+M)" aria-keyshortcuts="Alt+M" data-testid="tool-magnet" className={`${btn} ${magnet ? active : idle}`} {...common('Magnet Mode', 'M')}>
        <Svg>{ICONS.magnet}</Svg>
      </button>
      <button type="button" onClick={onLock} aria-pressed={locked} aria-label={locked ? 'Unlock Drawings (Alt+L)' : 'Lock Drawings (Alt+L)'} aria-keyshortcuts="Alt+L" data-testid="tool-lock" className={`${btn} ${locked ? active : idle}`} {...common(locked ? 'Unlock Drawings' : 'Lock Drawings', 'L')}>
        <Svg>{locked ? ICONS.lock : ICONS.unlock}</Svg>
      </button>
      <button type="button" onClick={onVisible} aria-pressed={!visible} aria-label={visible ? 'Hide Drawings (Alt+V)' : 'Show Drawings (Alt+V)'} aria-keyshortcuts="Alt+V" data-testid="tool-visibility" className={`${btn} ${!visible ? active : idle}`} {...common(visible ? 'Hide Drawings' : 'Show Drawings', 'V')}>
        <Svg>{visible ? ICONS.eye : ICONS.eyeOff}</Svg>
      </button>
      <div className="w-full" {...common(count === 0 ? 'Clear Drawings (none)' : `Clear Drawings (${count})`)}>
        <button type="button" onClick={onClear} disabled={locked || count === 0} aria-label="Clear Drawings" data-testid="tool-clear" className={`${btn} ${idle}`}>
          <Svg>{ICONS.trash}</Svg>
        </button>
      </div>
      {tip && (
        <div role="tooltip" data-testid="tool-tooltip" style={{ top: tip.top, left: tip.left }} className="pointer-events-none fixed z-[100] -translate-y-1/2 whitespace-nowrap rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-100 shadow-lg">
          {tip.text}
          {tip.key && <kbd className="ml-2 rounded border border-slate-700 bg-slate-800 px-1 py-px font-mono text-[10px] text-slate-400">Alt+{tip.key}</kbd>}
        </div>
      )}
    </div>
  );
}
