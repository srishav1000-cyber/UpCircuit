import type { Instrument } from './types';

interface Entry {
  item: Instrument;
  sym: string; // alnum-only, lowercase
  code: string; // BSE scrip code ('' when unknown)
  nameN: string;
  words: string[];
  symMask: number;
  wordMasks: number[];
  /** initials of every name word: "Varun Beverages Ltd" → vbl */
  acro: string;
  /** initials without the legal suffix: → vb */
  acroCore: string;
}

export interface SearchIndex {
  entries: Entry[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** 32-bit character-set signature (collisions only loosen it, so it stays a safe pre-filter) */
const cmask = (s: string): number => { let m = 0; for (let i = 0; i < s.length; i++) m |= 1 << (s.charCodeAt(i) & 31); return m; };
const pop = (x: number): number => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

const SUFFIX = new Set(['ltd', 'limited', 'pvt', 'private']);
const initials = (w: string[]) => w.map((x) => x[0]).join('');

/** Everyday names → the NSE ticker they mean (only applied when that ticker exists in the master). */
const NICKNAMES: Record<string, string> = {
  hul: 'HINDUNILVR', lnt: 'LT', sbi: 'SBIN', airtel: 'BHARTIARTL', hdfc: 'HDFCBANK', icici: 'ICICIBANK', kotak: 'KOTAKBANK', bob: 'BANKBARODA',
  nestle: 'NESTLEIND', mahindra: 'M&M', bajaj: 'BAJFINANCE', adani: 'ADANIENT', tata: 'TATAMOTORS',
};

export function buildIndex(items: Instrument[]): SearchIndex {
  return {
    entries: items.map((item) => ({
      acro: initials(item.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
      acroCore: initials(item.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !SUFFIX.has(w))),
      item,
      sym: norm(item.symbol),
      code: item.code ?? '',
      nameN: norm(item.name),
      words: item.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
      symMask: cmask(norm(item.symbol)),
      wordMasks: item.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(cmask),
    })),
  };
}

function isSubsequence(q: string, s: string): number {
  // returns gap count, or -1 if not a subsequence
  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      if (last >= 0 && i - last > 1) gaps++;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? gaps : -1;
}

function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

const DIGITS = /^\d{3,}$/;
function score(e: Entry, q: string, tokens: string[]): number {
  if (e.sym === q) return 1000;
  // BSE scrip code: "500325" → exact, "5003" → prefix (a purely numeric query of ≥ 3 digits)
  if (e.code && DIGITS.test(q)) {
    if (e.code === q) return 1000;
    if (e.code.startsWith(q)) return 880 - (e.code.length - q.length) * 5;
  }
  if (e.sym.startsWith(q)) return 900 - (e.sym.length - q.length) * 2;

  // every token is a prefix of a distinct-ish name word ("south ind" → South Indian Bank)
  if (tokens.length > 0) {
    let best = 0;
    let ok = true;
    for (const t of tokens) {
      const wi = e.words.findIndex((w) => w.startsWith(t));
      if (wi < 0) {
        ok = false;
        break;
      }
      best += 700 - wi * 20;
    }
    if (ok) return best / tokens.length;
  }

  // nicknames (HUL → HINDUNILVR) and market acronyms: VBL → Varun Beverages Ltd, M&M → Mahindra & Mahindra
  const nick = NICKNAMES[q];
  if (nick && e.item.symbol === nick) return 950;
  if (q.length >= 2 && (e.acro === q || e.acroCore === q)) return 650;
  if (q.length >= 3 && (e.acro.startsWith(q) || e.acroCore.startsWith(q))) return 560 - (e.acroCore.length - q.length) * 5;

  const si = e.sym.indexOf(q);
  if (si >= 0) return 500 - si * 10;
  const ni = e.nameN.indexOf(q);
  if (ni >= 0) return 400 - Math.min(ni, 100);

  return 0;
}

/** Typo / subsequence tolerance — only evaluated when the cheap rules above found fewer than `limit` matches (keeps an 8k master at ~1 ms per keystroke). */
function scoreFuzzy(e: Entry, q: string): number {
  const gaps = isSubsequence(q, e.sym);
  if (gaps >= 0 && q.length >= 3) return 260 - gaps * 25;

  // typo tolerance: compare against the symbol prefix and each name word prefix
  if (q.length >= 4) {
    const maxD = q.length >= 7 ? 2 : 1;
    // each edit can account for at most one distinct missing character, so a signature mismatch above maxD rules a candidate out without running lev
    const qm = cmask(q);
    let d = pop(qm & ~e.symMask) > maxD ? 99 : lev(q, e.sym.slice(0, q.length));
    for (let k = 0; k < e.words.length; k++) if (pop(qm & ~e.wordMasks[k]) <= maxD) d = Math.min(d, lev(q, e.words[k].slice(0, q.length)));
    if (d <= maxD) return 200 - d * 40;
  }
  return 0;
}

export function searchInstruments(index: SearchIndex, query: string, limit = 8): Instrument[] {
  const q = norm(query);
  if (!q) return [];
  const raw = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // "Varun Beverages Limited" must find "Varun Beverages Ltd": legal-suffix words never have to match
  const core = raw.filter((w) => !SUFFIX.has(w));
  const tokens = core.length ? core : raw;
  const scored: { item: Instrument; s: number }[] = [];
  const tk = tokens.length > 1 ? tokens : [];
  const rest: Entry[] = [];
  for (const e of index.entries) {
    const s = score(e, q, tk);
    if (s > 0) scored.push({ item: e.item, s });
    else rest.push(e);
  }
  // every fuzzy score (≤ 260) is below every cheap score (≥ 300), so they can only fill free slots
  if (scored.length < limit) for (const e of rest) {
    const s = scoreFuzzy(e, q);
    if (s > 0) scored.push({ item: e.item, s });
  }
  scored.sort((a, b) => b.s - a.s || a.item.symbol.length - b.item.symbol.length || a.item.symbol.localeCompare(b.item.symbol));
  return scored.slice(0, limit).map((x) => x.item);
}
