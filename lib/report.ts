import type { Quote } from './types';
import type { Screener } from './screener';

// Executive research report: CSV rows + a plain model the print layout renders. Pure (testable).

export type Cell = string | number | null | undefined;

/** RFC-4180 CSV. Strings starting with = + - @ are prefixed with ' (spreadsheet formula-injection guard). Numbers pass through untouched. */
export function toCsv(rows: Cell[][]): string {
  const esc = (c: Cell) => {
    if (c === null || c === undefined) return '';
    let s = typeof c === 'number' ? (Number.isFinite(c) ? String(c) : '') : c;
    if (typeof c === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

const r2 = (n: number) => Math.round(n * 100) / 100;

type Q = Pick<Quote, 'symbol' | 'name' | 'exch' | 'sector' | 'ltp' | 'prevClose' | 'high' | 'low' | 'volume' | 'circuitBand' | 'lowerCircuit' | 'upperCircuit'>;

export interface ReportModel {
  symbol: string;
  name: string;
  exch: string;
  sector: string;
  generatedAt: string;
  ltp: number;
  changePct: number;
  high52: number | null;
  low52: number | null;
  dataSource: string;
  grid: { label: string; value: string }[];
  quarters: Screener['quarters'];
  holding: Screener['holding'];
  estimated: string[];
}

const inr = (n: number | null, dp = 2) => (n === null ? 'N/A' : n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const fx = (n: number | null, dp = 1) => (n === null ? 'N/A' : n.toFixed(dp));

export function buildReport(q: Q, s: Screener, now = new Date()): ReportModel {
  const changePct = q.prevClose > 0 ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : 0;
  return {
    symbol: q.symbol,
    name: q.name,
    exch: q.exch ?? 'NSE',
    sector: q.sector,
    generatedAt: now.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) + ' IST',
    ltp: q.ltp,
    changePct,
    high52: s.high52,
    low52: s.low52,
    dataSource: s.source.live ? 'Verified provider data — fields not available show N/A' : 'Not available for this scrip',
    grid: [
      { label: 'Market Cap (₹ Cr)', value: inr(s.marketCapCr, 0) },
      { label: 'Stock P/E', value: fx(s.pe) },
      { label: 'Industry P/E', value: fx(s.industryPe) },
      { label: 'ROCE (%)', value: fx(s.roce) },
      { label: 'ROE (%)', value: fx(s.roe) },
      { label: 'Book Value (₹)', value: inr(s.bookValue) },
      { label: 'EPS TTM (₹)', value: inr(s.eps) },
      { label: 'Dividend Yield (%)', value: fx(s.dividendYield, 2) },
      { label: 'Debt to Equity', value: fx(s.debtToEquity, 2) },
      { label: 'Face Value (₹)', value: s.faceValue === null ? 'N/A' : String(s.faceValue) },
    ],
    quarters: s.quarters,
    holding: s.holding,
    estimated: s.source.na,
  };
}

/** One tidy sheet: Summary → Fundamentals → Quarterly (₹ Cr) → Shareholding. Columns: Section, Metric, Period, Value, Unit. */
export function reportCsv(q: Q, s: Screener, now = new Date()): string {
  const m = buildReport(q, s, now);
  const rows: Cell[][] = [['Section', 'Metric', 'Period', 'Value', 'Unit']];
  const add = (section: string, metric: string, period: string, value: Cell, unit = '') => rows.push([section, metric, period, value, unit]);
  add('Summary', 'Company', '', m.name);
  add('Summary', 'Symbol', '', `${m.symbol} (${m.exch})`);
  add('Summary', 'Sector', '', m.sector);
  add('Summary', 'LTP', '', r2(q.ltp), 'INR');
  add('Summary', 'Day change', '', r2(m.changePct), '%');
  add('Summary', '52W High', '', s.high52 === null ? 'N/A' : r2(s.high52), 'INR');
  add('Summary', '52W Low', '', s.low52 === null ? 'N/A' : r2(s.low52), 'INR');
  add('Summary', 'Day High', '', r2(q.high), 'INR');
  add('Summary', 'Day Low', '', r2(q.low), 'INR');
  add('Summary', 'Circuit band', '', q.circuitBand, '%');
  add('Summary', 'Generated', '', m.generatedAt);
  add('Summary', 'Data source', '', m.dataSource);
  add('Fundamentals', 'Market Cap', '', s.marketCapCr === null ? 'N/A' : Math.round(s.marketCapCr), 'INR Cr');
  add('Fundamentals', 'Stock P/E', '', s.pe === null ? 'N/A' : r2(s.pe), 'x');
  add('Fundamentals', 'Industry P/E', '', s.industryPe ?? 'N/A', 'x');
  add('Fundamentals', 'Book Value', '', s.bookValue === null ? 'N/A' : r2(s.bookValue), 'INR');
  add('Fundamentals', 'Dividend Yield', '', s.dividendYield === null ? 'N/A' : r2(s.dividendYield), '%');
  add('Fundamentals', 'ROCE', '', s.roce === null ? 'N/A' : r2(s.roce), '%');
  add('Fundamentals', 'ROE', '', s.roe === null ? 'N/A' : r2(s.roe), '%');
  add('Fundamentals', 'EPS (TTM)', '', s.eps === null ? 'N/A' : r2(s.eps), 'INR');
  add('Fundamentals', 'Face Value', '', s.faceValue ?? 'N/A', 'INR');
  add('Fundamentals', 'Debt to Equity', '', s.debtToEquity === null ? 'N/A' : r2(s.debtToEquity), 'x');
  for (const qr of s.quarters) {
    add('Quarterly', 'Sales / Revenue', qr.label, qr.sales, 'INR Cr');
    add('Quarterly', 'Expenses', qr.label, qr.expenses, 'INR Cr');
    add('Quarterly', 'Operating Profit (EBITDA)', qr.label, qr.operatingProfit, 'INR Cr');
    add('Quarterly', 'OPM', qr.label, qr.opmPct, '%');
    add('Quarterly', 'Net Profit', qr.label, qr.netProfit, 'INR Cr');
    add('Quarterly', 'EPS', qr.label, qr.eps, 'INR');
  }
  add('Shareholding', 'Promoters', '', s.holding?.promoters ?? 'N/A', '%');
  add('Shareholding', 'Institutions (FII + DII)', '', s.holding?.institutions ?? 'N/A', '%');
  add('Shareholding', 'Public', '', s.holding?.public ?? 'N/A', '%');
  if (m.estimated.length) add('Notes', 'N/A fields', '', m.estimated.join('; '));
  return toCsv(rows);
}

export const reportFileName = (symbol: string, ext: 'csv' | 'pdf', now = new Date()) => `UpCircuit_${symbol.replace(/[^A-Za-z0-9_-]/g, '')}_report_${now.toISOString().slice(0, 10)}.${ext}`;

export const ANALYST_PROMPT = (symbol: string, name: string) =>
  `Write an executive research note on ${symbol} (${name}) for a printed report. Use exactly two sections: "## Analyst Summary" (valuation vs the sector, quality — ROE / ROCE, debt, dividends, trend and momentum, news sentiment) and "## Risk Assessment" (the top 3–4 stock-specific and sector risks, each with a one-line rationale and a High / Medium / Low rating). Use only the numbers in the context, bold the key figures, stay balanced and never tell the reader to buy, sell or hold.`;
