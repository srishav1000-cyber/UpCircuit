'use client';

import { useMemo, useState } from 'react';
import type { NewsResponse, SentimentLabel } from '@/lib/types';
import { Badge, sentimentTone } from './ui';
import { aggregate, labelOf } from '@/lib/sentiment';

const ago = (t: number) => {
  if (!t) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

type Filter = 'All' | SentimentLabel;

interface Props {
  news: NewsResponse | null;
  error: string | null;
  className?: string;
}

/** Live RSS headlines with local VADER + financial-rules sentiment badges. */
export function NewsFeed({ news, error, className = '' }: Props) {
  const [filter, setFilter] = useState<Filter>('All');

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
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Market news</h3>
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
                <div className="mt-0.5 text-[10px] text-muted">
                  {n.source}
                  {n.published ? ` · ${ago(n.published)}` : ''} · <span className="num">{n.score >= 0 ? '+' : ''}{n.score.toFixed(2)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
