'use client';

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

const TOOLS: { id: Tool; glyph: string; label: string }[] = [
  { id: 'cursor', glyph: '✚', label: 'Crosshair / pointer' },
  { id: 'trend', glyph: '╱', label: 'Trend line' },
  { id: 'hline', glyph: '☰', label: 'Horizontal line · support / resistance' },
  { id: 'fib', glyph: '⨳', label: 'Fibonacci retracement' },
  { id: 'text', glyph: '✍️', label: 'Text / annotation' },
  { id: 'ruler', glyph: '📏', label: 'Ruler · price range' },
];

const btn = 'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border text-[15px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-40';
const on = 'border-accent/40 bg-accent/30 text-accent';
const off = 'border-transparent text-muted hover:bg-line hover:text-ink';

/** Vertical TradingView / Angel One-style drawing toolbar, docked on the left edge of the chart. */
export function DrawingToolbar({ tool, onTool, magnet, onMagnet, locked, onLock, visible, onVisible, count, onClear }: Props) {
  return (
    <div role="toolbar" aria-label="Drawing tools" aria-orientation="vertical" data-testid="drawing-toolbar" className="z-20 flex w-10 shrink-0 flex-col items-center gap-1.5 overflow-y-auto border-r border-line bg-panel/80 py-2">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          onClick={() => onTool(t.id)}
          aria-pressed={tool === t.id}
          aria-label={t.label}
          title={t.label}
          data-testid={`tool-${t.id}`}
          disabled={locked && t.id !== 'cursor'}
          className={`${btn} ${tool === t.id ? on : off}`}
        >
          <span aria-hidden>{t.glyph}</span>
        </button>
      ))}
      <span className="my-0.5 h-px w-5 bg-line" aria-hidden />
      <button onClick={onMagnet} aria-pressed={magnet} aria-label="Magnet mode · snap to candle OHLC" title="Magnet mode · snap to candle OHLC" data-testid="tool-magnet" className={`${btn} ${magnet ? on : off}`}>
        <span aria-hidden>🧲</span>
      </button>
      <button onClick={onLock} aria-pressed={locked} aria-label={locked ? 'Unlock drawings' : 'Lock drawings'} title={locked ? 'Unlock drawings' : 'Lock drawings'} data-testid="tool-lock" className={`${btn} ${locked ? on : off}`}>
        <span aria-hidden>{locked ? '🔒' : '🔓'}</span>
      </button>
      <button onClick={onVisible} aria-pressed={!visible} aria-label={visible ? 'Hide drawings' : 'Show drawings'} title={visible ? 'Hide drawings' : 'Show drawings'} data-testid="tool-visibility" className={`${btn} ${!visible ? on : off}`}>
        <span aria-hidden>{visible ? '👁️' : '🙈'}</span>
      </button>
      <button onClick={onClear} disabled={locked || count === 0} aria-label="Clear all drawings" title={count === 0 ? 'No drawings' : `Clear all drawings (${count})`} data-testid="tool-clear" className={`${btn} ${off}`}>
        <span aria-hidden>🗑️</span>
      </button>
    </div>
  );
}
