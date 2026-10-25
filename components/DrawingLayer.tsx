'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Candle } from '@/lib/types';
import { FIB_LEVELS, MAX_BRUSH_POINTS, MAX_DRAWINGS, barInterval, fibPrice, formatDuration, logicalToTime, moveDrawing, rangeStats, rulerStats, snapToBar, timeToLogical, type Drawing, type Pt, type Tool } from '@/lib/drawings';
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
const TWO_POINT: Tool[] = ['trend', 'fib', 'ruler', 'range'];
type TwoPoint = 'trend' | 'fib' | 'ruler' | 'range';

/**
 * SVG overlay that draws / edits annotations on top of the Lightweight Charts canvas.
 * The layer itself never takes pointer events, so pan, zoom, crosshair and the price / time axes always reach the chart:
 *   • pointer tool / eraser — only the drawn shapes (and their handles) accept events; wheel events over a shape are forwarded to the chart;
 *   • a drawing tool — listens on the chart host in the capture phase, but only inside the plot area (axes stay usable), and only then stops the chart's own pan.
 */
export function DrawingLayer({ chart, series, getBars, tool, onTool, magnet, locked, visible, drawings, setDrawings }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const [pending, setPending] = useState<Pt | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [stroke, setStroke] = useState<Pt[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [textAt, setTextAt] = useState<{ pt: Pt; x: number; y: number } | null>(null);
  const downPx = useRef<{ x: number; y: number } | null>(null);
  const strokeRef = useRef<{ pts: Pt[]; px: { x: number; y: number }[] } | null>(null);
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
      const vr = ts.getVisibleLogicalRange();
      const sig = [vr ? `${vr.from.toFixed(3)}~${vr.to.toFixed(3)}` : '', ts.logicalToCoordinate(0 as never), ts.logicalToCoordinate(100 as never), series.priceToCoordinate(0), series.priceToCoordinate(1000), box.current?.clientWidth, box.current?.clientHeight, getBars().length].join('|');
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
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
  };
  /** pointer event → data point (null outside the plot area, so the price / time axes are never captured) */
  const toPt = (e: { clientX: number; clientY: number }, snap = true): Pt | null => {
    const l = local(e);
    if (!l) return null;
    const { w, h } = plot();
    if (l.x < 0 || l.y < 0 || l.x > w || l.y > h) return null;
    const logical = chart.timeScale().coordinateToLogical(l.x);
    const price = series.coordinateToPrice(l.y);
    if (logical === null || price === null) return null;
    const p: Pt = { t: logicalToTime(bars, logical, iv), p: price };
    return magnet && snap ? snapToBar(bars, p, iv) : p;
  };

  /* ── lifecycle: tool change cancels anything half-drawn ── */
  useEffect(() => {
    setPending(null);
    setHover(null);
    setStroke(null);
    strokeRef.current = null;
    setTextAt(null);
    downPx.current = null;
  }, [tool]);

  useEffect(() => {
    if (locked) setSelected(null);
  }, [locked]);

  /* Delete removes the selected drawing; Esc cancels a half-drawn one; clicking anywhere that isn't a drawing deselects */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (pending || strokeRef.current)) {
        setPending(null);
        setHover(null);
        setStroke(null);
        strokeRef.current = null;
        return;
      }
      if (!selected || locked) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setDrawings((cur) => cur.filter((d) => d.id !== selected));
        setSelected(null);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('[data-drawing],[data-drawing-ui]')) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [selected, locked, pending, setDrawings]);

  const add = (d: Drawing, stay = false) => {
    setDrawings((cur) => (cur.length >= MAX_DRAWINGS ? cur : [...cur, d]));
    if (stay) return;
    setSelected(d.id);
    onTool('cursor');
  };

  const finishTwoPoint = (a: Pt, b: Pt) => {
    if (a.t === b.t && a.p === b.p) return; // zero-length
    add({ id: uid(), kind: tool as TwoPoint, a, b });
    setPending(null);
    setHover(null);
  };

  /* ── drawing-tool interaction (native listeners on the chart host: nothing is captured outside the plot, wheel + axis drags always reach the chart) ── */
  const onDraw = (e: PointerEvent, p: Pt) => {
    if (tool === 'hline') return add({ id: uid(), kind: 'hline', a: p });
    if (tool === 'text') {
      const l = local(e)!;
      return setTextAt({ pt: p, x: l.x, y: l.y });
    }
    if (tool === 'brush') {
      const l = local(e)!;
      strokeRef.current = { pts: [p], px: [l] };
      return setStroke([p]);
    }
    if (TWO_POINT.includes(tool)) {
      if (!pending) {
        setPending(p);
        downPx.current = { x: e.clientX, y: e.clientY };
      } else finishTwoPoint(pending, p); // second click
    }
  };
  const onMove = (e: PointerEvent) => {
    const sr = strokeRef.current;
    if (sr) {
      const p = toPt(e, false);
      const l = local(e);
      const lastPx = sr.px[sr.px.length - 1];
      if (p && l && Math.hypot(l.x - lastPx.x, l.y - lastPx.y) >= 3 && sr.pts.length < MAX_BRUSH_POINTS) {
        sr.pts.push(p);
        sr.px.push(l);
        setStroke([...sr.pts]);
      }
      return;
    }
    if (pending) setHover(toPt(e));
  };
  const onUp = (e: PointerEvent) => {
    const sr = strokeRef.current;
    if (sr) {
      strokeRef.current = null;
      setStroke(null);
      if (sr.pts.length >= 2) add({ id: uid(), kind: 'brush', a: sr.pts[0], pts: sr.pts }, true);
      return;
    }
    // press-drag-release also completes a two-point drawing
    const st = downPx.current;
    downPx.current = null;
    if (!st || !pending) return;
    if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > 6) {
      const p = toPt(e);
      if (p) finishTwoPoint(pending, p);
    }
  };

  const live = useRef({ onDraw, onMove, onUp, toPt, armed: false });
  live.current = { onDraw, onMove, onUp, toPt, armed: tool !== 'cursor' && tool !== 'erase' && !locked };
  useEffect(() => {
    const el = box.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const inPlot = (e: PointerEvent | MouseEvent) => !!live.current.toPt(e as PointerEvent, false);
    const swallow = (e: Event) => {
      if (live.current.armed && inPlot(e as MouseEvent)) e.stopPropagation(); // keep the chart's own pan / crosshair-drag from starting
    };
    const down = (e: PointerEvent) => {
      if (!live.current.armed || e.button !== 0 || (e.target as Element).closest?.('[data-drawing-ui]')) return;
      const p = live.current.toPt(e);
      if (!p) return; // axes / outside the plot stay with the chart
      e.stopPropagation();
      e.preventDefault();
      live.current.onDraw(e, p);
    };
    const move = (e: PointerEvent) => live.current.onMove(e);
    const up = (e: PointerEvent) => live.current.onUp(e);
    // wheel over a drawn shape must still zoom the chart: re-dispatch it to whatever lies underneath
    const wheel = (e: WheelEvent) => {
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((n) => !el.contains(n));
      if (!under) return;
      e.preventDefault();
      under.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey }));
    };
    host.addEventListener('pointerdown', down, true);
    host.addEventListener('mousedown', swallow, true);
    host.addEventListener('touchstart', swallow, true);
    host.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      host.removeEventListener('pointerdown', down, true);
      host.removeEventListener('mousedown', swallow, true);
      host.removeEventListener('touchstart', swallow, true);
      host.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  /* ── select, move and resize finished drawings (pointer tool) / erase (eraser tool) ── */
  const grab = (d: Drawing, mode: 'move' | 'a' | 'b' = 'move') => (e: React.PointerEvent) => {
    if (locked) return;
    if (tool === 'erase') {
      e.stopPropagation();
      setDrawings((cur) => cur.filter((x) => x.id !== d.id));
      if (selected === d.id) setSelected(null);
      return;
    }
    if (tool !== 'cursor') return;
    e.stopPropagation();
    e.preventDefault();
    setSelected(d.id);
    const l0 = local(e);
    if (!l0) return;
    let lg = chart.timeScale().coordinateToLogical(l0.x);
    let pr = series.coordinateToPrice(l0.y);
    if (lg === null || pr === null) return;
    const mv = (ev: PointerEvent) => {
      const l = local(ev);
      if (!l) return;
      if (mode === 'move') {
        const nl = chart.timeScale().coordinateToLogical(l.x);
        const np = series.coordinateToPrice(l.y);
        if (nl === null || np === null || lg === null || pr === null) return;
        const dB = nl - lg;
        const dP = np - pr;
        lg = nl;
        pr = np;
        setDrawings((cur) => cur.map((x) => (x.id === d.id ? moveDrawing(x, dB, dP, getBars(), barInterval(getBars(), 60)) : x)));
      } else {
        const np = toPt(ev);
        if (!np) return;
        setDrawings((cur) => cur.map((x) => (x.id === d.id && 'b' in x ? { ...x, [mode]: np } : x)));
      }
    };
    const end = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
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
  const idle = !locked && (tool === 'cursor' || tool === 'erase');
  const cur = locked ? 'default' : tool === 'erase' ? 'pointer' : 'move';
  const shapeEvents = (d: Drawing) => ({ 'data-drawing': d.id, onPointerDown: grab(d) });
  const hit = { pointerEvents: (idle ? 'stroke' : 'none') as 'none' | 'stroke', cursor: cur, touchAction: 'none' as const };

  const handle = (d: Drawing, mode: 'a' | 'b', x: number, y: number, color: string) => (
    <circle key={mode} data-drawing-ui data-testid={`drawing-handle-${mode}`} cx={x} cy={y} r={5} fill={color} stroke="rgb(var(--c-bg))" strokeWidth={1.5} onPointerDown={grab(d, mode)} style={{ pointerEvents: idle ? 'all' : 'none', cursor: 'grab', touchAction: 'none' }} />
  );

  const renderLine = (d: Drawing, x1: number, y1: number, x2: number, y2: number, color: string, dash?: string, handles = true) => {
    const sel = selected === d.id;
    return (
      <g key={d.id} {...shapeEvents(d)}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} style={hit} />
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={sel ? 2.25 : 1.5} strokeDasharray={dash} style={{ pointerEvents: 'none' }} />
        {sel && handles && 'b' in d && (
          <>
            {handle(d, 'a', x1, y1, color)}
            {handle(d, 'b', x2, y2, color)}
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
          <text x={x} y={y} fontSize={12} fontWeight={600} fill={INK} stroke="rgb(var(--c-bg))" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: idle ? 'all' : 'none', cursor: cur, userSelect: 'none', touchAction: 'none' }}>{d.text}</text>
          {selected === d.id && <circle cx={x} cy={y} r={3.5} fill={ACCENT} style={{ pointerEvents: 'none' }} />}
        </g>
      );
    }
    if (d.kind === 'brush') {
      const pts: [number, number][] = [];
      for (const q of d.pts) {
        const px = X(q.t);
        const py = Y(q.p);
        if (px !== null && py !== null) pts.push([px, py]);
      }
      if (pts.length < 2) return null;
      const path = pts.map((q) => q.join(',')).join(' ');
      return (
        <g key={d.id} {...shapeEvents(d)}>
          <polyline points={path} fill="none" stroke="transparent" strokeWidth={12} strokeLinejoin="round" style={hit} />
          <polyline points={path} fill="none" stroke={ACCENT} strokeWidth={selected === d.id ? 2.75 : 2} strokeLinejoin="round" strokeLinecap="round" style={{ pointerEvents: 'none' }} />
        </g>
      );
    }
    const x1 = X(d.a.t);
    const y1 = Y(d.a.p);
    const x2 = X(d.b.t);
    const y2 = Y(d.b.p);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    if (d.kind === 'trend') return renderLine(d, x1, y1, x2, y2, ACCENT);
    if (d.kind === 'range') {
      const st = rangeStats(d.a, d.b);
      const col = st.dPrice >= 0 ? UP : DOWN;
      const top = Math.min(y1, y2);
      const label = `${st.dPrice >= 0 ? '+' : ''}${fmt(st.dPrice)} (${fmtPct(st.dPct)})`;
      const sel = selected === d.id;
      return (
        <g key={d.id} {...shapeEvents(d)}>
          <rect x={0} y={top} width={Math.max(0, w)} height={Math.abs(y2 - y1)} fill={col} fillOpacity={0.1} stroke="none" style={{ pointerEvents: idle && !preview ? 'all' : 'none', cursor: cur, touchAction: 'none' }} />
          <line x1={0} x2={w} y1={y1} y2={y1} stroke={col} strokeWidth={sel ? 2 : 1} strokeDasharray="5 3" style={{ pointerEvents: 'none' }} />
          <line x1={0} x2={w} y1={y2} y2={y2} stroke={col} strokeWidth={sel ? 2 : 1} strokeDasharray="5 3" style={{ pointerEvents: 'none' }} />
          <g style={{ pointerEvents: 'none' }}>
            <rect x={w - label.length * 6.4 - 12} y={top + Math.abs(y2 - y1) / 2 - 9} width={label.length * 6.4 + 8} height={18} rx={4} fill="rgb(var(--c-panel))" stroke={col} strokeOpacity={0.7} />
            <text x={w - 8} y={top + Math.abs(y2 - y1) / 2 + 4} textAnchor="end" fontSize={10.5} fontWeight={600} fill={col}>{label}</text>
          </g>
          {sel && (
            <>
              {handle(d, 'a', x1, y1, col)}
              {handle(d, 'b', x2, y2, col)}
            </>
          )}
        </g>
      );
    }
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
        <rect x={bx} y={by} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} fill={col} fillOpacity={preview ? 0.1 : 0.12} stroke={col} strokeOpacity={0.6} strokeWidth={selected === d.id ? 2 : 1} style={{ pointerEvents: idle && !preview ? 'all' : 'none', cursor: cur, touchAction: 'none' }} />
        <g style={{ pointerEvents: 'none' }}>
          <rect x={bx + Math.abs(x2 - x1) / 2 - label.length * 3.1} y={by - 22} width={label.length * 6.2} height={18} rx={4} fill="rgb(var(--c-panel))" stroke={col} strokeOpacity={0.7} />
          <text x={bx + Math.abs(x2 - x1) / 2} y={by - 9} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={col}>{label}</text>
        </g>
        {selected === d.id && (
          <>
            {handle(d, 'a', x1, y1, col)}
            {handle(d, 'b', x2, y2, col)}
          </>
        )}
      </g>
    );
  };

  const previewDrawing: Drawing | null = pending && hover && TWO_POINT.includes(tool) ? { id: '__preview', kind: tool as TwoPoint, a: pending, b: hover } : null;
  const strokePreview: Drawing | null = stroke && stroke.length >= 2 ? { id: '__stroke', kind: 'brush', a: stroke[0], pts: stroke } : null;
  const sel = drawings.find((d) => d.id === selected && visible);
  const selX = sel ? X(sel.a.t) : null;
  const selY = sel ? Y(sel.a.p) : null;

  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-10" data-testid="drawing-layer" data-tool={tool} {...(tool !== 'cursor' ? { 'data-overlay': '' } : {})} data-count={drawings.length} data-selected={selected ?? ''}>
      <svg className="absolute inset-0 h-full w-full overflow-hidden" style={{ pointerEvents: 'none' }}>
        <defs>
          <clipPath id="dl-plot">
            <rect x={0} y={0} width={Math.max(0, w)} height={Math.max(0, h)} />
          </clipPath>
        </defs>
        <g clipPath="url(#dl-plot)" visibility={visible ? 'visible' : 'hidden'}>
          {drawings.map((d) => renderDrawing(d))}
          {previewDrawing && renderDrawing(previewDrawing, true)}
          {strokePreview && renderDrawing(strokePreview, true)}
          {pending && !hover && <circle cx={X(pending.t) ?? 0} cy={Y(pending.p) ?? 0} r={4} fill={ACCENT} />}
        </g>
      </svg>
      {sel && !locked && selX !== null && selY !== null && selX >= 0 && selX <= w - 30 && selY >= 28 && selY <= h && (
        <button
          type="button"
          data-drawing-ui
          data-testid="drawing-delete"
          aria-label="Delete drawing (Del)"
          title="Delete drawing (Del)"
          onClick={() => {
            setDrawings((c) => c.filter((x) => x.id !== sel.id));
            setSelected(null);
          }}
          className="pointer-events-auto absolute flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-900/90 text-[13px] leading-none text-slate-300 shadow hover:border-red-500/60 hover:text-red-400"
          style={{ left: selX + 8, top: selY - 28 }}
        >
          ✕
        </button>
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
          data-drawing-ui
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
