'use client';

import { useEffect, useRef, useState } from 'react';
import { MAX_QUESTION, type CopilotAnswer, type CopilotContext, type CopilotSource } from '@/lib/copilot';
import { Badge } from './ui';
import { CopilotCards } from './CopilotCards';
import { QUICK_ACTIONS } from '@/lib/copilotCards';

interface Msg {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
  source?: CopilotSource;
  reason?: string;
  ageSec?: number;
}


const REASONS: Record<string, string> = {
  no_key: 'Gemini isn’t configured — answered by the local rules engine.',
  quota: 'Gemini quota reached — answered by the local rules engine (cached for 5 min).',
  cooldown: 'Gemini is cooling down after an error — answered locally.',
  auth: 'Gemini rejected the API key — answered locally.',
  error: 'Gemini is unavailable — answered locally.',
};
const reasonText = (r?: string) => {
  if (!r) return undefined;
  const base = REASONS[r.split(' ')[0]] ?? 'Gemini unavailable — answered locally.';
  const detail = /\((.+)\)$/.exec(r)?.[1];
  return detail ? `${base} [${detail}]` : base;
};

interface Props {
  symbol: string;
  name: string;
  /** called at send time so the question always carries the latest price / ratios / technicals */
  getContext: () => CopilotContext;
}

/** Q&A chat: Gemini primary; server falls back to a local VADER + financial-rules engine with a 5-minute TTL cache. */
export function AIStockCopilot({ symbol, name, getContext }: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const seq = useRef(1);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setText('');
    setMsgs((m) => [...m, { id: seq.current++, role: 'user', text: question }]);
    setBusy(true);
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const timer = setTimeout(() => ac.abort(), 40_000);
    try {
      const res = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, context: getContext() }),
        signal: ac.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Partial<CopilotAnswer> & { error?: string };
      if (!res.ok || !data.answer) throw new Error(data.error ?? `Request failed (${res.status})`);
      setMsgs((m) => [...m, { id: seq.current++, role: 'assistant', text: data.answer!, source: data.source, reason: data.fallbackReason, ageSec: data.ageSec }]);
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'AbortError';
      const text = timedOut ? 'The request timed out. Please try again.' : e instanceof Error ? e.message : 'Something went wrong.';
      setMsgs((m) => [...m, { id: seq.current++, role: 'error', text }]);
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col rounded-md border border-line bg-panel" aria-label="AI Stock Copilot">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <div>
          <h3 className="text-[12px] font-bold text-ink">✦ AI Stock Copilot</h3>
          <p className="text-[10px] text-muted">Ask about {symbol} · Gemini with local fallback</p>
        </div>
        {msgs.length > 0 && (
          <button onClick={() => setMsgs([])} className="text-[11px] text-muted hover:text-ink">Clear</button>
        )}
      </header>

      <div ref={log} role="log" aria-live="polite" aria-label="Conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {msgs.length === 0 && (
          <div className="text-[12px] text-muted">
            <p className="mb-2">Ask anything about <b className="text-ink">{name}</b> — valuation, quality, debt, dividends, technicals, news or risks.</p>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div
              className={`max-w-[92%] ${m.role === 'assistant' ? '' : 'whitespace-pre-wrap'} rounded-lg px-3 py-2 text-[12.5px] leading-relaxed ${
                m.role === 'user' ? 'bg-accent text-white' : m.role === 'error' ? 'border border-down/40 bg-down/10 text-down' : 'border border-line bg-bg text-ink'
              }`}
            >
              {m.role === 'assistant' ? <CopilotCards text={m.text} /> : m.text}
              {m.role === 'assistant' && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-1.5">
                  {m.source === 'gemini' && <Badge tone="accent">GEMINI AI</Badge>}
                  {m.source === 'local' && <Badge tone="warn">Local rules</Badge>}
                  {m.source === 'cache' && <Badge tone="muted">Cached · {m.ageSec && m.ageSec >= 60 ? `${Math.round(m.ageSec / 60)}m` : `${m.ageSec ?? 0}s`} old</Badge>}
                  {m.source !== 'gemini' && reasonText(m.reason) && <span className="text-[10px] text-muted">{reasonText(m.reason)}</span>}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 text-[12px] text-muted" aria-label="Thinking">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:120ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:240ms]" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 border-t border-line px-3 pt-2" role="group" aria-label="Quick actions" data-testid="copilot-quick-actions">
        {QUICK_ACTIONS.map((q) => (
          <button key={q.id} disabled={busy} onClick={() => ask(q.question)} data-testid={`quick-${q.id}`} className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/20 disabled:opacity-40">
            {q.label}
          </button>
        ))}
      </div>

      <form
        className="p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <div className="flex items-end gap-2 rounded-md border border-line bg-bg px-2 py-1.5 focus-within:border-accent">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_QUESTION))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(text);
              }
            }}
            rows={1}
            placeholder={`Ask about ${symbol}…`}
            aria-label="Your question"
            className="max-h-24 min-h-[24px] flex-1 resize-none bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
          />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="rounded bg-accent px-3 py-1 text-[12px] font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
            Send
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-muted">
          Educational, not investment advice. {text.length > MAX_QUESTION - 80 && <span className="num">{text.length}/{MAX_QUESTION}</span>}
        </p>
      </form>
    </section>
  );
}
