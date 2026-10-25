// Pure helpers for the live RSS news engine (edge + browser safe): relative timestamps, stock-symbol extraction, Google News title/source split.
import { SEED_INSTRUMENTS } from './instruments';

/** "just now" · "12 mins ago" · "1 hour ago" · "3 hours ago" · "2 days ago" ('' when the feed gave no date) */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const m = Math.max(0, Math.floor((now - ts) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} ${m === 1 ? 'min' : 'mins'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/** Google News headlines end with " - Publisher"; split it off so the badge shows the real source. */
export function splitGoogleTitle(title: string, sourceTag = ''): { title: string; source: string } {
  const i = title.lastIndexOf(' - ');
  if (i > 12 && title.length - i <= 48) return { title: title.slice(0, i).trim(), source: sourceTag || title.slice(i + 3).trim() };
  return { title, source: sourceTag };
}

const STOP = new Set(['ONE', 'ALL', 'NEW', 'TOP', 'BIG', 'GOLD', 'BANK', 'CASH', 'FUND', 'POWER', 'METAL', 'AUTO', 'INDIA', 'NIFTY', 'GAIL', 'IOC', 'HAL']);
const CORP = /\b(limited|ltd\.?|industries|corporation|corp\.?|company|co\.?|india|enterprises|the)\b/gi;

interface Matcher { symbol: string; re: RegExp }
let matchers: Matcher[] | null = null;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function build(): Matcher[] {
  const out: Matcher[] = [];
  for (const i of SEED_INSTRUMENTS) {
    const pats: string[] = [];
    if (i.symbol.length >= 3 && !STOP.has(i.symbol) && /^[A-Z0-9&-]+$/.test(i.symbol)) pats.push(`\\b${esc(i.symbol)}\\b`);
    const nm = i.name.replace(CORP, ' ').replace(/[^A-Za-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (nm.length >= 5 && nm.toUpperCase() !== i.symbol) pats.push(`\\b${esc(nm)}\\b`);
    const first = nm.split(' ')[0];
    if (first && first.length >= 6 && !/^(Bharat|Hindustan|National|Indian|Oil|Tata|Adani|Bajaj|Mahindra)$/i.test(first)) pats.push(`\\b${esc(first)}\\b`);
    if (pats.length) out.push({ symbol: i.symbol, re: new RegExp(pats.join('|'), /^[A-Z0-9&-]+$/.test(i.symbol) ? 'i' : 'i') });
  }
  return out;
}

/** Stock symbols mentioned in a headline (ticker or company name, case-insensitive), most specific first, max 4. */
export function extractSymbols(title: string, max = 4): string[] {
  matchers ??= build();
  const hits: string[] = [];
  for (const m of matchers) {
    if (m.re.test(title)) {
      hits.push(m.symbol);
      if (hits.length >= max) break;
    }
  }
  return hits;
}

export const GOOGLE_NEWS_BUSINESS = 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-IN&gl=IN&ceid=IN:en';
