import type { Holding } from './types';

export interface CsvResult {
  holdings: Holding[];
  /** rows that were skipped (with reason) */
  errors: string[];
  /** non-fatal notes (merged duplicates, unknown symbols kept, …) */
  warnings: string[];
  rowsRead: number;
}

const HEADER_ALIASES: Record<string, 'symbol' | 'quantity' | 'buy_price'> = {
  symbol: 'symbol',
  ticker: 'symbol',
  quantity: 'quantity',
  qty: 'quantity',
  buy_price: 'buy_price',
  buyprice: 'buy_price',
  avg_price: 'buy_price',
  average_price: 'buy_price',
  price: 'buy_price',
};

/** RFC-4180-ish splitter: handles quoted cells, "" escapes and commas inside quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const num = (s: string) => Number(s.replace(/[₹,\s]/g, ''));

/**
 * Parse a portfolio CSV with header `symbol,quantity,buy_price`.
 * - symbols are upper-cased and matched against `knownSymbols` when given (unknown ones are skipped)
 * - duplicate symbols are merged into one holding at the weighted-average buy price
 */
export function parsePortfolioCsv(text: string, knownSymbols?: ReadonlySet<string>): CsvResult {
  const result: CsvResult = { holdings: [], errors: [], warnings: [], rowsRead: 0 };
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    result.errors.push('The file is empty.');
    return result;
  }

  const head = splitCsvLine(lines[0]).map((h) => HEADER_ALIASES[h.toLowerCase().replace(/[\s-]+/g, '_')]);
  const idx = { symbol: head.indexOf('symbol'), quantity: head.indexOf('quantity'), buy_price: head.indexOf('buy_price') };
  if (idx.symbol < 0 || idx.quantity < 0 || idx.buy_price < 0) {
    result.errors.push('Header must be: symbol,quantity,buy_price');
    return result;
  }

  const merged = new Map<string, Holding>();
  for (let i = 1; i < lines.length; i++) {
    const row = i + 1; // 1-based line number in the file
    const c = splitCsvLine(lines[i]);
    result.rowsRead++;
    const symbol = (c[idx.symbol] ?? '').toUpperCase();
    const qty = num(c[idx.quantity] ?? '');
    const price = num(c[idx.buy_price] ?? '');

    if (!symbol) result.errors.push(`Row ${row}: missing symbol`);
    else if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) result.errors.push(`Row ${row}: invalid symbol "${symbol}"`);
    else if (knownSymbols && !knownSymbols.has(symbol)) result.errors.push(`Row ${row}: "${symbol}" is not in the NSE instrument list`);
    else if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) result.errors.push(`Row ${row}: quantity must be a positive whole number (got "${c[idx.quantity] ?? ''}")`);
    else if (!Number.isFinite(price) || price <= 0) result.errors.push(`Row ${row}: buy_price must be a positive number (got "${c[idx.buy_price] ?? ''}")`);
    else {
      const cur = merged.get(symbol);
      if (cur) {
        const q = cur.qty + qty;
        merged.set(symbol, { symbol, qty: q, avg: (cur.qty * cur.avg + qty * price) / q });
        result.warnings.push(`${symbol}: duplicate rows merged at weighted-average price`);
      } else merged.set(symbol, { symbol, qty, avg: price });
    }
  }
  result.holdings = Array.from(merged.values()).map((h) => ({ ...h, avg: Math.round(h.avg * 100) / 100 }));
  if (result.holdings.length === 0 && result.errors.length === 0) result.errors.push('No data rows found.');
  return result;
}
