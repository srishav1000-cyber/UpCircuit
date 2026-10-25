import type { NewsItem, NewsResponse } from './types';
import { scoreText } from './sentiment';
import { TtlCache } from './ttlCache';
import { GOOGLE_NEWS_BUSINESS, extractSymbols, isMarketRelevant, splitGoogleTitle } from './newsEngine';

/**
 * RSS aggregation. Edge-safe: fetch + regex parsing only (no DOM, no native modules).
 * Override the feed list with NEWS_RSS_URLS (comma-separated). These defaults are public
 * business-news feeds; publishers move or retire feed URLs, so failures are reported, not hidden.
 */
export const DEFAULT_FEEDS = [
  GOOGLE_NEWS_BUSINESS,
  'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  'https://www.livemint.com/rss/markets',
  'https://www.business-standard.com/rss/markets-106.rss',
  'https://www.moneycontrol.com/rss/marketreports.xml',
  'https://www.thehindubusinessline.com/markets/feeder/default.rss',
];

const SOURCE_NAMES: [RegExp, string][] = [
  [/news\.google\.com/, 'Google News'],
  [/economictimes/, 'Economic Times'],
  [/livemint/, 'Mint'],
  [/business-standard/, 'Business Standard'],
  [/moneycontrol/, 'Moneycontrol'],
  [/thehindubusinessline/, 'BusinessLine'],
];
const sourceOf = (url: string) => SOURCE_NAMES.find(([re]) => re.test(url))?.[1] ?? (url.match(/^https?:\/\/(?:www\.)?([^/]+)/)?.[1] ?? 'RSS');

/* ───────────── parsing ───────────── */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const clean = (s: string) =>
  decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? clean(m[1]) : '';
}

export interface RawItem {
  title: string;
  /** <source> tag (Google News) */
  source?: string;
  link: string;
  published: number;
}

/** Parses RSS 2.0 (<item>) and Atom (<entry>) documents. */
export function parseRss(xml: string): RawItem[] {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const out: RawItem[] = [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    let link = tag(b, 'link');
    if (!link) link = b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? tag(b, 'guid');
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const t = date ? Date.parse(date) : NaN;
    if (title && /^https?:\/\//i.test(link)) out.push({ title, source: tag(b, 'source') || undefined, link, published: Number.isFinite(t) ? t : 0 });
  }
  return out;
}

/* ───────────── fetching ───────────── */

const SAMPLE: string[] = [
  '[Sample] Nifty extends gains as banking and IT stocks lead a broad rally',
  '[Sample] FII net inflows turn positive for the third straight session',
  '[Sample] Auto stocks slump as festive-season demand falls short of estimates',
  '[Sample] Crude steadies, easing pressure on the rupee and oil marketing companies',
  '[Sample] Mid-cap pharma names surge after strong quarterly results',
  '[Sample] Metal stocks slide as global demand worries weigh on commodities',
  '[Sample] Market breadth stays flat as investors await policy cues',
];

const cache = new TtlCache<NewsResponse>(5 * 60_000, 4);
let inflight: Promise<NewsResponse> | null = null;

const feedList = () =>
  (process.env.NEWS_RSS_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s))
    .concat(process.env.NEWS_RSS_URLS ? [] : DEFAULT_FEEDS);

async function fetchFeed(url: string): Promise<NewsItem[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UpCircuit/1.0; +rss)', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const source = sourceOf(url);
  return parseRss(await res.text())
    .slice(0, 15)
    .map((r) => {
      const g = /news\.google\./.test(url) ? splitGoogleTitle(r.title, r.source) : { title: r.title, source };
      const s = scoreText(g.title);
      return { id: r.link, title: g.title, link: r.link, source: g.source || source, published: r.published, score: s.score, label: s.label, symbols: extractSymbols(g.title) };
    });
}

async function build(): Promise<NewsResponse> {
  const feeds = feedList();
  const settled = await Promise.allSettled(feeds.map(fetchFeed));
  const errors: string[] = [];
  const all: NewsItem[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`${sourceOf(feeds[i])}: ${r.reason instanceof Error ? r.reason.message : 'failed'}`);
  });

  // strict relevance: equities, corporate financials, IPOs and macro policy only
  const relevant = all.filter((n) => isMarketRelevant(n.title, { source: n.source, link: n.link }));
  const filtered = all.length - relevant.length;
  const seen = new Set<string>();
  const items = relevant
    .sort((a, b) => b.published - a.published)
    .filter((n) => {
      const k = n.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 40);

  // feeds answered (even if nothing on-topic is in them right now) → still LIVE; only a total feed failure falls back to the sample headlines
  if (all.length > 0) return { items, mode: 'live', errors, fetchedAt: Date.now(), filtered };

  const now = Date.now();
  const sample: NewsItem[] = SAMPLE.map((title, i) => {
    const s = scoreText(title);
    return { id: 'sample-' + i, title, link: '#', source: 'Sample', published: now - i * 17 * 60_000, score: s.score, label: s.label, symbols: extractSymbols(title) };
  });
  return { items: sample, mode: 'sample', errors, fetchedAt: now };
}

/** Cached for 5 minutes; concurrent callers share one fetch. */
export async function getNews(): Promise<NewsResponse> {
  const hit = cache.get('news');
  if (hit) return hit.value;
  if (!inflight) {
    inflight = build()
      .then((r) => {
        cache.set('news', r);
        return r;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
