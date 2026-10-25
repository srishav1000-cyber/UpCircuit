'use client';

import { useEffect, useMemo, useState } from 'react';
import type { NewsResponse, SentimentLabel } from '@/lib/types';
import { Badge, sentimentTone } from './ui';
import { aggregate, labelOf } from '@/lib/sentiment';

import { relativeTime } from '@/lib/newsEngine';

type Filter = 'All' | SentimentLabel;

interface Props {
  news: NewsResponse | null;
  error: string | null;
  className?: string;
  /** open a mentioned stock */
  onSymbol?: (symbol: string) => void;
}

/** Live RSS headlines with local VADER + financial-rules sentiment badges. */
export function MarketNews({ news, error, className = '', onSymbol }: Props) {
  const [filter, setFilter] = useState<Filter>('All');
  // "12 mins ago" labels keep counting between the 5-minute server refreshes
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const stats = useMemo(() => {
    const items = news?.items ?? [];
    const count = { Bullish: 0, Bearish: 0, Neutral: 0 } as Record<SentimentLabel, number>;
    items.forEach((i) => count[i.label]++);
    const avg = aggregate(items.map((i) => i.score));
    return { count, avg, label: labelOf(avg) };
  }, [news]);

  const items = (news?.items ?? []).filter((i) => filter === 'All' || i.label === filter);

  return (
    <section className={`flex min-h-0 flex-col rounded-md border border-line bg-panel ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Market news {news?.mode === 'live' && <span data-testid="news-live" title={`Fetched ${relativeTime(news.fetchedAt, now)} · refreshes every 5 min`} className="inline-flex items-center gap-1 rounded bg-up/15 px-1.5 py-px text-[9px] font-bold text-up"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-up" />LIVE</span>}</h3>
        {news && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            Tone <Badge tone={sentimentTone(stats.label)}>{stats.label} {stats.avg >= 0 ? '+' : ''}{stats.avg.toFixed(2)}</Badge>
          </span>
        )}
      </header>

      <div className="flex gap-1 border-b border-line px-3 py-1.5" role="group" aria-label="Filter by sentiment">
        {(['All', 'Bullish', 'Neutral', 'Bearish'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`rounded px-2 py-0.5 text-[11px] font-semibold ${filter === f ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
          >
            {f}
            {news && f !== 'All' && <span className="num ml-1 text-muted">{stats.count[f]}</span>}
          </button>
        ))}
      </div>

      {news?.mode === 'sample' && (
        <div className="border-b border-line bg-warn/10 px-3 py-2 text-[11px] text-warn" title={news.errors.join('\n')}>
          Live RSS feeds were unreachable — showing sample headlines. Set <code>NEWS_RSS_URLS</code> to feeds your server can reach.
        </div>
      )}
      {news?.mode === 'live' && (news.filtered ?? 0) > 0 && (
        <div className="border-b border-line px-3 py-1 text-[10px] text-muted" data-testid="news-filtered">Showing equity, earnings, IPO and macro headlines only · {news.filtered} off-topic item{news.filtered === 1 ? '' : 's'} filtered</div>
      )}
      {news?.mode === 'live' && news.errors.length > 0 && (
        <div className="border-b border-line px-3 py-1 text-[10px] text-muted" title={news.errors.join('\n')}>
          {news.errors.length} feed(s) failed — hover for details
        </div>
      )}

      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {!news && !error && <li className="px-3 py-6 text-center text-[13px] text-muted">Loading headlines…</li>}
        {error && !news && <li className="px-3 py-6 text-center text-[13px] text-down">Couldn’t load news ({error}).</li>}
        {news && items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">No {filter.toLowerCase()} headlines right now.</li>}
        {items.map((n) => {
          const external = /^https?:\/\//.test(n.link);
          const Title = (
            <span className="text-[13px] leading-snug text-ink group-hover:text-accent">{n.title}</span>
          );
          return (
            <li key={n.id} className="group flex items-start gap-2.5 px-3 py-2.5">
              <Badge tone={sentimentTone(n.label)} className="mt-0.5 w-[62px] shrink-0 justify-center" >{n.label}</Badge>
              <div className="min-w-0 flex-1">
                {external ? (
                  <a href={n.link} target="_blank" rel="noopener noreferrer">{Title}</a>
                ) : (
                  Title
                )}
                {n.symbols && n.symbols.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1" data-testid="news-symbols">
                    {n.symbols.map((sym) => (
                      <button key={sym} type="button" onClick={() => onSymbol?.(sym)} disabled={!onSymbol} className="num rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[9px] font-bold text-accent enabled:hover:bg-accent/20">{sym}</button>
                    ))}
                  </div>
                )}
                <div className="mt-0.5 text-[10px] text-muted">
                  {n.source}
                  {n.published ? <> · <span data-testid="news-age">{relativeTime(n.published, now)}</span></> : ''} · <span className="num">{n.score >= 0 ? '+' : ''}{n.score.toFixed(2)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
