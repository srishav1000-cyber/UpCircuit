import type { Instrument } from './types';

interface Entry {
  item: Instrument;
  sym: string; // alnum-only, lowercase
  nameN: string;
  words: string[];
}

export interface SearchIndex {
  entries: Entry[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function buildIndex(items: Instrument[]): SearchIndex {
  return {
    entries: items.map((item) => ({
      item,
      sym: norm(item.symbol),
      nameN: norm(item.name),
      words: item.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
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

function score(e: Entry, q: string, tokens: string[]): number {
  if (e.sym === q) return 1000;
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

  const si = e.sym.indexOf(q);
  if (si >= 0) return 500 - si * 10;
  const ni = e.nameN.indexOf(q);
  if (ni >= 0) return 400 - Math.min(ni, 100);

  const gaps = isSubsequence(q, e.sym);
  if (gaps >= 0 && q.length >= 3) return 260 - gaps * 25;

  // typo tolerance: compare against the symbol prefix and each name word prefix
  if (q.length >= 4) {
    const maxD = q.length >= 7 ? 2 : 1;
    let d = lev(q, e.sym.slice(0, q.length));
    for (const w of e.words) d = Math.min(d, lev(q, w.slice(0, q.length)));
    if (d <= maxD) return 200 - d * 40;
  }
  return 0;
}

export function searchInstruments(index: SearchIndex, query: string, limit = 8): Instrument[] {
  const q = norm(query);
  if (!q) return [];
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored: { item: Instrument; s: number }[] = [];
  for (const e of index.entries) {
    const s = score(e, q, tokens.length > 1 ? tokens : []);
    if (s > 0) scored.push({ item: e.item, s });
  }
  scored.sort((a, b) => b.s - a.s || a.item.symbol.length - b.item.symbol.length || a.item.symbol.localeCompare(b.item.symbol));
  return scored.slice(0, limit).map((x) => x.item);
}
