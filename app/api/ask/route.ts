import { callGemini, geminiConfigured } from '@/lib/gemini';
import { finishAnswer, suggestFollowUps } from '@/lib/followups';
import { getNews } from '@/lib/news';
import { ASK_SYSTEM, MAX_ASK, answerAskLocally, buildAskPrompt, isAskContext, type AskTurn } from '@/lib/ask';
import type { CopilotAnswer } from '@/lib/copilot';
import { TtlCache, allow } from '@/lib/ttlCache';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const cache = new TtlCache<CopilotAnswer>(5 * 60_000, 300);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * POST /api/ask  { question, history?: AskTurn[], context: AskContext }
 * Same strategy as /api/copilot: 5-min TTL cache → Gemini → local rules engine (quota / outage / no key).
 */
export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
  if (!allow('ask:' + ip, 20, 60_000)) return json({ error: 'Too many questions — please wait a minute.' }, 429);

  let body: { question?: unknown; history?: unknown; context?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > 40_000) return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return json({ error: 'Ask a question.' }, 400);
  if (question.length > MAX_ASK) return json({ error: `Questions are limited to ${MAX_ASK} characters.` }, 400);
  if (!isAskContext(body.context)) return json({ error: 'Missing or malformed context.' }, 400);
  const ctx = body.context;

  const history: AskTurn[] = Array.isArray(body.history)
    ? (body.history as AskTurn[])
        .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
        .slice(-6)
        .map((t) => ({ role: t.role, text: t.text.slice(0, 600) }))
    : [];

  // coarse key: question + feed + focus + holdings signature + NIFTY bucket, so a ticking market doesn't defeat the cache
  const nifty = ctx.indices.find((i) => i.id === 'NIFTY')?.value ?? 0;
  const sig = (ctx.portfolio?.holdings ?? []).map((h) => `${h.symbol}:${h.qty}`).join(',');
  const key = [question.toLowerCase().replace(/\s+/g, ' '), ctx.feed, ctx.focus?.symbol ?? '', sig, Math.round(Math.log(Math.max(nifty, 1)) / 0.005), history.length].join('|');
  const hit = cache.get(key);
  if (hit) return json({ ...hit.value, source: 'cache', ageSec: Math.round(hit.ageMs / 1000) } satisfies CopilotAnswer);

  const news = await getNews();
  let reason: string | undefined;
  if (geminiConfigured()) {
    const g = await callGemini({ system: ASK_SYSTEM, prompt: buildAskPrompt(question, ctx, news.items.slice(0, 6), history), maxTokens: 2048 });
    if (g.ok) {
      const fin = finishAnswer(g.text, g.truncated);
      const a: CopilotAnswer = { answer: fin.answer, source: 'gemini', followUps: fin.followUps.length ? fin.followUps : suggestFollowUps(question, ctx) };
      cache.set(key, a);
      return json(a);
    }
    reason = g.detail ? `${g.reason} (${g.detail})` : g.reason;
  } else reason = 'no_key';

  const a: CopilotAnswer = { answer: answerAskLocally(question, ctx, news.items), source: 'local', fallbackReason: reason, followUps: suggestFollowUps(question, ctx) };
  // never pin a local answer for 5 min after a transient Gemini failure — the next ask should retry Gemini
  if (reason?.startsWith('quota')) cache.set(key, a);
  return json(a);
}
