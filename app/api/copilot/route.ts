import { callGemini, geminiConfigured } from '@/lib/gemini';
import { finishAnswer } from '@/lib/followups';
import { getNews } from '@/lib/news';
import { MAX_QUESTION, SYSTEM_PROMPT, answerLocally, buildPrompt, isContext, relevantHeadlines, type CopilotAnswer } from '@/lib/copilot';
import { TtlCache, allow } from '@/lib/ttlCache';

// Edge-compatible: fetch only.
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const TTL_MS = 5 * 60_000;
const cache = new TtlCache<CopilotAnswer>(TTL_MS, 300);

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * POST /api/copilot  { question: string, context: CopilotContext }
 *
 * 1. 5-minute TTL cache (same stock + question + ~1% price bucket) — saves quota
 * 2. Gemini (primary)
 * 3. On quota / auth / outage / no key → local VADER + financial-rules engine, cached for the same 5 minutes
 *
 * Per-IP limit: 20 requests / minute (best-effort, per isolate).
 */
export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
  if (!allow('copilot:' + ip, 20, 60_000)) return json({ error: 'Too many questions — please wait a minute.' }, 429);

  let body: { question?: unknown; context?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > 12_000) return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return json({ error: 'Ask a question about the stock.' }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `Questions are limited to ${MAX_QUESTION} characters.` }, 400);
  if (!isContext(body.context)) return json({ error: 'Missing or malformed stock context.' }, 400);
  const ctx = body.context;

  // price bucketed to ~1 % so a ticking price doesn't defeat the cache
  const bucket = Math.round(Math.log(Math.max(ctx.price.ltp, 0.01)) / 0.01);
  const key = `${ctx.symbol}|${question.toLowerCase().replace(/\s+/g, ' ')}|${bucket}`;

  const hit = cache.get(key);
  if (hit) return json({ ...hit.value, source: 'cache', ageSec: Math.round(hit.ageMs / 1000) } satisfies CopilotAnswer);

  const news = await getNews();
  const { items } = relevantHeadlines(ctx, news.items, 6);

  let answer: CopilotAnswer;
  let reason: string | undefined;
  if (geminiConfigured()) {
    const g = await callGemini({ system: SYSTEM_PROMPT, prompt: buildPrompt(question, ctx, items), maxTokens: 2048 });
    if (g.ok) {
      answer = { answer: finishAnswer(g.text, g.truncated).answer, source: 'gemini' };
      cache.set(key, answer);
      return json(answer);
    }
    reason = g.detail ? `${g.reason} (${g.detail})` : g.reason;
  } else reason = 'no_key';

  answer = { answer: answerLocally(question, ctx, news.items), source: 'local', fallbackReason: reason };
  // never pin a local answer for 5 min after a transient Gemini failure — the next ask should retry Gemini
  if (reason?.startsWith('quota')) cache.set(key, answer);
  return json(answer);
}
