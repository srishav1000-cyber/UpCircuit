// Server-side alert rules: pure evaluation. The cron backstop (app/api/worker/alerts) feeds it delayed price quotes; the live daemon (daemon/engine.ts)
// feeds it ticks plus volume baselines and top-5 depth. The vocabulary (kinds, labels, validation) lives in lib/alertTypes.ts.
import type { AlertRule, RuleKind, RuleQuote, RuleHit } from './alertTypes';

export { RULE_KINDS, RULE_LABEL, KIND_META, RULE_BOUNDS, SYMBOL_RE, validateRule, validateRuleInput, fmtThreshold, isRuleKind } from './alertTypes';
export type { AlertRule, RuleKind, RuleQuote, RuleHit, RuleInput } from './alertTypes';

/** how far below the threshold an imbalance may drift before a rule that already fired is considered "released" (stops a hovering book from re-arming every tick) */
export const IMBALANCE_HYSTERESIS = 0.05;

export const dayPct = (q: RuleQuote): number | null => (q.prevClose > 0 && q.ltp > 0 ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : null);

/** The circuit band (5/10/20 %) a stock trades under isn't known from a bare quote, so "proximity" means: |day move| ≥ (band − threshold) for the smallest band the move has not already exceeded. */
export function proximity(pct: number, thresholdPct: number): number | null {
  const a = Math.abs(pct);
  for (const band of [5, 10, 20]) if (a < band) return a >= band - thresholdPct ? band : null;
  return null;
}

/** the original five kinds treat a quote without a previous close as bad data (as the cron worker always has); volume / depth kinds do not need one */
const PRICE_KINDS: ReadonlySet<RuleKind> = new Set<RuleKind>(['price_above', 'price_below', 'pct_up', 'pct_down', 'circuit_proximity']);

/** false = this quote cannot answer the rule (N/A): no previous close, no volume baseline, no usable depth. Callers must skip, never treat it as "condition false". */
export function canEvaluate(kind: RuleKind, q: RuleQuote): boolean {
  if (!(q.ltp > 0)) return false;
  if (PRICE_KINDS.has(kind)) return q.prevClose > 0;
  if (kind === 'volume_surge') return typeof q.baselineVolume === 'number' && q.baselineVolume > 0 && typeof q.volume === 'number' && Number.isFinite(q.volume) && q.volume >= 0;
  if (kind === 'order_imbalance_above' || kind === 'order_imbalance_below') return typeof q.imbalance === 'number' && Number.isFinite(q.imbalance);
  return true;
}

/** `hold` = the condition was already true on the previous evaluation: imbalance rules then use a slightly looser release band (hysteresis). */
export function evaluateRule(rule: AlertRule, q: RuleQuote | undefined, now = Date.now(), hold = false): RuleHit | null {
  if (!rule.enabled || !q || !canEvaluate(rule.kind, q)) return null;
  if (rule.last_triggered_at && now - Date.parse(rule.last_triggered_at) < rule.cooldown_min * 60_000) return null;
  const pct = dayPct(q);
  const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sign = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  const hit = (message: string): RuleHit => ({ rule, price: q.ltp, pct: pct ?? 0, message });
  const dayTxt = pct === null ? '' : ` (${sign(pct)})`;
  switch (rule.kind) {
    case 'price_above': return q.ltp >= rule.threshold ? hit(`${rule.symbol} ₹${fmt(q.ltp)} is above ₹${fmt(rule.threshold)}${dayTxt}`) : null;
    case 'price_below': return q.ltp <= rule.threshold ? hit(`${rule.symbol} ₹${fmt(q.ltp)} is below ₹${fmt(rule.threshold)}${dayTxt}`) : null;
    case 'pct_up': return pct !== null && pct >= rule.threshold ? hit(`${rule.symbol} is up ${sign(pct)} today (₹${fmt(q.ltp)}) — rule ≥ ${rule.threshold}%`) : null;
    case 'pct_down': return pct !== null && pct <= -rule.threshold ? hit(`${rule.symbol} is down ${sign(pct)} today (₹${fmt(q.ltp)}) — rule ≥ ${rule.threshold}%`) : null;
    case 'circuit_proximity': {
      const band = pct === null ? null : proximity(pct, rule.threshold);
      return band && pct !== null ? hit(`${rule.symbol} ${sign(pct)} is within ${rule.threshold}% of a ${band}% circuit limit (₹${fmt(q.ltp)})`) : null;
    }
    case 'volume_surge': {
      const ratio = (q.volume as number) / (q.baselineVolume as number);
      return ratio >= rule.threshold ? hit(`${rule.symbol} volume ${fmt(q.volume as number)} is ${ratio.toFixed(2)}× its typical daily volume (${fmt(q.baselineVolume as number)}) — rule ≥ ${rule.threshold}×${dayTxt}`) : null;
    }
    case 'order_imbalance_above': {
      const v = q.imbalance as number, th = rule.threshold - (hold ? IMBALANCE_HYSTERESIS : 0);
      return v >= th ? hit(`${rule.symbol} top-5 depth is buy-heavy: imbalance ${v >= 0 ? '+' : ''}${v.toFixed(2)} (rule ≥ +${rule.threshold}; heuristic of resting orders)`) : null;
    }
    case 'order_imbalance_below': {
      const v = q.imbalance as number, th = rule.threshold - (hold ? IMBALANCE_HYSTERESIS : 0);
      return v <= -th ? hit(`${rule.symbol} top-5 depth is sell-heavy: imbalance ${v >= 0 ? '+' : ''}${v.toFixed(2)} (rule ≤ −${rule.threshold}; heuristic of resting orders)`) : null;
    }
  }
}

export function evaluateAll(rules: AlertRule[], quotes: Map<string, RuleQuote>, now = Date.now()): RuleHit[] {
  const out: RuleHit[] = [];
  for (const r of rules) {
    const h = evaluateRule(r, quotes.get(r.symbol.toUpperCase()), now);
    if (h) out.push(h);
  }
  return out;
}
