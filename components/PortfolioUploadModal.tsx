'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MarketEngine, FeedMode } from '@/lib/market';
import type { Holding, Instrument } from '@/lib/types';
import { parsePortfolioCsv, type CsvResult } from '@/lib/csv';
import { buildNameIndex, parseHoldingsText, rowsToResult } from '@/lib/portfolioText';
import { canvasToJpegBase64, imageToCanvas, ocrCanvas, pdfToCanvases, pdfToText } from '@/lib/ocr';
import { portfolioDiagnostics } from '@/lib/analytics';
import { buildAskContext } from '@/lib/ask';
import type { CopilotAnswer } from '@/lib/copilot';
import { fmt, fmtInt } from '@/lib/format';
import { C } from '@/lib/theme';
import { Badge } from './ui';
import { StockAutocomplete } from './StockAutocomplete';

const MAX_CSV = 1_000_000;
const MAX_BINARY = 12_000_000;
const SAMPLE = 'symbol,quantity,buy_price\nRELIANCE,25,2480.50\nTCS,10,3320\nHDFCBANK,40,1610.25\nINFY,30,1475\n';

type Method = 'csv' | 'pdf-text' | 'ocr' | 'vision';
const METHOD_LABEL: Record<Method, string> = { csv: 'CSV', 'pdf-text': 'PDF text', ocr: 'In-browser OCR', vision: 'Gemini vision' };
const VISION_REASON: Record<string, string> = {
  no_key: 'Gemini isn’t configured on the server — keeping the OCR result.',
  quota: 'Gemini quota reached — keeping the OCR result.',
  cooldown: 'Gemini is cooling down after an error — keeping the OCR result.',
  auth: 'Gemini rejected the API key — keeping the OCR result.',
  error: 'Gemini couldn’t read that image — keeping the OCR result.',
};

interface Row {
  symbol: string;
  qty: number;
  avg: number;
}

interface Props {
  instruments: Instrument[];
  engine: MarketEngine;
  mode: FeedMode;
  onImport: (h: Holding[]) => void;
  onReset: () => void;
  onClose: () => void;
  /** add ONE holding (merged into the current portfolio at the weighted-average price); returns an error message or null */
  onAddHolding?: (h: Holding) => string | null;
}

/**
 * Portfolio import: CSV, PNG/JPG screenshots and PDF statements → editable [symbol, quantity, buy price] rows
 * plus concentration / diversification / sector / rebalancing diagnostics before anything is replaced.
 *
 * Privacy: CSV, PDF text and OCR all run in the browser. An image only leaves the device if the user clicks
 * "Re-read with Gemini vision".
 */
export function PortfolioUploadModal({ instruments, engine, mode, onImport, onReset, onClose, onAddHolding }: Props) {
  const [addQty, setAddQty] = useState('');
  const [addAvg, setAddAvg] = useState('');
  const known = useMemo(() => new Set(instruments.map((i) => i.symbol)), [instruments]);
  const names = useMemo(() => buildNameIndex(instruments), [instruments]);
  const dialog = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvases = useRef<HTMLCanvasElement[]>([]);

  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [method, setMethod] = useState<Method | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ label: string; progress: number | null } | null>(null);
  const [drag, setDrag] = useState(false);
  const [ai, setAi] = useState<{ loading: boolean; text?: string; source?: string; error?: string } | null>(null);

  /* dialog behaviour: focus container, Esc, scroll lock */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, []);

  const apply = useCallback((r: CsvResult, m: Method) => {
    setRows(r.holdings.map((h) => ({ symbol: h.symbol, qty: h.qty, avg: h.avg })));
    setErrors(r.errors);
    setWarnings(Array.from(new Set(r.warnings)));
    setMethod(m);
    setAi(null);
  }, []);

  const ocrAll = useCallback(
    async (list: HTMLCanvasElement[]): Promise<string> => {
      const texts: string[] = [];
      for (let i = 0; i < list.length; i++) {
        texts.push(
          await ocrCanvas(list[i], (p, status) =>
            setBusy({ label: `Reading ${list.length > 1 ? `page ${i + 1}/${list.length} ` : ''}— ${status}…`, progress: (i + p) / list.length }),
          ),
        );
      }
      return texts.join('\n');
    },
    [],
  );

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setFatal(null);
      setNotice(null);
      setRows([]);
      setErrors([]);
      setWarnings([]);
      setMethod(null);
      setAi(null);
      canvases.current = [];
      setFileName(file.name);

      const lower = file.name.toLowerCase();
      const isCsv = lower.endsWith('.csv') || file.type === 'text/csv';
      const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
      const isImg = /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/.test(lower);
      if (!isCsv && !isPdf && !isImg) return setFatal('Unsupported file type. Use CSV, PNG/JPG or PDF.');
      if (file.size > (isCsv ? MAX_CSV : MAX_BINARY)) return setFatal(`File is too large (${(file.size / 1e6).toFixed(1)} MB; max ${isCsv ? '1' : '12'} MB).`);

      try {
        if (isCsv) {
          setBusy({ label: 'Parsing CSV…', progress: null });
          apply(parsePortfolioCsv(await file.text(), known), 'csv');
        } else if (isPdf) {
          setBusy({ label: 'Reading PDF…', progress: null });
          const text = await pdfToText(file);
          const fromText = text.replace(/\s/g, '').length >= 40 ? parseHoldingsText(text, known, names) : null;
          if (fromText && fromText.holdings.length > 0) apply(fromText, 'pdf-text');
          else {
            setNotice(fromText ? 'No holdings found in the PDF text — trying OCR on the page images.' : 'This PDF has no text layer (scanned) — running OCR on the page images.');
            const pages = await pdfToCanvases(file, 3, 2);
            canvases.current = pages;
            apply(parseHoldingsText(await ocrAll(pages), known, names), 'ocr');
          }
        } else {
          setBusy({ label: 'Preparing image…', progress: null });
          const c = await imageToCanvas(file, { minEdge: 1600 });
          canvases.current = [c];
          apply(parseHoldingsText(await ocrAll([c]), known, names), 'ocr');
        }
      } catch (e) {
        setFatal(e instanceof Error ? `Couldn’t read that file: ${e.message}` : 'Couldn’t read that file.');
      } finally {
        setBusy(null);
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [apply, known, names, ocrAll],
  );

  const readWithVision = async () => {
    if (canvases.current.length === 0) return;
    setBusy({ label: 'Uploading to Gemini vision…', progress: null });
    setNotice(null);
    try {
      const images = canvases.current.map((c) => ({ mimeType: 'image/jpeg', data: canvasToJpegBase64(c) }));
      const res = await fetch('/api/parse-portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; rows?: { symbol: string; quantity: number; buy_price: number }[]; reason?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (!j.ok || !j.rows) setNotice(VISION_REASON[j.reason ?? 'error'] ?? VISION_REASON.error);
      else if (j.rows.length === 0) setNotice('Gemini found no holdings table in the image — keeping the OCR result.');
      else apply(rowsToResult(j.rows.map((r, i) => ({ symbol: r.symbol, qty: r.quantity, price: r.buy_price, ref: `Row ${i + 1}` })), known), 'vision');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Vision request failed.');
    } finally {
      setBusy(null);
    }
  };

  /* editing */
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const validRows = rows.filter((r) => Number.isInteger(r.qty) && r.qty > 0 && r.avg > 0);
  const invested = validRows.reduce((a, r) => a + r.qty * r.avg, 0);

  /* diagnostics (weights from current market values) */
  const universeSectors = useMemo(() => Array.from(new Set(Array.from(engine.quotes.values()).map((q) => q.sector))), [engine]);
  const diag = useMemo(
    () => portfolioDiagnostics(validRows.map((r) => ({ symbol: r.symbol, sector: engine.touch(r.symbol)?.sector ?? 'Others', value: r.qty * (engine.touch(r.symbol)?.ltp ?? r.avg), invested: r.qty * r.avg })), universeSectors),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(validRows), engine, universeSectors],
  );

  const askAI = async () => {
    setAi({ loading: true });
    try {
      const ctx = buildAskContext(engine, validRows.map((r) => ({ symbol: r.symbol, qty: r.qty, avg: r.avg })), null, mode);
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Diagnose this portfolio: asset concentration risk, diversification, sector exposure and rebalancing guidelines.', context: ctx }),
      });
      const j = (await res.json()) as Partial<CopilotAnswer> & { error?: string };
      if (!res.ok || !j.answer) throw new Error(j.error ?? `HTTP ${res.status}`);
      setAi({ loading: false, text: j.answer, source: j.source });
    } catch (e) {
      setAi({ loading: false, error: e instanceof Error ? e.message : 'Request failed' });
    }
  };

  const downloadSample = () => {
    const url = URL.createObjectURL(new Blob([SAMPLE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'portfolio-sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const confirm = () => {
    if (validRows.length === 0) return;
    // merge duplicates a user may have created by editing symbols? symbols aren't editable, so rows are unique
    onImport(validRows.map((r) => ({ symbol: r.symbol, qty: r.qty, avg: Math.round(r.avg * 100) / 100 })));
    onClose();
  };

  const showVision = method === 'ocr' && canvases.current.length > 0;
  const hasResult = method !== null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Portfolio import"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-xl border border-line bg-panel shadow-2xl outline-none sm:rounded-lg"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="text-[14px] font-bold text-ink">Import portfolio</div>
            <div className="text-[11px] text-muted">CSV <code className="text-ink">symbol,quantity,buy_price</code>, a PNG/JPG screenshot, or a PDF statement</div>
          </div>
          <button onClick={onClose} aria-label="Close import (Esc)" className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[13px]">
          {onAddHolding && (
            <div className="rounded-lg border border-line bg-bg/40 p-3" data-testid="add-holding">
              <div className="mb-2 text-[12px] font-semibold text-ink">Add a holding <span className="font-normal text-muted">— search any listed stock, then press Enter or + Add</span></div>
              <StockAutocomplete
                testid="holding-search"
                instruments={instruments}
                priceOf={(sym) => engine.touch(sym)?.ltp}
                placeholder="Ticker, company name or BSE code"
                addLabel="+ Add holding"
                onAdd={(inst) => {
                  const qty = Number(addQty);
                  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) return 'Enter a whole-number quantity first.';
                  const ltp = engine.touch(inst.symbol)?.ltp;
                  const avg = addAvg.trim() === '' ? ltp : Number(addAvg);
                  if (!avg || !Number.isFinite(avg) || avg <= 0) return 'Enter your buy price (no live price for this stock yet to default to).';
                  const err = onAddHolding({ symbol: inst.symbol, qty, avg });
                  if (!err) { setAddQty(''); setAddAvg(''); }
                  return err;
                }}
              >
                <input value={addQty} onChange={(e) => setAddQty(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="Qty" aria-label="Quantity" data-testid="holding-qty" className="num w-20 rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent" />
                <input value={addAvg} onChange={(e) => setAddAvg(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="Buy ₹ (opt.)" aria-label="Buy price" data-testid="holding-avg" className="num w-28 rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent" />
              </StockAutocomplete>
              <p className="mt-1 text-[10px] text-muted">Leave the buy price empty to use the current market price. A stock you already hold is merged at the weighted-average price.</p>
            </div>
          )}
          {/* drop zone */}
          <div
            onDragOver={(e) => (e.preventDefault(), setDrag(true))}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              handleFile(e.dataTransfer.files?.[0]);
            }}
            className={`rounded-lg border-2 border-dashed px-4 py-5 text-center ${drag ? 'border-accent bg-accent/10' : 'border-line'}`}
          >
            <input ref={fileInput} type="file" accept=".csv,text/csv,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,.pdf,application/pdf" className="sr-only" aria-label="Choose portfolio file" data-testid="portfolio-file" onChange={(e) => handleFile(e.target.files?.[0])} />
            <button onClick={() => fileInput.current?.click()} disabled={!!busy} className="rounded bg-accent px-4 py-2 text-[13px] font-bold text-white hover:brightness-110 disabled:opacity-50">
              Choose file
            </button>
            <p className="mt-2 text-[12px] text-muted">or drop it here · CSV, PNG, JPG, PDF</p>
            <p className="mt-1 text-[10px] text-muted">Everything is read in your browser. Screenshots only leave your device if you choose “Re-read with Gemini vision”.</p>
          </div>

          {busy && (
            <div role="status" className="rounded border border-line bg-bg px-3 py-2">
              <div className="text-[12px] text-ink">{busy.label}</div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-line">
                <div className={`h-full rounded bg-accent ${busy.progress === null ? 'w-1/3 animate-pulse' : ''}`} style={busy.progress === null ? undefined : { width: `${Math.round(busy.progress * 100)}%` }} />
              </div>
            </div>
          )}
          {fatal && <p role="alert" className="rounded border border-down/40 bg-down/10 px-3 py-2 text-down">{fatal}</p>}
          {notice && <p className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">{notice}</p>}

          {hasResult && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span className="truncate text-ink">{fileName}</span>
                {method && <Badge tone={method === 'vision' ? 'accent' : 'muted'}>{METHOD_LABEL[method]}</Badge>}
                {(method === 'ocr' || method === 'vision') && <span className="text-warn">AI/OCR can misread digits — check every row.</span>}
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  ['Valid holdings', validRows.length, 'text-up'],
                  ['Problems', errors.length + (rows.length - validRows.length), errors.length + rows.length - validRows.length ? 'text-down' : 'text-muted'],
                  ['Invested', '₹' + fmt(invested, 0), 'text-ink'],
                ].map(([k, v, c]) => (
                  <div key={k as string} className="rounded border border-line bg-bg px-2 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
                    <div className={`num text-[15px] font-semibold ${c}`}>{v}</div>
                  </div>
                ))}
              </div>

              {showVision && (
                <div className="flex flex-wrap items-center gap-2 rounded border border-line bg-bg px-3 py-2 text-[12px]">
                  <span className="flex-1 text-muted">Numbers look off? A vision model is often more accurate on screenshots.</span>
                  <button onClick={readWithVision} disabled={!!busy} className="rounded border border-line px-2.5 py-1 font-semibold text-accent hover:bg-accent/10 disabled:opacity-50">Re-read with Gemini vision</button>
                </div>
              )}

              {errors.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-down">Problems</div>
                  <ul className="max-h-28 space-y-0.5 overflow-auto rounded border border-line bg-bg p-2 text-[12px] text-ink">
                    {errors.slice(0, 20).map((e, i) => <li key={i}>• {e}</li>)}
                    {errors.length > 20 && <li className="text-muted">…and {errors.length - 20} more</li>}
                  </ul>
                </div>
              )}
              {warnings.length > 0 && <p className="text-[12px] text-warn">{warnings.slice(0, 3).join(' · ')}</p>}

              {rows.length > 0 && (
                <div className="overflow-x-auto rounded border border-line">
                  <table className="num w-full text-[12px]" data-testid="import-rows">
                    <thead className="bg-bg text-[10px] uppercase tracking-wider text-muted">
                      <tr><th className="px-2 py-1.5 text-left font-medium">Symbol</th><th className="px-2 text-right font-medium">Qty</th><th className="px-2 text-right font-medium">Buy price</th><th className="px-2 text-right font-medium">Value</th><th className="w-8" /></tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const ok = Number.isInteger(r.qty) && r.qty > 0 && r.avg > 0;
                        return (
                          <tr key={r.symbol} className="border-t border-line">
                            <td className="px-2 py-1 font-semibold text-ink">{r.symbol}</td>
                            <td className="px-1 text-right">
                              <input aria-label={`${r.symbol} quantity`} inputMode="numeric" value={Number.isFinite(r.qty) ? r.qty : ''} onChange={(e) => setRow(i, { qty: parseInt(e.target.value.replace(/\D/g, ''), 10) || 0 })} className={`num w-16 rounded border bg-bg px-1.5 py-0.5 text-right text-ink outline-none focus:border-accent ${ok ? 'border-line' : 'border-down'}`} />
                            </td>
                            <td className="px-1 text-right">
                              <input aria-label={`${r.symbol} buy price`} inputMode="decimal" value={Number.isFinite(r.avg) ? r.avg : ''} onChange={(e) => setRow(i, { avg: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} className={`num w-24 rounded border bg-bg px-1.5 py-0.5 text-right text-ink outline-none focus:border-accent ${ok ? 'border-line' : 'border-down'}`} />
                            </td>
                            <td className="px-2 text-right text-muted">{fmtInt(r.qty * r.avg)}</td>
                            <td className="px-1 text-center"><button onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))} aria-label={`Remove ${r.symbol}`} className="text-muted hover:text-down">×</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {diag && (
                <div className="space-y-3 rounded-lg border border-line bg-bg p-3" data-testid="diagnostics">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Portfolio diagnostics</div>
                    <button onClick={askAI} disabled={ai?.loading} className="rounded border border-line px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/10 disabled:opacity-50">✨ AI diagnosis</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                    <div className="rounded border border-line bg-panel px-2 py-2"><div className="text-[10px] uppercase tracking-wider text-muted">Diversification</div><div className={`num text-[16px] font-semibold ${diag.diversification >= 55 ? 'text-up' : diag.diversification >= 35 ? 'text-warn' : 'text-down'}`}>{diag.diversification}/100</div><div className="text-[10px] text-muted">{diag.diversificationLabel}</div></div>
                    <div className="rounded border border-line bg-panel px-2 py-2"><div className="text-[10px] uppercase tracking-wider text-muted">Concentration risk</div><div className={`text-[16px] font-semibold ${diag.concentration === 'Low' ? 'text-up' : diag.concentration === 'Moderate' ? 'text-warn' : 'text-down'}`}>{diag.concentration}</div><div className="num text-[10px] text-muted">top 1: {diag.top1Pct.toFixed(1)}%</div></div>
                    <div className="rounded border border-line bg-panel px-2 py-2"><div className="text-[10px] uppercase tracking-wider text-muted">HHI</div><div className="num text-[16px] font-semibold text-ink">{Math.round(diag.hhi).toLocaleString('en-IN')}</div><div className="num text-[10px] text-muted">≈ {diag.effectiveN.toFixed(1)} equal names</div></div>
                    <div className="rounded border border-line bg-panel px-2 py-2"><div className="text-[10px] uppercase tracking-wider text-muted">Top 3 weight</div><div className="num text-[16px] font-semibold text-ink">{diag.top3Pct.toFixed(0)}%</div><div className="num text-[10px] text-muted">{diag.count} holdings</div></div>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Sector exposure</div>
                    <div className="space-y-1">
                      {diag.sectors.slice(0, 6).map((s) => (
                        <div key={s.sector} className="num flex items-center gap-2 text-[11px]">
                          <span className="w-20 shrink-0 truncate text-muted">{s.sector}</span>
                          <div className="h-1.5 flex-1 rounded bg-line"><div className="h-full rounded" style={{ width: `${Math.min(100, s.pct)}%`, background: s.pct > 35 ? C.down : C.accent }} /></div>
                          <span className="w-10 text-right text-ink">{s.pct.toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Rebalancing guidelines</div>
                    <ul className="space-y-1.5 text-[12px]">
                      {diag.advice.map((a, i) => (
                        <li key={i} className="rounded border border-line bg-panel px-2.5 py-1.5"><b className="text-ink">{a.title}.</b> <span className="text-muted">{a.detail}</span></li>
                      ))}
                    </ul>
                  </div>
                  {ai && (
                    <div className="rounded border border-line bg-panel px-3 py-2 text-[12.5px] leading-relaxed">
                      {ai.loading && <span className="text-muted">Analysing…</span>}
                      {ai.error && <span className="text-down">{ai.error}</span>}
                      {ai.text && (
                        <>
                          <div className="whitespace-pre-wrap text-ink">{ai.text}</div>
                          <div className="mt-1.5 flex gap-1.5 border-t border-line pt-1.5">
                            <Badge tone={ai.source === 'gemini' ? 'accent' : ai.source === 'cache' ? 'muted' : 'warn'}>{ai.source === 'gemini' ? 'Gemini' : ai.source === 'cache' ? 'Cached' : 'Local rules'}</Badge>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  <p className="text-[10px] text-muted">Weights use current market values{mode === 'live' ? '' : ' (last session prices)'}. Heuristic guidelines — not personalised investment advice.</p>
                </div>
              )}
              {validRows.length > 0 && <p className="text-[11px] text-muted">Importing replaces your current portfolio (saved in this browser only).</p>}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <button onClick={downloadSample} className="text-[12px] text-accent hover:underline">Sample CSV</button>
          <button onClick={() => { onReset(); onClose(); }} className="text-[12px] text-muted hover:text-ink hover:underline">Reset to demo</button>
          <span className="flex-1" />
          <button onClick={onClose} className="rounded border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-line">Cancel</button>
          <button onClick={confirm} disabled={validRows.length === 0 || !!busy} className="rounded bg-accent px-3 py-1.5 text-[12px] font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
            Replace portfolio
          </button>
        </div>
      </div>
    </div>
  );
}
