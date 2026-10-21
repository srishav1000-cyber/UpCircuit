// Last-known REAL market snapshot, kept in localStorage so the terminal shell can render instantly on the next visit while the live
// connection (SmartAPI session + Yahoo quotes) is established in the background. It is the previous session's real data, never simulated:
// the UI labels it "saved snapshot" until a fresh fetch replaces it. Rows older than MAX_AGE_MS are ignored.
import type { YahooRow } from './yahooData';

export const SNAPSHOT_KEY = 'upcircuit:snapshot:v1';
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const MAX_ROWS = 320;

export interface Snapshot {
  t: number;
  rows: YahooRow[];
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keep only the fields the engine needs, drop invalid rows, cap the size. */
export function compactRows(rows: YahooRow[]): YahooRow[] {
  const out: YahooRow[] = [];
  for (const r of rows) {
    if (!r || typeof r.symbol !== 'string' || !(num(r.ltp) && r.ltp > 0) || !(num(r.prevClose) && r.prevClose > 0)) continue;
    const c: YahooRow = { symbol: r.symbol, ltp: r.ltp, prevClose: r.prevClose };
    for (const k of ['open', 'high', 'low', 'volume', 'avgVolume', 'mcapCr', 'sharesCr', 'dividendYield', 'marketTime'] as const) if (num(r[k])) c[k] = r[k];
    if (r.isIndex) c.isIndex = true;
    out.push(c);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

export function parseSnapshot(raw: string | null, now = Date.now()): Snapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Snapshot>;
    if (!v || !num(v.t) || !Array.isArray(v.rows) || now - v.t > MAX_AGE_MS || v.t > now + 60_000) return null;
    const rows = compactRows(v.rows as YahooRow[]);
    return rows.length >= 3 ? { t: v.t, rows } : null;
  } catch {
    return null;
  }
}

export function loadSnapshot(now = Date.now()): Snapshot | null {
  try {
    return parseSnapshot(localStorage.getItem(SNAPSHOT_KEY), now);
  } catch {
    return null;
  }
}

export function saveSnapshot(rows: YahooRow[], now = Date.now()): void {
  try {
    const c = compactRows(rows);
    if (c.length >= 3) localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ t: now, rows: c } satisfies Snapshot));
  } catch {
    /* storage blocked or full — the shell simply shows the skeleton next time */
  }
}
