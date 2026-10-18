import { SentimentIntensityAnalyzer } from 'vader-sentiment';
import type { SentimentLabel } from './types';

/**
 * Local headline sentiment: VADER (general English) blended with a finance-specific rule layer,
 * because VADER alone misreads market jargon ("falls short", "circuit", "bull run").
 * Pure JS — runs in the edge runtime and in the browser, no API quota involved.
 */

const POSITIVE: [RegExp, number][] = [
  [/\b(surge[sd]?|surging|rally|rallies|rallied|soar(s|ed|ing)?|jump(s|ed)?|spike[sd]?)\b/i, 1],
  [/\b(record high|all-time high|52-week high|multi-year high)\b/i, 1.5],
  [/\b(beat(s)? (estimates|expectations|street)|upbeat|robust|strong (demand|growth|results|earnings))\b/i, 1.2],
  [/\b(upgrade[sd]?|outperform|overweight|buy rating|target (raised|hiked))\b/i, 1.2],
  [/\b(buyback|bonus issue|special dividend|dividend (hike|raised))\b/i, 1],
  [/\b(order win|bags? order|wins? (order|contract)|secures? (order|contract))\b/i, 1],
  [/\b(net inflows?|FII (buying|inflows?)|FPI (buying|inflows?)|rate cut|margin expansion|profit (rises|jumps|up))\b/i, 1],
  [/\b(bullish|breakout|green|gains?|advance[sd]?|climb(s|ed)?)\b/i, 0.6],
];

const NEGATIVE: [RegExp, number][] = [
  [/\b(plunge[sd]?|plummet(s|ed)?|crash(es|ed)?|tumble[sd]?|slump(s|ed)?|sell-?off|rout)\b/i, 1.3],
  [/\b(lower circuit|52-week low|multi-year low|all-time low)\b/i, 1.5],
  [/\b(downgrade[sd]?|underperform|underweight|sell rating|target (cut|slashed|lowered))\b/i, 1.2],
  [/\b(fraud|probe|raid|penalty|fine[sd]?|default(s|ed)?|insolvency|bankruptcy|ban(s|ned)?)\b/i, 1.3],
  [/\b(misses? (estimates|expectations|street)|falls? short|weak (demand|results|earnings|growth)|profit (falls|slumps|drops|down)|loss (widens|widened))\b/i, 1.2],
  [/\b(net outflows?|FII (selling|outflows?)|FPI (selling|outflows?)|rate hike|margin pressure|layoffs?|job cuts)\b/i, 1],
  [/\b(bearish|breakdown|red|falls?|fell|drops?|dropped|slides?|slid|declines?|declined|sinks?|slips?|weakens?)\b/i, 0.6],
];

const clamp = (n: number) => Math.max(-1, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export const labelOf = (score: number, threshold = 0.15): SentimentLabel => (score >= threshold ? 'Bullish' : score <= -threshold ? 'Bearish' : 'Neutral');

export function scoreText(text: string): { score: number; label: SentimentLabel; vader: number; rules: number } {
  const vader = SentimentIntensityAnalyzer.polarity_scores(text).compound;
  let hits = 0;
  let sum = 0;
  for (const [re, w] of POSITIVE) if (re.test(text)) (sum += w), hits++;
  for (const [re, w] of NEGATIVE) if (re.test(text)) (sum -= w), hits++;
  const rules = clamp(sum / 2);
  // finance rules dominate when they fire; otherwise trust (a dampened) VADER
  const score = hits > 0 ? clamp(0.35 * vader + 0.65 * rules) : clamp(vader * 0.7);
  return { score: round2(score), label: labelOf(score), vader: round2(vader), rules: round2(rules) };
}

/** Mean score of a list of scores, rounded; 0 for an empty list. */
export function aggregate(scores: number[]): number {
  if (scores.length === 0) return 0;
  return round2(scores.reduce((a, b) => a + b, 0) / scores.length);
}
