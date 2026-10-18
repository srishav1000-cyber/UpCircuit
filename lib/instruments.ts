import seed from '@/data/seed-instruments.json';
import type { Instrument } from './types';

/** Built-in seed (~250 liquid names). The full NSE master is merged in at runtime from /data/instruments.json. */
export const SEED_INSTRUMENTS: Instrument[] = (seed as [string, string, string][]).map(([symbol, name, sector]) => ({
  symbol,
  name,
  sector,
}));

export const SEED_SECTORS = new Map(SEED_INSTRUMENTS.map((i) => [i.symbol, i.sector]));

/** Fetch the full NSE equity master produced by `npm run sync:instruments`. Falls back to the seed. */
export async function loadInstrumentMaster(signal?: AbortSignal): Promise<Instrument[]> {
  try {
    const res = await fetch('/data/instruments.json', { signal, cache: 'no-cache' /* revalidate (ETag) so a re-synced 8k master replaces a stale browser copy */ });
    if (!res.ok) return SEED_INSTRUMENTS;
    const rows = (await res.json()) as Instrument[];
    if (!Array.isArray(rows) || rows.length < SEED_INSTRUMENTS.length) return SEED_INSTRUMENTS;
    return rows;
  } catch {
    return SEED_INSTRUMENTS;
  }
}

/* ───────────── indices ───────────── */

export interface IndexInstrument {
  /** engine id (MarketEngine.indices[].id) */
  id: 'NIFTY' | 'SENSEX' | 'BANKNIFTY' | 'INDIAVIX';
  label: string;
  exch: 'NSE' | 'BSE';
  aliases: string[];
}

export const INDEX_INSTRUMENTS: IndexInstrument[] = [
  { id: 'NIFTY', label: 'NIFTY 50', exch: 'NSE', aliases: ['NIFTY', 'NIFTY50', 'NSEI', 'CNXNIFTY'] },
  { id: 'SENSEX', label: 'SENSEX', exch: 'BSE', aliases: ['SENSEX', 'BSESENSEX', 'BSE30', 'SENSEX30'] },
  { id: 'BANKNIFTY', label: 'BANK NIFTY', exch: 'NSE', aliases: ['BANKNIFTY', 'NIFTYBANK', 'NSEBANK', 'CNXBANK'] },
  { id: 'INDIAVIX', label: 'INDIA VIX', exch: 'NSE', aliases: ['INDIAVIX', 'VIX', 'NIFTYVIX'] },
];

const INDEX_ALIAS = new Map(INDEX_INSTRUMENTS.flatMap((i) => i.aliases.map((a) => [a, i] as const)));

/** 'NIFTY 50' | 'nifty50' | '^NSEI' | 'India VIX' → its index instrument; anything else (an equity symbol) → undefined. */
export function resolveIndex(s: string | null | undefined): IndexInstrument | undefined {
  if (!s) return undefined;
  return INDEX_ALIAS.get(s.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}
