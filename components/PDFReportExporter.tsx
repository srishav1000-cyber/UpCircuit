'use client';

import { useState } from 'react';
import type { FeedMode, MarketEngine } from '@/lib/market';
import type { Holding, NewsResponse, Quote } from '@/lib/types';
import type { Screener } from '@/lib/screener';
import type { CopilotAnswer } from '@/lib/copilot';
import { relevantHeadlines } from '@/lib/copilot';
import { buildAskContext } from '@/lib/ask';
import { ANALYST_PROMPT, buildReport } from '@/lib/report';
import { pivotLevels, rsi14 } from '@/lib/analytics';
import { buildPdfModel, renderPdf, type PdfTheme } from '@/lib/pdfGenerator';

interface Opts {
  quote: Quote;
  screener: Screener;
  engine: MarketEngine;
  holdings?: Holding[];
  mode: FeedMode;
  theme: PdfTheme;
}

/** Collects the real numbers + the AI note + the news tone, builds the PDF and returns it (no download yet). */
export async function buildResearchPdf({ quote, screener, engine, holdings = [], mode, theme }: Opts) {
  const symbol = quote.symbol;
  const hist = engine.historyOf(symbol, '1Y');
  const closes = hist.length ? [...hist.slice(0, -1).map((c) => c.close), quote.ltp] : [];
  const prev = hist[hist.length - 2];
  const pb = screener.bookValue && screener.bookValue > 0 ? quote.ltp / screener.bookValue : null;

  const get = async <T,>(url: string, init?: RequestInit): Promise<T | null> => {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(40_000) });
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const [aiRes, newsRes] = await Promise.all([
    get<Partial<CopilotAnswer>>('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: ANALYST_PROMPT(symbol, quote.name), history: [], context: buildAskContext(engine, holdings, symbol, mode) }) }),
    get<NewsResponse>('/api/news'),
  ]);
  const ai = aiRes?.answer ? { text: aiRes.answer, source: aiRes.source === 'gemini' || aiRes.source === 'cache' ? 'Gemini AI' : 'Local rules engine' } : null;
  const rel = newsRes ? relevantHeadlines({ symbol, name: quote.name }, newsRes.items, 6) : null;

  const model = buildPdfModel({
    report: buildReport(quote, screener),
    closes,
    rsi: closes.length > 15 ? rsi14(closes) : null,
    pivots: prev ? pivotLevels(prev.high, prev.low, prev.close) : null,
    pb,
    ai,
    news: rel && newsRes ? { items: rel.items.map((x) => ({ title: x.title, source: x.source, label: x.label, score: x.score })), specific: rel.specific, sample: newsRes.mode === 'sample' } : null,
    feed: mode === 'live' ? 'Prices streamed live via SmartAPI' : 'Prices from the last session (not live ticks)',
  });
  return renderPdf(model, theme);
}

/** Generates the PDF and triggers the browser download. */
export async function downloadResearchPdf(o: Opts): Promise<{ pages: number; fileName: string; bytes: number }> {
  const { blob, pages, fileName } = await buildResearchPdf(o);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { pages, fileName, bytes: blob.size };
}

/** Stand-alone "Export Research Report" button (light / dark printable PDF). The terminal's header uses the same generator through ExportReport's menu. */
export function PDFReportExporter({ quote, screener, engine, holdings, mode, theme = 'light', className = '' }: Omit<Opts, 'theme'> & { theme?: PdfTheme; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <button
      type="button"
      disabled={busy}
      data-testid="pdf-export"
      onClick={async () => {
        setBusy(true);
        setErr(null);
        try { await downloadResearchPdf({ quote, screener, engine, holdings, mode, theme }); } catch (e) { setErr(e instanceof Error ? e.message : 'PDF failed'); } finally { setBusy(false); }
      }}
      className={`flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink hover:bg-line disabled:cursor-wait disabled:opacity-60 ${className}`}
    >
      <span aria-hidden>📄</span>{busy ? 'Building PDF…' : 'Export Research Report'}
      {err && <span role="alert" className="text-down">{err}</span>}
    </button>
  );
}
