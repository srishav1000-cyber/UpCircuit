'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_ASK, type AskContext, type AskTurn } from '@/lib/ask';
import type { CopilotAnswer, CopilotSource } from '@/lib/copilot';
import { Badge } from './ui';
import { Markdown } from './Markdown';
import { scoped } from '@/lib/scope';

interface Msg {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
  source?: CopilotSource;
  reason?: string;
  ageSec?: number;
  followUps?: string[];
}

const STORE = 'upcircuit:ask';
const REASONS: Record<string, string> = {
  no_key: 'Gemini isn’t configured — answered by the local rules engine.',
  quota: 'Gemini quota reached — answered locally (cached for 5 min).',
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

export interface AskRequest {
  id: number;
  text: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** called at send time so answers use the latest prices, holdings and selected stock */
  getContext: () => AskContext;
  /** programmatic question (e.g. "Ask AI" buttons); sent once per id */
  request: AskRequest | null;
  focusSymbol: string | null;
  hasPortfolio: boolean;
}

/**
 * ✨ Ask UpCircuit — persistent slide-over copilot for free-text market and portfolio questions.
 * Always mounted (so the conversation survives closing) and saved to localStorage.
 * Gemini primary → local rules fallback (with the 5-minute TTL cache) via /api/ask.
 */
export function AskUpCircuitDrawer({ open, onClose, getContext, request, focusSymbol, hasPortfolio }: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(1);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const hydrated = useRef(false);

  // restore / persist
  useEffect(() => {
    try {
      const raw = localStorage.getItem(scoped(STORE));
      if (raw) {
        const saved = JSON.parse(raw) as Msg[];
        if (Array.isArray(saved)) {
          setMsgs(saved.slice(-30));
          seq.current = Math.max(1, ...saved.map((m) => m.id + 1));
        }
      }
    } catch {
      /* storage unavailable */
    }
    hydrated.current = true;
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(scoped(STORE), JSON.stringify(msgs.slice(-30)));
    } catch {
      /* ignore */
    }
  }, [msgs]);
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy, open]);

  // focus the input when opened; Esc closes
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => input.current?.focus(), 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[data-order-modal]')) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const ask = useCallback(
    async (q: string) => {
      const question = q.trim();
      if (!question || busy) return;
      setText('');
      const history: AskTurn[] = msgsRef.current.filter((m) => m.role !== 'error').slice(-6).map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }));
      setMsgs((m) => [...m, { id: seq.current++, role: 'user', text: question }]);
      setBusy(true);
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      const timer = setTimeout(() => ac.abort(), 40_000); // a full analyst answer can take ~20 s
      try {
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, history, context: getContext() }),
          signal: ac.signal,
        });
        const data = (await res.json().catch(() => ({}))) as Partial<CopilotAnswer> & { error?: string };
        if (!res.ok || !data.answer) throw new Error(data.error ?? `Request failed (${res.status})`);
        setMsgs((m) => [...m, { id: seq.current++, role: 'assistant', text: data.answer!, source: data.source, reason: data.fallbackReason, ageSec: data.ageSec, followUps: data.followUps }]);
      } catch (e) {
        const timedOut = e instanceof Error && e.name === 'AbortError';
        setMsgs((m) => [...m, { id: seq.current++, role: 'error', text: timedOut ? 'The request timed out. Please try again.' : e instanceof Error ? e.message : 'Something went wrong.' }]);
      } finally {
        clearTimeout(timer);
        setBusy(false);
      }
    },
    [busy, getContext],
  );

  // programmatic questions
  const lastReq = useRef(0);
  useEffect(() => {
    if (request && request.id !== lastReq.current) {
      lastReq.current = request.id;
      ask(request.text);
    }
  }, [request, ask]);

  const suggestions = [
    'How is the market doing today?',
    hasPortfolio ? 'How diversified is my portfolio?' : 'What can you tell me about my portfolio?',
    'What is my sector exposure?',
    'Any rebalancing guidelines for my portfolio?',
    ...(focusSymbol ? [`Is ${focusSymbol} overbought?`] : []),
    'How is news sentiment?',
  ];

  return (
    <>
      <div className={`fixed inset-0 z-[70] bg-black/50 transition-opacity duration-200 sm:bg-black/30 ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`} onMouseDown={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Ask UpCircuit AI"
        aria-hidden={!open}
        className={`fixed right-0 top-0 z-[75] flex h-[100dvh] w-full max-w-full flex-col border-l border-line bg-panel shadow-2xl transition-[transform,visibility] duration-200 sm:w-[420px] ${open ? 'translate-x-0 visible' : 'invisible translate-x-full'}`}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="text-lg" aria-hidden>✨</span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-bold text-ink">Ask UpCircuit</h2>
            <p className="truncate text-[10px] text-muted">Market &amp; portfolio Q&amp;A · Gemini with local fallback</p>
          </div>
          {msgs.length > 0 && (
            <button onClick={() => setMsgs([])} className="text-[11px] text-muted hover:text-ink">Clear</button>
          )}
          <button onClick={onClose} aria-label="Close assistant (Esc)" className="flex h-8 w-8 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
        </header>

        <div ref={log} role="log" aria-live="polite" aria-label="Conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {msgs.length === 0 && (
            <div className="text-[12.5px] text-muted">
              <p className="mb-2">Ask about the market, a stock, or your portfolio — concentration, diversification, sector exposure, rebalancing, P&amp;L, news.</p>
              <p className="text-[11px]">Answers use the live data on screen. Prices are simulated unless the feed badge says LIVE.</p>
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div data-testid={m.role === 'assistant' ? 'ask-answer' : undefined} className={`max-w-[94%] break-words rounded-lg px-3 py-2 text-[12.5px] leading-relaxed ${m.role === 'assistant' ? '' : 'whitespace-pre-wrap'} ${m.role === 'user' ? 'bg-accent text-white' : m.role === 'error' ? 'border border-down/40 bg-down/10 text-down' : 'border border-line bg-bg text-ink'}`}>
                {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
                {m.role === 'assistant' && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-1.5">
                    {m.source === 'gemini' && <Badge tone="accent">GEMINI AI</Badge>}
                    {m.source === 'local' && <Badge tone="warn">Local rules</Badge>}
                    {m.source === 'cache' && <Badge tone="muted">Cached · {m.ageSec && m.ageSec >= 60 ? `${Math.round(m.ageSec / 60)}m` : `${m.ageSec ?? 0}s`} old</Badge>}
                    {m.source !== 'gemini' && reasonText(m.reason) && <span className="text-[10px] text-muted">{reasonText(m.reason)}</span>}
                  </div>
                )}
                {m.role === 'assistant' && m.followUps && m.followUps.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Suggested follow-up questions" data-testid="ask-followups">
                    {m.followUps.slice(0, 3).map((f) => (
                      <button key={f} type="button" disabled={busy} onClick={() => ask(f)} data-testid="ask-followup" className="cursor-pointer rounded-full border border-accent/50 bg-accent/10 px-2.5 py-1 text-left text-[11px] font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40">
                        {f}
                      </button>
                    ))}
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

        <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto border-t border-line px-4 pt-2">
          {suggestions.map((s) => (
            <button key={s} disabled={busy} onClick={() => ask(s)} className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-40">
              {s}
            </button>
          ))}
        </div>

        <form
          className="p-4 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(text);
          }}
        >
          <div className="flex items-end gap-2 rounded-md border border-line bg-bg px-2 py-1.5 focus-within:border-accent">
            <textarea
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_ASK))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask(text);
                }
              }}
              rows={1}
              placeholder="Ask the market, a stock or your portfolio…"
              aria-label="Your question"
              className="max-h-24 min-h-[24px] flex-1 resize-none bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
            />
            <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="rounded bg-accent px-3 py-1 text-[12px] font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
              Send
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted">Educational, not investment advice. {text.length > MAX_ASK - 80 && <span className="num">{text.length}/{MAX_ASK}</span>}</p>
        </form>
      </aside>
    </>
  );
}
