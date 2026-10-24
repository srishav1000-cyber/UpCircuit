#!/usr/bin/env node
/**
 * Builds public/data/instruments.json — the NSE + BSE equity master (≈7,500+ listed names).
 *
 * Primary source: Angel One scrip master (OpenAPIScripMaster.json). Each row carries `exch_seg`:
 *   exch_seg = "NSE"  cash equities  → symbol "RELIANCE-EQ" (also -BE/-BZ/-SM/-ST), name "RELIANCE"
 *   exch_seg = "BSE"  cash equities  → symbol "RELIANCE" (instrumenttype "" = cash, not a derivative)
 * Enrichment: NSE EQUITY_L.csv supplies full company names for NSE tickers.
 * Dedupe: one row per ticker. A name listed on both exchanges is kept once as NSE (liquid venue); BSE-only names carry exch:"BSE".
 *
 * Runs automatically before `next build` (prebuild). It NEVER fails the build: on any fetch problem it keeps the
 * existing file, or falls back to the bundled seed.
 *
 *   node scripts/sync-instruments.mjs           # skip if file already exists
 *   node scripts/sync-instruments.mjs --force   # always refetch
 *
 * Env: ANGEL_SCRIP_MASTER_URL, NSE_EQUITY_CSV_URL, INSTRUMENTS_OUT (test override of the output path).
 * NOTE: the BSE row filter (below) follows Angel's published scrip-master layout but has NOT been run against the live file
 * from the build sandbox — check the printed NSE / BSE-only counts after your first sync.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.INSTRUMENTS_OUT ? resolve(process.env.INSTRUMENTS_OUT) : resolve(root, 'public/data/instruments.json');
const SCRIP_URL = process.env.ANGEL_SCRIP_MASTER_URL || 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const NSE_CSV_URL = process.env.NSE_EQUITY_CSV_URL || 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
const force = process.argv.includes('--force');
const EXPECTED_MIN = 6000; // informational only: NSE ≈ 2.3k + BSE-only ≈ 4–5k

const exists = async (p) => access(p).then(() => true, () => false);

export function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const NSE_SERIES = /-(EQ|BE|BZ|SM|ST)$/;
const BSE_TICKER = /^[A-Z][A-Z0-9&-]{0,19}$/;

/** Scrip-master rows → { nse: Map(ticker→name), bse: Map(ticker→name) } (cash equities only). */
export function pickEquities(rows) {
  const nse = new Map();
  const bse = new Map();
  const codes = new Map(); // ticker → BSE scrip code (the BSE row's token), also for dual-listed names that are kept as NSE
  for (const r of rows) {
    if (!r || typeof r.symbol !== 'string' || (r.instrumenttype ?? '') !== '') continue; // derivatives / indices carry an instrumenttype
    if (r.exch_seg === 'NSE' && NSE_SERIES.test(r.symbol)) {
      const t = String(r.name || r.symbol.replace(NSE_SERIES, '')).toUpperCase();
      if (t && !nse.has(t)) nse.set(t, t);
    } else if (r.exch_seg === 'BSE' && BSE_TICKER.test(r.symbol)) {
      if (!bse.has(r.symbol)) bse.set(r.symbol, String(r.name || r.symbol));
      if (/^\d{5,6}$/.test(String(r.token ?? '')) && !codes.has(r.symbol)) codes.set(r.symbol, String(r.token));
    }
  }
  return { nse, bse, codes };
}

async function getText(url, ms, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (UpCircuit instrument sync)', Accept: '*/*', ...headers }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res;
}

async function fetchNseNames() {
  const lines = (await (await getText(NSE_CSV_URL, 20000, { Accept: 'text/csv,*/*' })).text()).split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]).map((h) => h.toUpperCase());
  const iSym = head.indexOf('SYMBOL');
  const iName = head.findIndex((h) => h.startsWith('NAME OF'));
  const iSeries = head.findIndex((h) => h.includes('SERIES'));
  if (iSym < 0 || iName < 0) throw new Error('unexpected CSV header: ' + lines[0]);
  const m = new Map();
  for (const l of lines.slice(1)) {
    const c = parseCsvLine(l);
    const series = iSeries >= 0 ? c[iSeries] : 'EQ';
    if (c[iSym] && ['EQ', 'BE', 'BZ', 'SM', 'ST'].includes(series)) m.set(c[iSym], c[iName]);
  }
  return m;
}

async function main() {
  if (!force && (await exists(out))) {
    // a committed seed-sized file (≈230 names) must NOT block the real sync on Vercel / CI — only a full master counts as fresh
    let have = 0;
    try { have = JSON.parse(await readFile(out, 'utf8')).length; } catch { /* unreadable → refetch */ }
    if (have >= EXPECTED_MIN) {
      console.log(`[instruments] ${out} has ${have} names — skipping (use --force to refresh)`);
      return;
    }
    console.log(`[instruments] ${out} has only ${have} names (seed) — fetching the full NSE + BSE master`);
  }
  const seed = JSON.parse(await readFile(resolve(root, 'data/seed-instruments.json'), 'utf8'));
  const sectors = new Map(seed.map(([s, , sec]) => [s, sec]));
  const sectorOf = (s) => sectors.get(s) ?? 'Others';

  let scrip = null;
  let names = new Map();
  try {
    const rows = await (await getText(SCRIP_URL, 90000)).json(); // ~40 MB incl. F&O
    scrip = pickEquities(rows);
    console.log(`[instruments] Angel scrip master: ${scrip.nse.size} NSE + ${scrip.bse.size} BSE cash equities`);
  } catch (e) {
    console.warn('[instruments] Angel scrip master failed (' + e.message + ').');
  }
  try {
    names = await fetchNseNames();
    console.log(`[instruments] NSE EQUITY_L.csv: ${names.size} names`);
  } catch (e) {
    console.warn('[instruments] NSE csv failed (' + e.message + ').');
  }

  const byTicker = new Map();
  const add = (symbol, name, exch) => {
    if (!byTicker.has(symbol)) byTicker.set(symbol, { symbol, name, sector: sectorOf(symbol), ...(exch === 'BSE' ? { exch } : {}), ...(scrip?.codes.get(symbol) ? { code: scrip.codes.get(symbol) } : {}) });
  };
  // NSE first so that dual-listed names stay NSE
  if (scrip) for (const t of scrip.nse.keys()) add(t, names.get(t) ?? t, 'NSE');
  for (const [t, n] of names) add(t, n, 'NSE'); // csv-only NSE tickers (and the whole NSE list if the scrip master was unreachable)
  const nseCount = byTicker.size;
  if (scrip) for (const [t, n] of scrip.bse) add(t, n, 'BSE');
  const rows = Array.from(byTicker.values());

  if (rows.length < 500) {
    if (await exists(out)) {
      console.warn('[instruments] keeping existing file.');
      return;
    }
    const fallback = seed.map(([symbol, name, sector]) => ({ symbol, name, sector }));
    rows.length = 0;
    rows.push(...fallback);
    console.warn(`[instruments] using bundled seed (${rows.length}). Run \`npm run sync:instruments\` on a network that can reach Angel One / NSE for the full list.`);
  } else {
    console.log(`[instruments] NSE ${nseCount} + BSE-only ${rows.length - nseCount} = ${rows.length} unique tickers`);
    if (!scrip) console.warn('[instruments] BSE segment missing (scrip master unreachable) — catalogue is NSE-only.');
    else if (rows.length < EXPECTED_MIN) console.warn(`[instruments] fewer than ~${EXPECTED_MIN} names — check the scrip-master filter for BSE rows.`);
  }
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(rows));
  console.log(`[instruments] wrote ${rows.length} → ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.warn('[instruments] non-fatal error:', e.message);
    process.exit(0);
  });
}
