// Follow-up question pills + safe handling of long Gemini answers. Pure functions (edge + browser safe).

const MARK = /(?:\[\[|\*\*|#+\s*)?\s*FOLLOW[\s_-]?UPS?\s*(?:\]\])?\s*:\s*\**/i;

const clean = (q: string) =>
  q
    .replace(/^\s*(?:[-*•\d]+[.)]?\s+)/, '')
    .replace(/\[\[|\]\]|\*\*|^["“'`]+|["”'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Remove the trailing `FOLLOW_UPS: a? | b? | c?` line the model was asked to add and return its questions (max 3, complete, ≤ 90 chars). */
export function extractFollowUps(raw: string, truncated = false): { text: string; followUps: string[] } {
  const m = MARK.exec(raw);
  if (!m) return { text: raw.trim(), followUps: [] };
  const text = raw.slice(0, m.index).trim();
  const body = raw.slice(m.index + m[0].length);
  const items = body
    .split(/\||\n/)
    .map(clean)
    .filter((q) => q.length >= 8 && q.length <= 90);
  // imperatives ("Suggest rebalancing actions") are fine; but after a token cut the last item may be unfinished → keep it only if it is a full question
  if (truncated && items.length && !items[items.length - 1].endsWith('?')) items.pop();
  return { text, followUps: Array.from(new Set(items)).slice(0, 3) };
}

/** Cut a token-limited answer back to its last complete sentence / bullet and close dangling bold, so it never ends mid-sentence. */
export function trimToSentence(text: string): string {
  let t = text.trimEnd();
  const m = /[\s\S]*[.!?](?=\s|$|\*|["')\]])/.exec(t);
  if (m && m[0].length >= t.length * 0.4) t = m[0];
  else {
    const nl = t.lastIndexOf('\n');
    if (nl > t.length * 0.4) t = t.slice(0, nl);
  }
  t = t.replace(/\n[-*•]\s*$/, '').replace(/\n\d+[.)]\s*$/, '').trimEnd();
  if ((t.match(/\*\*/g)?.length ?? 0) % 2 === 1) t = t.slice(0, t.lastIndexOf('**')) + t.slice(t.lastIndexOf('**') + 2);
  return t.trimEnd();
}

/** Gemini text → { answer, followUps }: strips the follow-up line first, then trims if the model hit its token limit. */
export function finishAnswer(raw: string, truncated?: boolean): { answer: string; followUps: string[] } {
  const { text, followUps } = extractFollowUps(raw, truncated);
  return { answer: truncated ? trimToSentence(text) : text, followUps };
}

interface Ctx {
  focus?: { symbol: string } | null;
  portfolio?: { holdings: unknown[] } | null;
}

type Tag = 'sector' | 'pnl' | 'rebalance' | 'market' | 'news' | 'stock' | 'risk';
const TAGS: [Tag, RegExp][] = [
  ['rebalance', /rebalanc|trim|reduce|improve|what should i/i],
  ['sector', /sector|exposure|overexpos|concentrat|diversif/i],
  ['pnl', /p&l|pnl|profit|loss|return|nifty 50|benchmark/i],
  ['news', /news|sentiment|headline/i],
  ['market', /market|nifty|sensex|breadth|today/i],
  ['risk', /risk|downside|overbought|oversold|rsi/i],
];
const tagOf = (q: string): Tag | undefined => TAGS.find(([, re]) => re.test(q))?.[0];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** 2–3 contextual follow-ups (used when the model gives none, and for the local rules engine). Never repeats the question just asked. */
export function suggestFollowUps(question: string, ctx: Ctx | null | undefined, n = 3): string[] {
  const has = !!ctx?.portfolio?.holdings?.length;
  const sym = ctx?.focus?.symbol;
  const pool: { q: string; tag: Tag }[] = [
    ...(has
      ? [
          { q: 'Which sectors am I overexposed to?', tag: 'sector' as Tag },
          { q: 'How does my P&L compare to NIFTY 50?', tag: 'pnl' as Tag },
          { q: 'Suggest rebalancing actions', tag: 'rebalance' as Tag },
        ]
      : [
          { q: 'Which sectors are leading and lagging today?', tag: 'sector' as Tag },
          { q: 'What are the main risks for the market right now?', tag: 'risk' as Tag },
        ]),
    ...(sym ? [{ q: `What are the key risks for ${sym}?`, tag: 'risk' as Tag }, { q: `How does ${sym} compare with its sector peers?`, tag: 'stock' as Tag }] : []),
    { q: 'How is news sentiment right now?', tag: 'news' },
    { q: 'What is driving the market today?', tag: 'market' },
  ];
  const asked = norm(question);
  const cur = tagOf(question);
  const fresh = pool.filter((p) => norm(p.q) !== asked);
  const ranked = [...fresh.filter((p) => p.tag !== cur), ...fresh.filter((p) => p.tag === cur)];
  return ranked.slice(0, n).map((p) => p.q);
}
