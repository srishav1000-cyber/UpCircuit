'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MarketEngine, FeedMode } from '@/lib/market';
import type { Holding } from '@/lib/types';
import type { CopilotAnswer } from '@/lib/copilot';
import { buildAskContext } from '@/lib/ask';
import { getScreener } from '@/lib/screener';
import { mergeLive } from '@/lib/yahooFundamentals';
import { ANALYST_PROMPT, buildReport, reportCsv, reportFileName } from '@/lib/report';
import { useFundamentals } from '@/hooks/useFundamentals';
import { useDismiss } from '@/hooks/useClickOutside';
import { Markdown } from './Markdown';
import { downloadResearchPdf } from './PDFReportExporter';
import type { PdfTheme } from '@/lib/pdfGenerator';

interface Props {
  symbol: string;
  engine: MarketEngine;
  holdings?: Holding[];
  mode?: FeedMode;
  className?: string;
  /** compact = icon + short label */
  compact?: boolean;
}

/** Light, print-only stylesheet: the whole app is hidden while `body.upc-printing` is set and only the report root prints (white page). */
const PRINT_CSS = `
#upc-print-root{display:none}
@media print{
  @page{size:A4;margin:14mm}
  html,body{background:#fff!important;height:auto!important;overflow:visible!important}
  body.upc-printing > *:not(#upc-print-root){display:none!important}
  body.upc-printing #upc-print-root{display:block!important;color:#111;background:#fff;font:12px/1.5 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  #upc-print-root h1{font-size:22px;margin:0}
  #upc-print-root h2{font-size:14px;margin:18px 0 6px;padding-bottom:3px;border-bottom:1px solid #cbd5e1;text-transform:uppercase;letter-spacing:.04em;color:#334155}
  #upc-print-root table{width:100%;border-collapse:collapse;font-size:11px}
  #upc-print-root th,#upc-print-root td{padding:4px 6px;border-bottom:1px solid #e2e8f0;text-align:right}
  #upc-print-root th:first-child,#upc-print-root td:first-child{text-align:left}
  #upc-print-root .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
  #upc-print-root .cell{border:1px solid #cbd5e1;border-radius:4px;padding:6px 8px}
  #upc-print-root .k{font-size:9px;text-transform:uppercase;color:#64748b}
  #upc-print-root .v{font-size:14px;font-weight:600}
  #upc-print-root .up{color:#15803d}#upc-print-root .down{color:#b91c1c}
  #upc-print-root section,#upc-print-root tr{break-inside:avoid}
  #upc-print-root *{color:inherit}
  #upc-print-root .ai{font-size:11.5px}
}`;

interface Ai { text: string; source: string }

/** "Export Research Report" — CSV (fundamentals, ratios, quarterly) or a print-styled PDF layout with the Gemini senior-analyst summary. */
export function ExportReport({ symbol, engine, holdings = [], mode = 'delayed', className = '', compact = false }: Props) {
  const quote = engine.touch(symbol);
  const live = useFundamentals(symbol, quote?.exch ?? 'NSE');
  const screener = useMemo(() => (quote ? mergeLive(getScreener(quote), live.data, quote.ltp) : null), [quote?.symbol, Math.round((quote?.ltp ?? 0) * 20), live.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'csv' | 'pdf'>(null);
  const [note, setNote] = useState('');
  const [printing, setPrinting] = useState<null | { ai: Ai | null; at: Date }>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const exportCsv = () => {
    if (!quote || !screener) return;
    setOpen(false);
    const now = new Date();
    const blob = new Blob(['﻿', reportCsv(quote, screener, now)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = reportFileName(symbol, 'csv', now);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setNote('CSV downloaded');
  };

  /** real downloadable PDF (jsPDF): Executive summary · valuation ratios · technicals · AI insights · news sentiment, light (print) or dark */
  const exportFile = async (theme: PdfTheme) => {
    if (!quote || !screener) return;
    setOpen(false);
    setBusy('pdf');
    setNote('Building PDF…');
    try {
      const r = await downloadResearchPdf({ quote, screener, engine, holdings, mode, theme });
      setNote(`PDF downloaded · ${r.fileName} · ${r.pages} page${r.pages > 1 ? 's' : ''}`);
    } catch (e) {
      setNote(`PDF failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(null);
    }
  };

  const exportPdf = async () => {
    if (!quote || !screener) return;
    setOpen(false);
    setBusy('pdf');
    setNote('Preparing report…');
    let ai: Ai | null = null;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 40_000);
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ question: ANALYST_PROMPT(symbol, quote.name), history: [], context: buildAskContext(engine, holdings, symbol, mode) }) });
      clearTimeout(t);
      const d = (await res.json().catch(() => ({}))) as Partial<CopilotAnswer>;
      if (res.ok && d.answer) ai = { text: d.answer, source: d.source === 'gemini' || d.source === 'cache' ? 'Gemini AI' : 'Local rules engine' };
    } catch {
      /* report still prints without the AI section */
    }
    setPrinting({ ai, at: new Date() });
  };

  // once the print root is mounted: print, then clean up
  useEffect(() => {
    if (!printing) return;
    const done = () => {
      document.body.classList.remove('upc-printing');
      setPrinting(null);
      setBusy(null);
      setNote('');
    };
    document.body.classList.add('upc-printing');
    window.addEventListener('afterprint', done, { once: true });
    const id = window.setTimeout(() => window.print(), 150); // let the portal paint
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  const model = quote && screener && printing ? buildReport(quote, screener, printing.at) : null;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={!quote || busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="export-report"
        title={`Export ${symbol} research report (CSV or PDF)`}
        className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink hover:bg-line disabled:cursor-wait disabled:opacity-60"
      >
        <span aria-hidden>📄</span>
        <span className={compact ? 'sr-only' : 'hidden sm:inline'}>{busy ? 'Preparing…' : 'Export Research Report'}</span>
        {!compact && <span className="sm:hidden">{busy ? '…' : 'Export'}</span>}
        <span aria-hidden className="text-[10px] text-muted">▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-[60] mt-1 w-64 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-2xl">
          <button role="menuitem" data-testid="export-csv" onClick={exportCsv} className="block w-full px-3 py-2 text-left hover:bg-line">
            <span className="block text-[13px] font-semibold text-ink">⬇ CSV</span>
            <span className="block text-[11px] text-muted">Fundamentals, key ratios, quarterly financials</span>
          </button>
          <button role="menuitem" data-testid="export-pdf" onClick={() => void exportFile('light')} className="block w-full px-3 py-2 text-left hover:bg-line">
            <span className="block text-[13px] font-semibold text-ink">⬇ PDF · light (print-ready)</span>
            <span className="block text-[11px] text-muted">Summary, ratios, technicals, AI insights, news tone</span>
          </button>
          <button role="menuitem" data-testid="export-pdf-dark" onClick={() => void exportFile('dark')} className="block w-full px-3 py-2 text-left hover:bg-line">
            <span className="block text-[13px] font-semibold text-ink">⬇ PDF · dark</span>
            <span className="block text-[11px] text-muted">Same report on the terminal&apos;s dark palette</span>
          </button>
          <button role="menuitem" data-testid="export-print" onClick={exportPdf} className="block w-full px-3 py-2 text-left hover:bg-line">
            <span className="block text-[13px] font-semibold text-ink">🖨 Print layout</span>
            <span className="block text-[11px] text-muted">Browser print dialog</span>
          </button>
        </div>
      )}
      {note && <span role="status" className="sr-only">{note}</span>}

      {model && typeof document !== 'undefined' &&
        createPortal(
          <div id="upc-print-root" data-testid="print-report">
            <style>{PRINT_CSS}</style>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 10, letterSpacing: '.12em', color: '#64748b' }}>UPCIRCUIT · EXECUTIVE RESEARCH REPORT</div>
                <h1>{model.name}</h1>
                <div style={{ color: '#475569' }}>{model.symbol} · {model.exch} · {model.sector}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>₹{model.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                <div className={model.changePct >= 0 ? 'up' : 'down'}>{model.changePct >= 0 ? '▲' : '▼'} {Math.abs(model.changePct).toFixed(2)}% today</div>
                <div style={{ fontSize: 10, color: '#64748b' }}>52W High {model.high52 === null ? 'N/A' : model.high52.toLocaleString('en-IN')} · Low {model.low52 === null ? 'N/A' : model.low52.toLocaleString('en-IN')}</div>
              </div>
            </div>

            <h2>Screener fundamentals</h2>
            <div className="grid">
              {model.grid.map((g) => (
                <div className="cell" key={g.label}><div className="k">{g.label}</div><div className="v">{g.value}</div></div>
              ))}
            </div>

            <h2>Quarterly results (₹ Cr)</h2>
            <table>
              <thead><tr><th>Metric</th>{model.quarters.map((qr) => <th key={qr.label}>{qr.label}</th>)}</tr></thead>
              <tbody>
                {([['Sales / Revenue', 'sales'], ['Expenses', 'expenses'], ['Operating Profit (EBITDA)', 'operatingProfit'], ['OPM %', 'opmPct'], ['Net Profit', 'netProfit'], ['EPS (₹)', 'eps']] as const).map(([label, key]) => (
                  <tr key={key}><td>{label}</td>{model.quarters.map((qr) => <td key={qr.label}>{qr[key].toLocaleString('en-IN')}</td>)}</tr>
                ))}
              </tbody>
            </table>

            <h2>Shareholding pattern</h2>
            <div>{model.holding ? <>Promoters <b>{model.holding.promoters}%</b> · Institutions (FII + DII) <b>{model.holding.institutions}%</b> · Public <b>{model.holding.public}%</b></> : 'N/A — not available for this scrip'}</div>

            <h2>AI senior analyst summary &amp; risk assessment {printing?.ai && <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· {printing.ai.source}</span>}</h2>
            {printing?.ai ? <div className="ai"><Markdown text={printing.ai.text.replace(/^#{1,6}\s*/gm, '### ')} /></div> : <div style={{ color: '#64748b' }}>AI summary was unavailable when this report was generated.</div>}

            <div style={{ marginTop: 18, paddingTop: 6, borderTop: '1px solid #cbd5e1', fontSize: 9.5, color: '#64748b' }}>
              Generated {model.generatedAt} · Data: {model.dataSource}{model.estimated.length ? ` · N/A: ${model.estimated.join(', ')}` : ''} · Prices are {mode === 'live' ? 'streamed live' : 'from the last session (not live ticks)'}. Educational use only — not investment advice.
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
