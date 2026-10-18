'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Candle } from '@/lib/types';
import { FIB_LEVELS, MAX_DRAWINGS, barInterval, fibPrice, formatDuration, logicalToTime, moveDrawing, rulerStats, snapToBar, timeToLogical, type Drawing, type Pt, type Tool } from '@/lib/drawings';
import { fmt, fmtPct } from '@/lib/format';

interface Props {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  /** current candles, oldest → newest */
  getBars: () => Candle[];
  tool: Tool;
  onTool: (t: Tool) => void;
  magnet: boolean;
  locked: boolean;
  visible: boolean;
  drawings: Drawing[];
  setDrawings: (fn: (cur: Drawing[]) => Drawing[]) => void;
}

const ACCENT = 'rgb(var(--c-accent))';
const WARN = 'rgb(var(--c-warn))';
const INK = 'rgb(var(--c-ink))';
const MUTED = 'rgb(var(--c-muted))';
const UP = 'rgb(var(--c-up))';
const DOWN = 'rgb(var(--c-down))';
const FIB_COLORS = [MUTED, DOWN, WARN, ACCENT, UP, WARN, MUTED];
const uid = () => Math.random().toString(36).slice(2, 10);
const TWO_POINT: Tool[] = ['trend', 'fib', 'ruler'];

/**
 * SVG overlay that draws / edits annotations on top of the Lightweight Charts canvas.
 * The overlay ignores pointer events while the pointer tool is active (so pan / zoom / crosshair keep working);
 * only the drawn shapes accept events (select, drag, Delete). With a drawing tool active it captures clicks.
 */
export function DrawingLayer({ chart, series, getBars, tool, onTool, magnet, locked, visible, drawings, setDrawings }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const [pending, setPending] = useState<Pt | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [textAt, setTextAt] = useState<{ pt: Pt; x: number; y: number } | null>(null);
  const downPx = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: string; bars: number; price: number } | null>(null);
  const textRef = useRef<{ pt: Pt; x: number; y: number } | null>(null);
  textRef.current = textAt;

  const bars = getBars();
  const iv = barInterval(bars, 60);

  /* ── re-render whenever the chart's view changes (zoom, pan, price-scale autoscale, resize, new bar) ── */
  useEffect(() => {
    let raf = 0;
    let last = '';
    const probe = () => {
      const ts = chart.timeScale();
      const sig = [ts.logicalToCoordinate(0 as never), ts.logicalToCoordinate(100 as never), series.priceToCoordinate(0), series.priceToCoordinate(1000), box.current?.clientWidth, box.current?.clientHeight, getBars().length].join('|');
      if (sig !== last) {
        last = sig;
        redraw();
      }
      raf = requestAnimationFrame(probe);
    };
    raf = requestAnimationFrame(probe);
    return () => cancelAnimationFrame(raf);
  }, [chart, series, getBars]);

  /* ── coordinate helpers ── */
  const X = useCallback((t: number) => chart.timeScale().logicalToCoordinate(timeToLogical(bars, t, iv) as never), [chart, bars, iv]);
  const Y = useCallback((p: number) => series.priceToCoordinate(p), [series]);
  const plot = () => {
    const w = (box.current?.clientWidth ?? 0) - chart.priceScale('right').width();
    const h = (box.current?.clientHeight ?? 0) - chart.timeScale().height();
    return { w, h };
  };
  /** pointer event → data point (null outside the plot area) */
  const toPt = (e: { clientX: number; clientY: number }): Pt | null => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return null;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const { w, h } = plot();
    if (x < 0 || y < 0 || x > w || y > h) return null;
    const logical = chart.timeScale().coordinateToLogical(x);
    const price = series.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    const p: Pt = { t: logicalToTime(bars, logical, iv), p: price };
    return magnet ? snapToBar(bars, p, iv) : p;
  };

  /* ── lifecycle: tool change cancels anything half-drawn ── */
  useEffect(() => {
    setPending(null);
    setHover(null);
    setTextAt(null);
    downPx.current = null;
  }, [tool]);

  useEffect(() => {
    if (locked) setSelected(null);
  }, [locked]);

  /* Delete removes the selected drawing; clicking anywhere that isn't a drawing deselects */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected || locked) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setDrawings((cur) => cur.filter((d) => d.id !== selected));
        setSelected(null);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('[data-drawing]')) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [selected, locked, setDrawings]);

  const add = (d: Drawing) => {
    setDrawings((cur) => (cur.length >= MAX_DRAWINGS ? cur : [...cur, d]));
    setSelected(d.id);
    onTool('cursor');
  };

  const finishTwoPoint = (a: Pt, b: Pt) => {
    if (a.t === b.t && a.p === b.p) return; // zero-length
    add({ id: uid(), kind: tool as 'trend' | 'fib' | 'ruler', a, b });
    setPending(null);
    setHover(null);
  };

  /* ── drawing-tool interaction (overlay captures the pointer only while a tool is active) ── */
  const onDown = (e: React.PointerEvent) => {
    if (tool === 'cursor' || locked) return;
    const p = toPt(e);
    if (!p) return;
    if (tool === 'hline') return add({ id: uid(), kind: 'hline', a: p });
    if (tool === 'text') {
      const r = box.current!.getBoundingClientRect();
      return setTextAt({ pt: p, x: e.clientX - r.left, y: e.clientY - r.top });
    }
    if (TWO_POINT.includes(tool)) {
      if (!pending) {
        setPending(p);
        downPx.current = { x: e.clientX, y: e.clientY };
      } else finishTwoPoint(pending, p); // second click
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (pending) setHover(toPt(e));
  };
  const onUp = (e: React.PointerEvent) => {
    // press-drag-release also completes a two-point drawing
    const s = downPx.current;
    downPx.current = null;
    if (!s || !pending) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6) {
      const p = toPt(e);
      if (p) finishTwoPoint(pending, p);
    }
  };

  /* ── select + drag a finished drawing (pointer tool) ── */
  const grab = (d: Drawing) => (e: React.PointerEvent) => {
    if (locked || tool !== 'cursor') return;
    e.stopPropagation();
    setSelected(d.id);
    const r = box.current!.getBoundingClientRect();
    const l = chart.timeScale().coordinateToLogical(e.clientX - r.left);
    const pr = series.coordinateToPrice(e.clientY - r.top);
    if (l === null || pr === null) return;
    drag.current = { id: d.id, bars: l, price: pr };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const dragMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const r = box.current!.getBoundingClientRect();
    const l = chart.timeScale().coordinateToLogical(e.clientX - r.left);
    const pr = series.coordinateToPrice(e.clientY - r.top);
    if (l === null || pr === null) return;
    const dB = l - g.bars;
    const dP = pr - g.price;
    drag.current = { ...g, bars: l, price: pr };
    setDrawings((cur) => cur.map((d) => (d.id === g.id ? moveDrawing(d, dB, dP, bars, iv) : d)));
  };
  const dragEnd = () => {
    drag.current = null;
  };

  const commitText = (value: string) => {
    const at = textRef.current;
    if (!at) return; // already committed (Enter, then the unmount blur)
    textRef.current = null;
    const text = value.trim();
    setTextAt(null);
    if (text) add({ id: uid(), kind: 'text', a: at.pt, text: text.slice(0, 80) });
    else onTool('cursor');
  };

  /* ── rendering ── */
  const { w, h } = plot();
  const shapeEvents = (d: Drawing) => ({ 'data-drawing': d.id, onPointerDown: grab(d), onPointerMove: dragMove, onPointerUp: dragEnd, onPointerCancel: dragEnd });
  const hit = { pointerEvents: (locked ? 'none' : 'stroke') as 'none' | 'stroke', cursor: locked ? 'default' : 'move' };

  const renderLine = (d: Drawing, x1: number, y1: number, x2: number, y2: number, color: string, dash?: string) => {
    const sel = selected === d.id;
    return (
      <g key={d.id} {...shapeEvents(d)}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} style={hit} />
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={sel ? 2.25 : 1.5} strokeDasharray={dash} style={{ pointerEvents: 'none' }} />
        {sel && (
          <>
            <circle cx={x1} cy={y1} r={4} fill={color} style={{ pointerEvents: 'none' }} />
            <circle cx={x2} cy={y2} r={4} fill={color} style={{ pointerEvents: 'none' }} />
          </>
        )}
      </g>
    );
  };

  const renderDrawing = (d: Drawing, preview = false) => {
    if (d.kind === 'hline') {
      const y = Y(d.a.p);
      if (y === null) return null;
      return (
        <g key={d.id}>
          {renderLine(d, 0, y, w, y, WARN, '6 4')}
          <text x={w - 6} y={y - 4} textAnchor="end" fontSize={11} fill={WARN} style={{ pointerEvents: 'none' }}>{fmt(d.a.p)}</text>
        </g>
      );
    }
    if (d.kind === 'text') {
      const x = X(d.a.t);
      const y = Y(d.a.p);
      if (x === null || y === null) return null;
      return (
        <g key={d.id} {...shapeEvents(d)}>
          <text x={x} y={y} fontSize={12} fontWeight={600} fill={INK} stroke="rgb(var(--c-bg))" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: locked ? 'none' : 'all', cursor: locked ? 'default' : 'move', userSelect: 'none' }}>{d.text}</text>
          {selected === d.id && <circle cx={x} cy={y} r={3.5} fill={ACCENT} style={{ pointerEvents: 'none' }} />}
        </g>
      );
    }
    const x1 = X(d.a.t);
    const y1 = Y(d.a.p);
    const x2 = X(d.b.t);
    const y2 = Y(d.b.p);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    if (d.kind === 'trend') return renderLine(d, x1, y1, x2, y2, ACCENT);
    if (d.kind === 'fib') {
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      return (
        <g key={d.id}>
          {FIB_LEVELS.map((lv, i) => {
            const p = fibPrice(d.a, d.b, lv);
            const y = Y(p);
            if (y === null) return null;
            return (
              <g key={lv}>
                <line x1={left} x2={right} y1={y} y2={y} stroke={FIB_COLORS[i]} strokeWidth={1} opacity={0.9} style={{ pointerEvents: 'none' }} />
                <text x={left + 4} y={y - 3} fontSize={10} fill={FIB_COLORS[i]} style={{ pointerEvents: 'none' }}>{lv} · {fmt(p)}</text>
              </g>
            );
          })}
          {renderLine(d, x1, y1, x2, y2, MUTED, '3 3')}
        </g>
      );
    }
    // ruler
    const st = rulerStats(d.a, d.b, bars, iv);
    const col = st.dPrice >= 0 ? UP : DOWN;
    const bx = Math.min(x1, x2);
    const by = Math.min(y1, y2);
    const label = `${st.dPrice >= 0 ? '+' : ''}${fmt(st.dPrice)} (${fmtPct(st.dPct)}) · ${st.bars} bars · ${formatDuration(st.seconds)}`;
    return (
      <g key={d.id} {...shapeEvents(d)}>
        <rect x={bx} y={by} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} fill={col} fillOpacity={preview ? 0.1 : 0.12} stroke={col} strokeOpacity={0.6} strokeWidth={selected === d.id ? 2 : 1} style={{ pointerEvents: locked || preview ? 'none' : 'all', cursor: locked ? 'default' : 'move' }} />
        <g style={{ pointerEvents: 'none' }}>
          <rect x={bx + Math.abs(x2 - x1) / 2 - label.length * 3.1} y={by - 22} width={label.length * 6.2} height={18} rx={4} fill="rgb(var(--c-panel))" stroke={col} strokeOpacity={0.7} />
          <text x={bx + Math.abs(x2 - x1) / 2} y={by - 9} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={col}>{label}</text>
        </g>
      </g>
    );
  };

  const previewDrawing: Drawing | null = pending && hover && TWO_POINT.includes(tool) ? { id: '__preview', kind: tool as 'trend' | 'fib' | 'ruler', a: pending, b: hover } : null;
  const drawingTool = tool !== 'cursor' && !locked;

  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-10" data-testid="drawing-layer" data-tool={tool} data-count={drawings.length}>
      <svg className="absolute inset-0 h-full w-full overflow-hidden" style={{ pointerEvents: 'none' }}>
        <defs>
          <clipPath id="dl-plot">
            <rect x={0} y={0} width={Math.max(0, w)} height={Math.max(0, h)} />
          </clipPath>
        </defs>
        <g clipPath="url(#dl-plot)" visibility={visible ? 'visible' : 'hidden'}>
          {drawings.map((d) => renderDrawing(d))}
          {previewDrawing && renderDrawing(previewDrawing, true)}
          {pending && !hover && <circle cx={X(pending.t) ?? 0} cy={Y(pending.p) ?? 0} r={4} fill={ACCENT} />}
        </g>
      </svg>
      {/* capture surface — only while a drawing tool is armed; limited to the plot area so axes stay usable */}
      {drawingTool && (
        <div
          className="pointer-events-auto absolute left-0 top-0 touch-none"
          style={{ width: Math.max(0, w), height: Math.max(0, h), cursor: 'crosshair' }}
          onPointerDown={onDown}
          onMouseDown={(e) => e.preventDefault()}
          onPointerMove={onMove}
          onPointerUp={onUp}
          data-testid="drawing-capture"
        />
      )}
      {textAt && (
        <input
          ref={(el) => {
            // focus after the click's mousedown default action (which would otherwise blur it immediately)
            if (el) window.setTimeout(() => el.focus(), 30);
          }}
          maxLength={80}
          placeholder="Type, then Enter"
          aria-label="Annotation text"
          data-testid="drawing-text-input"
          className="pointer-events-auto absolute w-44 rounded border border-accent bg-panel px-2 py-1 text-[12px] text-ink outline-none"
          style={{ left: Math.min(textAt.x, Math.max(0, w - 180)), top: Math.max(0, textAt.y - 14) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText((e.target as HTMLInputElement).value);
            else if (e.key === 'Escape') {
              e.stopPropagation();
              setTextAt(null);
              onTool('cursor');
            }
          }}
          onBlur={(e) => commitText(e.target.value)}
        />
      )}
    </div>
  );
}
