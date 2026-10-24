// Circuit-desk history: merges this session's confirmed hits with the account's Supabase `alert_history` rows (written on every real hit),
// so the drawer survives reloads and shows hits detected on other devices. Pure helpers — no React, no network.
import type { AlertRow } from './cloud';
import type { CircuitDir } from './circuit';
import { circuitWatchlist, NEAR_PCT, type Proximity } from './analytics/proximity';
import type { CircuitQuote } from './circuit';

export interface HistoryEntry {
  key: string;
  symbol: string;
  dir: CircuitDir;
  band: number;
  price: number;
  at: number;
  /** day % at the trigger when known (session events carry it; cloud rows do not store it) */
  pct?: number;
  demo?: boolean;
  /** where we learned about it: this session, the account's cloud history, or both */
  origin: 'session' | 'cloud' | 'both';
}

export type HistoryTab = 'all' | 'upper' | 'lower' | 'near';
export const HISTORY_TABS: { id: HistoryTab; label: string }[] = [
  { id: 'all', label: 'All Anomalies' },
  { id: 'upper', label: 'Upper Circuit (UC)' },
  { id: 'lower', label: 'Lower Circuit (LC)' },
  { id: 'near', label: `Near Limit (±${NEAR_PCT}%)` },
];

/** IST calendar day — the unit of the daily alert lock (one alert per symbol · direction · band per day) */
export const istDay = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const keyOf = (symbol: string, dir: CircuitDir, band: number, at: number) => `${symbol}|${dir}|${band}|${istDay(at)}`;

export function fromEvent(e: { symbol: string; dir: CircuitDir; band: number; ltp: number; pct: number; at: number; demo?: boolean }): HistoryEntry {
  return { key: keyOf(e.symbol, e.dir, e.band, e.at) + (e.demo ? '|demo' + e.at : ''), symbol: e.symbol, dir: e.dir, band: e.band, price: e.ltp, at: e.at, pct: e.pct, demo: e.demo, origin: 'session' };
}

export function fromRows(rows: AlertRow[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const r of rows) {
    const dir: CircuitDir | null = r.direction === 'UPPER' ? 'upper' : r.direction === 'LOWER' ? 'lower' : null;
    const at = Date.parse(r.triggered_at);
    const price = Number(r.price);
    if (!dir || !Number.isFinite(at) || !Number.isFinite(price)) continue;
    out.push({ key: keyOf(r.symbol, dir, Number(r.band), at), symbol: r.symbol, dir, band: Number(r.band), price, at, origin: 'cloud' });
  }
  return out;
}

/** union by (symbol, direction, band, IST day); a hit seen in both places keeps the session's richer record; newest first */
export function mergeHistory(session: HistoryEntry[], cloud: HistoryEntry[]): HistoryEntry[] {
  const m = new Map<string, HistoryEntry>();
  for (const c of cloud) m.set(c.key, c);
  for (const s of session) {
    const prev = m.get(s.key);
    m.set(s.key, prev && !s.demo ? { ...prev, ...s, at: Math.min(prev.at, s.at), origin: 'both' } : s);
  }
  return [...m.values()].sort((a, b) => b.at - a.at);
}

/** the three history tabs; "near" is a live view of stocks closing in on a limit, handled by `nearLimit` */
export function filterHistory(entries: HistoryEntry[], tab: HistoryTab): HistoryEntry[] {
  return tab === 'upper' ? entries.filter((e) => e.dir === 'upper') : tab === 'lower' ? entries.filter((e) => e.dir === 'lower') : tab === 'near' ? [] : entries;
}

/** every priced stock within `within` % of a circuit limit (not yet at it), closest first */
export const nearLimit = (quotes: Iterable<CircuitQuote>, within = NEAR_PCT, max = 60): Proximity[] => circuitWatchlist(quotes, within, max);
