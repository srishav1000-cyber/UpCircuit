// Structured Copilot answers: the model (and the local rules engine) emit a small, line-based card markup that the UI renders as
// KPI chips, a verdict banner, bullet insights and collapsible sections instead of a wall of prose. Pure functions (edge + browser safe).
//
//   [VERDICT: BULLISH] one-line takeaway
//   [P/E: 21.5 | Fair] [RSI: 44.4 | Neutral] [Next resistance: ₹1,320]
//   - **Lead-in:** one short insight
//   ### Risks            (collapsible)
//   - **Leverage:** …
export type Verdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type ChipTone = 'up' | 'down' | 'warn' | 'muted';
export interface Chip { label: string; value: string; tag?: string; tone: ChipTone }
export interface CardSection { title: string; body: string }
export interface CopilotCard {
  verdict: Verdict | null;
  takeaway: string;
  chips: Chip[];
  /** bullets / text shown directly (markdown) */
  body: string;
  /** collapsible ### sections */
  sections: CardSection[];
  /** true when the answer used the card markup at all */
  structured: boolean;
}

const VERDICT_RE = /^\s*\[\s*VERDICT\s*:\s*(BULLISH|BEARISH|NEUTRAL)\s*\]\s*(.*)$/i;
const CHIP_RE = /\[\s*([^\[\]|:]{1,28}?)\s*:\s*([^\[\]|]{1,40}?)\s*(?:\|\s*([^\[\]]{1,24}?)\s*)?\]/g;
const CHIP_LINE = /^\s*(?:\[[^\[\]]+\]\s*)+$/;
const HEAD_RE = /^\s{0,3}#{2,4}\s+(.+?)\s*#*\s*$/;

const UP = /\b(good|strong|bull\w*|low|healthy|attractive|cheap|oversold|positive|above|rich|high yield)\b/i;
const DOWN = /\b(bear\w*|weak|high|expensive|overbought|stretched|poor|negative|below|elevated|risk\w*)\b/i;
const WARN = /\b(fair|moderate|ok|mixed|average|in line)\b/i;
export const toneOfTag = (tag?: string): ChipTone => (!tag ? 'muted' : WARN.test(tag) ? 'warn' : DOWN.test(tag) ? 'down' : UP.test(tag) ? 'up' : 'muted');

export function parseChips(line: string): Chip[] {
  const out: Chip[] = [];
  for (const m of Array.from(line.matchAll(CHIP_RE))) {
    if (/^verdict$/i.test(m[1])) continue;
    out.push({ label: m[1].trim(), value: m[2].trim(), tag: m[3]?.trim() || undefined, tone: toneOfTag(m[3]) });
  }
  return out;
}

export function parseCopilotCard(text: string): CopilotCard {
  const lines = text.replace(/\r/g, '').split('\n');
  const card: CopilotCard = { verdict: null, takeaway: '', chips: [], body: '', sections: [], structured: false };
  const body: string[] = [];
  let sec: { title: string; lines: string[] } | null = null;
  const flush = () => {
    if (sec) card.sections.push({ title: sec.title, body: sec.lines.join('\n').trim() });
    sec = null;
  };
  for (const line of lines) {
    const v = VERDICT_RE.exec(line);
    if (v && !card.verdict) {
      card.verdict = v[1].toUpperCase() as Verdict;
      card.takeaway = v[2].trim();
      card.structured = true;
      continue;
    }
    if (CHIP_LINE.test(line)) {
      const c = parseChips(line);
      if (c.length) {
        card.chips.push(...c);
        card.structured = true;
        continue;
      }
    }
    const h = HEAD_RE.exec(line);
    if (h) {
      flush();
      sec = { title: h[1].replace(/\*\*/g, '').trim(), lines: [] };
      card.structured = true;
      continue;
    }
    (sec ? sec.lines : body).push(line);
  }
  flush();
  card.body = body.join('\n').trim();
  card.sections = card.sections.filter((s) => s.body);
  return card;
}

/* ── quick action chips shown under every answer ── */
export interface QuickAction { id: string; label: string; question: string }
export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'breakout', label: '⚡ Technical Breakout?', question: 'Is there a technical breakout? Check RSI, support, resistance and trend.' },
  { id: 'peer', label: '📊 Peer Valuation', question: 'Is it expensive on valuation (P/E and price-to-book)?' },
  { id: 'debt', label: '🚩 Debt Analysis', question: 'How healthy is the balance sheet and debt?' },
  { id: 'news', label: '📰 News Sentiment', question: 'How is the news sentiment?' },
  { id: 'risk', label: '🛡️ Key Risks', question: 'What are the key risks?' },
  { id: 'div', label: '💰 Dividend', question: 'Is the dividend attractive?' },
];
