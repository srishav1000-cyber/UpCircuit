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

/** Google News India, restricted to market topics (a general BUSINESS topic feed is mostly consumer / auto / tech noise) */
export const GOOGLE_NEWS_BUSINESS = 'https://news.google.com/rss/search?q=' + encodeURIComponent('(Sensex OR Nifty OR NSE OR BSE OR SEBI OR RBI OR IPO OR "quarterly results" OR dividend OR "stock market") when:1d') + '&hl=en-IN&gl=IN&ceid=IN:en';

/* ───────────── market-relevance filter ───────────── */

// hard market / macro anchors — one of these is enough
const HARD = new RegExp(
  '\\b(' +
    [
      'nifty(?: ?50| bank| it| midcap| smallcap)?', 'sensex', 'sebi', 'nse', 'bse', 'fii', 'fpi', 'dii', 'dalal street', 'bank nifty', 'f&o', 'midcaps?', 'smallcaps?', 'largecaps?',
      'stocks?', '(?:domestic|indian|equity|stock|share|financial|global|asian|european|us) markets?', 'markets? (?:steady|open|close|end|rally|fall|slump|edge|rise|gain|lose|trade|extend|snap|recover|surge|tumble|climb|dip|wrap|ease|turn|stay|remain)', 'bourses', 'indices', 'wall street', 'dow jones', 'nasdaq', 's&p 500', 'equity', 'equities', 'share price', 'shares?(?= (?:of|in|jump|surge|fall|slump|rally|tank|gain|dip|rise|climb|crash|hit|soar|plunge|zoom|drop|trade|open|close|end|settle|slide|extend))',
      'market cap(?:italisation|italization)?', 'mutual funds?', 'brokerages?', 'target price', 'analysts?', 'bull(?:ish)? ?run', 'bear market', 'sell-?off', 'rally', 'short squeeze', 'upper circuit', 'lower circuit', '52-week (?:high|low)',
      'ipo', 'gmp', 'grey market premium', 'allotment', 'listing (?:gains?|day|date)', 'lists? at', 'anchor investors?', 'ofs', 'qip', 'rights issue',
      'earnings', 'quarterly results?', 'q[1-4] ?(?:fy ?\\d{2,4})?(?: results?| earnings| profit| net profit| revenue)?', 'results?(?= (?:today|preview|date))', 'net profit', 'ebitda', 'operating margins?', 'dividends?', 'stock split', 'bonus issue', 'buy-?back', 'merger', 'acquisitions?', 'acquires?', 'takeover', 'demerger', 'block deals?', 'bulk deals?', 'order wins?', 'stake sale',
      'rbi', 'repo rate', 'monetary policy', 'mpc', 'inflation', 'cpi', 'wpi', 'gdp', 'fiscal deficit', 'gst collections?', 'rupee', 'bond yields?', 'treasury yields?', 'fed (?:rate|cut|hike|minutes)', 'crude oil', 'brent', 'gold prices?', 'forex reserves?', 'current account', 'budget', 'union budget', 'rate cuts?', 'rate hikes?', 'trade deal', 'tariffs?',
    ].join('|') +
    ')\\b',
  'i',
);
// borderline words: only count when a listed company / ticker is also named
const SOFT = /\b(revenue|profit|valuation|deal|results?|growth|guidance|margins?|capex|order book|debt|stake|fundraise|raises? (?:rs|₹)|crore|cr)\b/i;
// clearly not about markets
const NOISE = new RegExp(
  '\\b(' +
    [
      'spy ?shots?', 'first drive', 'test drive', 'road test', 'unveils?', 'teaser', 'smartphones?', 'iphone', 'android', 'ios \\d+', 'wordpress', 'bugs?', 'glitch', 'outage', 'broke the internet', 'goes viral', 'viral', 'recipes?', 'horoscope', 'cricket', 'ipl', 'bollywood', 'box office', 'celebrity', 'fashion', 'travel', 'trailer', 'playstation', 'xbox', 'netflix', 'gaming', 'laptops?', 'earbuds', 'smartwatch',
      'factory in (?!india)', 'car review', 'bike review', 'suv review', 'electric car', 'ev launch',
    ].join('|') +
    ')\\b',
  'i',
);
// one of these keeps a headline even when a noise word also appears
const STRONG = /\b(nifty|sensex|sebi|nse|bse|ipo|gmp|stocks?|earnings|quarterly results?|dividend|rbi|repo rate|inflation|gdp|fii|dii)\b/i;

/** Sources / hosts that publish consumer-tech, auto-review or general-entertainment content — never equities news. */
const BLOCKED_SOURCES = /\b(autocar|carandbike|car and bike|rushlane|gaadiwaadi|cardekho|carwale|zigwheels|motorbeam|bikewale|91mobiles|gsmarena|gadgets ?360|the verge|techcrunch|engadget|wired|techradar|digit\.in|bgr|mashable|ign|gamespot|pinkvilla|filmfare|bollywood hungama)\b/i;
const BLOCKED_HOSTS = /(autocarindia|carandbike|rushlane|gaadiwaadi|91mobiles|gsmarena|gadgets360|theverge|techcrunch|engadget|wired\.com|techradar|digit\.in|bgr\.in|pinkvilla|filmfare)/i;

/**
 * Strict relevance: Indian equities (indices, SEBI / NSE / BSE, FII / DII), corporate financials (results, dividends, M&A), IPOs / listings and macro policy (RBI, inflation, GDP).
 * Everything else — auto reviews, consumer tech, entertainment, foreign factory news — is dropped.
 */
export function isMarketRelevant(title: string, opts: { source?: string; link?: string } = {}): boolean {
  if (opts.source && BLOCKED_SOURCES.test(opts.source)) return false;
  if (opts.link && BLOCKED_HOSTS.test(opts.link)) return false;
  const t = title.replace(/\s+/g, ' ');
  const strong = STRONG.test(t);
  if (NOISE.test(t) && !strong) return false;
  if (HARD.test(t)) return true;
  return SOFT.test(t) && extractSymbols(t, 1).length > 0;
}

/* ───────────── stock-specific news + sentiment ───────────── */

const GENERIC_FIRST = /^(bharat|hindustan|national|indian|oil|tata|adani|bajaj|mahindra|aditya|birla|state|bank|power|steel|life|general|new|first|united|global)$/i;
/** Does a headline talk about this stock? Ticker (word-bounded), the full company core name, or an unambiguous first word. */
export function mentionsStock(title: string, symbol: string, name = ''): boolean {
  const esc2 = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats: string[] = [];
  if (symbol.length >= 3 && !STOP.has(symbol.toUpperCase())) pats.push(`\\b${esc2(symbol)}\\b`);
  else if (symbol.length >= 2) pats.push(`\\b${esc2(symbol)}\\b(?=[ ,:'’]*(?:share|stock|q[1-4]|results|ltd))`);
  const core = name.replace(CORP, ' ').replace(/[^A-Za-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (core.length >= 5) pats.push(`\\b${esc2(core)}\\b`);
  const first = core.split(' ')[0];
  if (first && first.length >= 6 && first.toLowerCase() !== core.toLowerCase() && !GENERIC_FIRST.test(first)) pats.push(`\\b${esc2(first)}\\b`);
  return pats.length > 0 && new RegExp(pats.join('|'), 'i').test(title);
}

export interface NewsLike { title: string; label: 'Bullish' | 'Bearish' | 'Neutral'; score: number; published: number; source?: string; link?: string; id?: string }
export const stockNews = <T extends NewsLike>(items: T[], symbol: string, name = '', max = 8): T[] => items.filter((n) => mentionsStock(n.title, symbol, name)).slice(0, max);

export interface SentimentSummary { total: number; bullish: number; bearish: number; neutral: number; dominant: 'Bullish' | 'Bearish' | 'Neutral' | null; pct: number }
/** counts + the dominant polarity and its share of the articles (ties → Neutral) */
export function summarizeSentiment(items: { label: 'Bullish' | 'Bearish' | 'Neutral' }[]): SentimentSummary {
  const c = { bullish: 0, bearish: 0, neutral: 0 };
  items.forEach((i) => c[i.label.toLowerCase() as keyof typeof c]++);
  const total = items.length;
  if (!total) return { total, ...c, dominant: null, pct: 0 };
  const max = Math.max(c.bullish, c.bearish, c.neutral);
  const top = (['Bullish', 'Bearish', 'Neutral'] as const).filter((l) => c[l.toLowerCase() as keyof typeof c] === max);
  const dominant = top.length === 1 ? top[0] : 'Neutral';
  return { total, ...c, dominant, pct: Math.round((c[dominant.toLowerCase() as keyof typeof c] / total) * 100) };
}
export const sentimentChipText = (s: SentimentSummary): string => (s.total === 0 ? 'No recent headlines' : `${s.pct}% ${s.dominant} (${s.total} article${s.total === 1 ? '' : 's'})`);
