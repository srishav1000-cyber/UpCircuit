// One-click equity research PDF.
//   buildPdfModel(input)  — pure: turns the terminal's real numbers into ordered blocks (testable without a browser)
//   renderPdf(model, theme) — draws the blocks with jsPDF (loaded on demand, so it costs nothing until a report is requested)
// Every figure comes from the same real sources as the screen (Yahoo fundamentals + closes, SmartAPI / Yahoo LTP, RSS sentiment, AI note).
// Missing values print "N/A" — nothing is estimated. Standard PDF fonts have no ₹ glyph, so rupees print as "Rs.".
import type { ReportModel } from './report';
import type { Pivots } from './analytics';
import { rsiZone, RSI_LABEL } from './analytics/rsi';
import { emaFull } from './technicalIndicators';

export type PdfTheme = 'light' | 'dark';

export interface PdfInput {
  report: ReportModel;
  /** daily closes, last = live LTP */
  closes: number[];
  rsi: number | null;
  pivots: Pivots | null;
  /** price ÷ book value */
  pb: number | null;
  ai: { text: string; source: string } | null;
  news: { items: { title: string; source: string; label: string; score: number }[]; specific: boolean; sample: boolean } | null;
  feed: string;
}

export type Block =
  | { t: 'h2'; text: string }
  | { t: 'p'; text: string }
  | { t: 'kv'; items: { k: string; v: string }[]; cols?: number }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'bullets'; items: string[] }
  | { t: 'note'; text: string };

export interface PdfModel {
  title: string;
  subtitle: string;
  price: { text: string; change: string; up: boolean };
  blocks: Block[];
  footer: string;
  fileBase: string;
}

const n2 = (n: number | null | undefined, dp = 2) => (n === null || n === undefined || !Number.isFinite(n) ? 'N/A' : n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const rs = (n: number | null | undefined, dp = 2) => (n === null || n === undefined || !Number.isFinite(n) ? 'N/A' : `Rs. ${n2(n, dp)}`);
const find = (r: ReportModel, label: string) => r.grid.find((g) => g.label.startsWith(label))?.value ?? 'N/A';

/** markdown → plain lines for the PDF (headings and bullets kept, emphasis stripped) */
export function mdToBlocks(md: string): Block[] {
  const out: Block[] = [];
  let bullets: string[] = [];
  const flush = () => { if (bullets.length) { out.push({ t: 'bullets', items: bullets }); bullets = []; } };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
    if (!line) { flush(); continue; }
    const h = line.match(/^#{1,6}\s*(.+)$/);
    const b = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (h) { flush(); out.push({ t: 'p', text: `§${h[1]}` }); } // § marks a sub-heading
    else if (b) bullets.push(b[1]);
    else { flush(); out.push({ t: 'p', text: line }); }
  }
  flush();
  return out;
}

export function buildPdfModel(i: PdfInput): PdfModel {
  const r = i.report;
  const px = i.closes.length ? i.closes[i.closes.length - 1] : r.ltp;
  const e20 = i.closes.length >= 20 ? emaFull(i.closes, 20).at(-1) ?? null : null;
  const e50 = i.closes.length >= 50 ? emaFull(i.closes, 50).at(-1) ?? null : null;
  const zone = rsiZone(i.rsi);
  const up = r.changePct >= 0;

  // technical reading, strictly from the numbers above
  const trend: string[] = [];
  if (e20 !== null) trend.push(`price is ${px >= e20 ? 'above' : 'below'} its 20-day EMA`);
  if (e50 !== null) trend.push(`${px >= e50 ? 'above' : 'below'} its 50-day EMA`);
  if (e20 !== null && e50 !== null) trend.push(e20 >= e50 ? 'EMA 20 sits above EMA 50 (bullish alignment)' : 'EMA 20 sits below EMA 50 (bearish alignment)');
  const tech = trend.length ? `${trend.join('; ')}.` : 'Not enough daily history for moving averages.';

  const nw = i.news;
  const bull = nw ? nw.items.filter((x) => x.label === 'Bullish').length : 0;
  const bear = nw ? nw.items.filter((x) => x.label === 'Bearish').length : 0;
  const avg = nw && nw.items.length ? nw.items.reduce((a, x) => a + x.score, 0) / nw.items.length : null;
  const tone = avg === null ? null : avg >= 0.15 ? 'Bullish' : avg <= -0.15 ? 'Bearish' : 'Neutral';

  const summary = [
    `${r.name} (${r.symbol}, ${r.exch}) is a ${r.sector} stock last at ${rs(r.ltp)}, ${up ? 'up' : 'down'} ${Math.abs(r.changePct).toFixed(2)}% on the day, with a market capitalisation of ${find(r, 'Market Cap') === 'N/A' ? 'N/A' : `Rs. ${find(r, 'Market Cap')} Cr`}.`,
    `Valuation: P/E ${find(r, 'Stock P/E')}, P/B ${i.pb === null ? 'N/A' : i.pb.toFixed(2)}; quality: ROCE ${find(r, 'ROCE')}%, ROE ${find(r, 'ROE')}%, debt-to-equity ${find(r, 'Debt to Equity')}.`,
    `Technicals: ${i.rsi === null ? 'RSI N/A' : `RSI(14) ${i.rsi.toFixed(1)} (${RSI_LABEL[zone!].toLowerCase()})`}; ${tech}`,
    tone ? `News tone: ${tone} (${bull} bullish / ${bear} bearish of ${nw!.items.length} headlines${nw!.specific ? '' : ', market-wide'}).` : 'News tone: unavailable.',
  ];

  const blocks: Block[] = [
    { t: 'h2', text: 'Executive summary & company profile' },
    { t: 'p', text: summary.join(' ') },
    { t: 'kv', cols: 4, items: [{ k: 'Company', v: r.name }, { k: 'Ticker / exchange', v: `${r.symbol} · ${r.exch}` }, { k: 'Sector', v: r.sector }, { k: 'Last price', v: rs(r.ltp) }, { k: 'Day change', v: `${up ? '+' : '-'}${Math.abs(r.changePct).toFixed(2)}%` }, { k: '52-week high', v: rs(r.high52) }, { k: '52-week low', v: rs(r.low52) }, { k: 'Shareholding', v: r.holding ? `Promoters ${r.holding.promoters}% · Inst. ${r.holding.institutions}% · Public ${r.holding.public}%` : 'N/A' }] },
    { t: 'h2', text: 'Key valuation ratios' },
    { t: 'kv', cols: 4, items: [{ k: 'P/E', v: find(r, 'Stock P/E') }, { k: 'P/B', v: i.pb === null ? 'N/A' : i.pb.toFixed(2) }, { k: 'Market cap (Rs. Cr)', v: find(r, 'Market Cap') }, { k: 'ROCE (%)', v: find(r, 'ROCE') }, { k: 'ROE (%)', v: find(r, 'ROE') }, { k: 'Debt / equity', v: find(r, 'Debt to Equity') }, { k: 'EPS TTM (Rs.)', v: find(r, 'EPS') }, { k: 'Dividend yield (%)', v: find(r, 'Dividend Yield') }] },
    { t: 'h2', text: 'Technical summary' },
    { t: 'kv', cols: 4, items: [{ k: 'EMA 20', v: n2(e20) }, { k: 'EMA 50', v: n2(e50) }, { k: 'RSI (14)', v: i.rsi === null ? 'N/A' : `${i.rsi.toFixed(1)} · ${RSI_LABEL[zone!]}` }, { k: 'Price vs EMA 20', v: e20 === null ? 'N/A' : `${px >= e20 ? 'Above' : 'Below'} (${(((px / e20) - 1) * 100).toFixed(2)}%)` }] },
    i.pivots
      ? { t: 'table', head: ['Level', 'R2', 'R1', 'Pivot', 'S1', 'S2'], rows: [['Support / resistance (Rs.)', n2(i.pivots.r2), n2(i.pivots.r1), n2(i.pivots.p), n2(i.pivots.s1), n2(i.pivots.s2)]] }
      : { t: 'note', text: 'Support / resistance pivots need the previous session\'s bar (not yet loaded).' },
    { t: 'p', text: `Reading: ${tech}` },
    { t: 'h2', text: `AI copilot valuation insights${i.ai ? ` (${i.ai.source})` : ''}` },
    ...(i.ai ? mdToBlocks(i.ai.text) : [{ t: 'note', text: 'The AI summary was unavailable when this report was generated.' } as Block]),
    { t: 'h2', text: 'News sentiment summary' },
    ...(nw && nw.items.length
      ? ([
          { t: 'kv', cols: 4, items: [{ k: 'Overall tone', v: `${tone} (${avg! >= 0 ? '+' : ''}${avg!.toFixed(2)})` }, { k: 'Bullish', v: String(bull) }, { k: 'Bearish', v: String(bear) }, { k: 'Neutral', v: String(nw.items.length - bull - bear) }] },
          { t: 'bullets', items: nw.items.slice(0, 6).map((x) => `[${x.label}] ${x.title} - ${x.source}`) },
          { t: 'note', text: nw.sample ? 'Live RSS feeds were unreachable: these are built-in sample headlines.' : nw.specific ? 'Headlines mention this company.' : 'No headline names this company; showing the latest market-wide headlines.' },
        ] as Block[])
      : ([{ t: 'note', text: 'News sentiment unavailable.' }] as Block[])),
  ];

  return {
    title: r.name,
    subtitle: `${r.symbol} · ${r.exch} · ${r.sector}`,
    price: { text: rs(r.ltp), change: `${up ? '+' : '-'}${Math.abs(r.changePct).toFixed(2)}% today`, up },
    blocks,
    footer: `Generated ${r.generatedAt} · ${i.feed} · Data: ${r.dataSource}${r.estimated.length ? ` · N/A: ${r.estimated.join(', ')}` : ''} · Educational use only, not investment advice.`,
    fileBase: `UpCircuit_${r.symbol.replace(/[^A-Za-z0-9_-]/g, '')}_research_${new Date().toISOString().slice(0, 10)}`,
  };
}

/* ───────────────────────── rendering ───────────────────────── */

const PALETTE = {
  light: { bg: [255, 255, 255], text: [17, 24, 39], muted: [100, 116, 139], rule: [203, 213, 225], accent: [29, 78, 216], up: [21, 128, 61], down: [185, 28, 28], cell: [248, 250, 252] },
  dark: { bg: [11, 18, 32], text: [226, 232, 240], muted: [148, 163, 184], rule: [30, 41, 59], accent: [96, 165, 250], up: [52, 211, 153], down: [248, 113, 113], cell: [17, 26, 44] },
} as const;

/** standard PDF fonts are WinAnsi: map the few symbols we print and drop the rest */
export const pdfText = (s: string): string =>
  s.replace(/₹/g, 'Rs. ').replace(/[▲]/g, '+').replace(/[▼]/g, '-').replace(/[−–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E -ÿ•·]/g, '');

export async function renderPdf(m: PdfModel, theme: PdfTheme): Promise<{ blob: Blob; pages: number; fileName: string }> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: false });
  const P = PALETTE[theme];
  const W = 210, H = 297, M = 14, CW = W - M * 2, BOTTOM = H - 16;
  let y = M;
  const setText = (c: readonly number[]) => doc.setTextColor(c[0], c[1], c[2]);
  const setFill = (c: readonly number[]) => doc.setFillColor(c[0], c[1], c[2]);
  const setDraw = (c: readonly number[]) => doc.setDrawColor(c[0], c[1], c[2]);
  const paintPage = () => { setFill(P.bg); doc.rect(0, 0, W, H, 'F'); };
  paintPage();
  const need = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); paintPage(); y = M; } };
  const wrap = (text: string, width: number, size: number) => { doc.setFontSize(size); return doc.splitTextToSize(pdfText(text), width) as string[]; };

  // header
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); setText(P.muted);
  doc.text('UPCIRCUIT  ·  EQUITY RESEARCH REPORT', M, y + 3);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); setText(P.text);
  const titleLines = wrap(m.title, CW - 62, 20);
  doc.text(titleLines[0] ?? m.title, M, y + 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); setText(P.muted);
  doc.text(pdfText(m.subtitle), M, y + 18);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); setText(P.text);
  doc.text(pdfText(m.price.text), W - M, y + 11, { align: 'right' });
  doc.setFontSize(10); setText(m.price.up ? P.up : P.down);
  doc.text(pdfText(m.price.change), W - M, y + 17, { align: 'right' });
  y += 23; setDraw(P.accent); doc.setLineWidth(0.6); doc.line(M, y, W - M, y); y += 5;

  for (const b of m.blocks) {
    if (b.t === 'h2') {
      need(14); y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); setText(P.accent);
      doc.text(pdfText(b.text.toUpperCase()), M, y + 4); y += 6; setDraw(P.rule); doc.setLineWidth(0.25); doc.line(M, y, W - M, y); y += 3;
    } else if (b.t === 'p') {
      const sub = b.text.startsWith('§');
      const lines = wrap(sub ? b.text.slice(1) : b.text, CW, sub ? 10 : 9.5);
      need(lines.length * 4.6 + 2);
      doc.setFont('helvetica', sub ? 'bold' : 'normal'); doc.setFontSize(sub ? 10 : 9.5); setText(sub ? P.text : P.text);
      lines.forEach((ln) => { doc.text(ln, M, y + 4); y += 4.6; }); y += 1.5;
    } else if (b.t === 'bullets') {
      for (const it of b.items) {
        const lines = wrap(it, CW - 5, 9.5);
        need(lines.length * 4.6 + 1);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); setText(P.accent); doc.text('•', M + 1, y + 4); setText(P.text);
        lines.forEach((ln) => { doc.text(ln, M + 5, y + 4); y += 4.6; }); y += 0.8;
      }
      y += 1;
    } else if (b.t === 'note') {
      const lines = wrap(b.text, CW, 8.5); need(lines.length * 4 + 2);
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); setText(P.muted); lines.forEach((ln) => { doc.text(ln, M, y + 3.5); y += 4; }); y += 1.5;
    } else if (b.t === 'kv') {
      const cols = b.cols ?? 4; const gap = 2.5; const cw = (CW - gap * (cols - 1)) / cols; const rowsN = Math.ceil(b.items.length / cols);
      for (let r = 0; r < rowsN; r++) {
        const slice = b.items.slice(r * cols, r * cols + cols);
        const heights = slice.map((c) => wrap(c.v, cw - 4, 10).length);
        const rh = 8 + Math.max(...heights) * 4.4;
        need(rh + 1.5);
        slice.forEach((c, k) => {
          const x = M + k * (cw + gap);
          setFill(P.cell); setDraw(P.rule); doc.setLineWidth(0.2); doc.roundedRect(x, y, cw, rh, 1, 1, 'FD');
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7); setText(P.muted); doc.text(pdfText(c.k.toUpperCase()), x + 2, y + 4);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10); setText(P.text);
          wrap(c.v, cw - 4, 10).forEach((ln, li) => doc.text(ln, x + 2, y + 8.6 + li * 4.4));
        });
        y += rh + 1.5;
      }
      y += 1;
    } else if (b.t === 'table') {
      const cw = CW / b.head.length;
      need(7 * (b.rows.length + 1) + 2);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); setText(P.muted);
      b.head.forEach((h, k) => doc.text(pdfText(h), k === 0 ? M : M + (k + 1) * cw - 1, y + 4, { align: k === 0 ? 'left' : 'right' }));
      y += 6; setDraw(P.rule); doc.line(M, y, W - M, y);
      for (const row of b.rows) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); setText(P.text);
        row.forEach((c, k) => doc.text(pdfText(c), k === 0 ? M : M + (k + 1) * cw - 1, y + 5, { align: k === 0 ? 'left' : 'right' }));
        y += 7; doc.line(M, y, W - M, y);
      }
      y += 2;
    }
  }

  // footer + page numbers on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const ft = doc.splitTextToSize(pdfText(m.footer), CW - 20) as string[];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); setText(P.muted);
    ft.slice(0, 3).forEach((ln, k) => doc.text(ln, M, H - 11 + k * 3));
    doc.text(`Page ${p} / ${pages}`, W - M, H - 11, { align: 'right' });
  }
  doc.setProperties({ title: `${m.title} - UpCircuit research report`, author: 'UpCircuit', subject: m.subtitle, creator: 'UpCircuit terminal' });
  return { blob: doc.output('blob') as Blob, pages, fileName: `${m.fileBase}_${theme}.pdf` };
}
