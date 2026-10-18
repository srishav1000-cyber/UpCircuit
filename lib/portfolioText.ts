import type { CsvResult } from './csv';
import type { Holding, Instrument } from './types';

export interface RawRow {
  symbol: string;
  qty: number;
  price: number;
  /** where it came from, for error messages (e.g. "Line 7") */
  ref: string;
}

/** Validate rows against the instrument list, merge duplicates at weighted-average price. Shared by OCR, PDF and vision paths. */
export function rowsToResult(rows: RawRow[], known?: ReadonlySet<string>, rowsRead = rows.length): CsvResult {
  const result: CsvResult = { holdings: [], errors: [], warnings: [], rowsRead };
  const merged = new Map<string, Holding>();
  for (const r of rows) {
    const symbol = r.symbol.toUpperCase();
    if (known && !known.has(symbol)) result.errors.push(`${r.ref}: "${symbol}" is not in the NSE instrument list`);
    else if (!Number.isFinite(r.qty) || r.qty <= 0 || !Number.isInteger(r.qty)) result.errors.push(`${r.ref}: quantity must be a positive whole number (read "${r.qty}")`);
    else if (!Number.isFinite(r.price) || r.price <= 0) result.errors.push(`${r.ref}: buy price must be positive (read "${r.price}")`);
    else {
      const cur = merged.get(symbol);
      if (cur) {
        const q = cur.qty + r.qty;
        merged.set(symbol, { symbol, qty: q, avg: (cur.qty * cur.avg + r.qty * r.price) / q });
        result.warnings.push(`${symbol}: duplicate rows merged at weighted-average price`);
      } else merged.set(symbol, { symbol, qty: r.qty, avg: r.price });
    }
  }
  result.holdings = Array.from(merged.values()).map((h) => ({ ...h, avg: Math.round(h.avg * 100) / 100 }));
  return result;
}

const NUM = /-?\d[\d,]*(?:\.\d+)?/g;
const toNum = (s: string) => Number(s.replace(/,/g, ''));
const SUFFIX = /(-EQ|-BE|-SM|-N\d|\.NS|\.BO)$/i;
const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(limited|ltd|corporation|corp|co|company|inc)\b\.?/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function buildNameIndex(instruments: Instrument[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of instruments) m.set(normName(i.name), i.symbol);
  return m;
}

/**
 * Pull `[symbol, quantity, buy price]` rows out of free text (OCR output, PDF text layer, pasted statement).
 * Column order comes from a header line when present (Qty before/after Avg price), else quantity then price —
 * the layout of Zerodha, Angel One, Groww and most broker holdings tables. Always shown for review before import.
 */
export function parseHoldingsText(text: string, known: ReadonlySet<string>, names?: Map<string, string>): CsvResult {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/[|│┃\t]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const rows: RawRow[] = [];
  const errors: string[] = [];
  let qtyFirst = true;
  let candidates = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ref = `Line ${i + 1}`;

    const hq = line.search(/\b(qty|quantity|shares|units)\b/i);
    const hp = line.search(/\b(avg|average|buy|cost|purchase)\b/i);
    if (hq >= 0 && hp >= 0 && !/\d{2,}/.test(line)) {
      qtyFirst = hq < hp;
      continue;
    }

    // 1) a token that is a known symbol (RELIANCE, RELIANCE-EQ, NSE:RELIANCE, M&M …)
    const tokens = line.split(' ');
    let sym: string | null = null;
    let end = -1; // char offset just after the symbol text
    let off = 0;
    for (let t = 0; t < tokens.length && !sym; t++) {
      const raw = tokens[t];
      const clean = raw.replace(/^NSE:/i, '').replace(SUFFIX, '').replace(/[^A-Za-z0-9&-]/g, '').toUpperCase();
      if (clean.length >= 2 && known.has(clean) && !/^\d+$/.test(clean)) {
        sym = clean;
        end = off + raw.length;
      }
      off += raw.length + 1;
    }
    // 2) a company name at the start of the line ("Reliance Industries Ltd 25 2480.5")
    if (!sym && names) {
      const words = line.split(' ');
      let acc = 0;
      for (let n = 1; n <= Math.min(5, words.length) && !sym; n++) {
        const cand = normName(words.slice(0, n).join(' '));
        acc += words[n - 1].length + 1;
        if (cand.length >= 4 && names.has(cand)) {
          sym = names.get(cand)!;
          end = acc - 1;
        }
      }
    }
    if (!sym) continue;
    candidates++;

    const nums = (line.slice(end).match(NUM) ?? []).map(toNum).filter((n) => Number.isFinite(n));
    if (nums.length < 2) {
      errors.push(`${ref}: found ${sym} but couldn't read both quantity and price`);
      continue;
    }
    let [a, b] = nums;
    if (!qtyFirst) [a, b] = [b, a];
    // quantity is a whole number: if the "quantity" column looks fractional but the other is whole, swap
    if (!Number.isInteger(a) && Number.isInteger(b)) [a, b] = [b, a];
    rows.push({ symbol: sym, qty: a, price: b, ref });
  }

  const res = rowsToResult(rows, known, candidates);
  res.errors.unshift(...errors);
  if (res.holdings.length) res.warnings.push('Read from text — check quantities and prices before importing.');
  else if (res.errors.length === 0) res.errors.push('No holdings found. Make sure the file lists NSE symbols with quantity and average price.');
  return res;
}
