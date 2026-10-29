// Server-side alert rules: pure evaluation (the worker in app/api/worker/alerts feeds it quotes and delivers what it returns).
export const RULE_KINDS = ['price_above', 'price_below', 'pct_up', 'pct_down', 'circuit_proximity'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export interface AlertRule { id: string; user_id: string; symbol: string; kind: RuleKind; threshold: number; cooldown_min: number; channels: { push?: boolean; email?: boolean }; enabled: boolean; last_triggered_at: string | null }
export interface RuleQuote { symbol: string; ltp: number; prevClose: number }
export interface RuleHit { rule: AlertRule; price: number; pct: number; message: string }

export const RULE_LABEL: Record<RuleKind, string> = {
  price_above: 'Price rises above ₹',
  price_below: 'Price falls below ₹',
  pct_up: 'Day gain ≥ %',
  pct_down: 'Day loss ≥ %',
  circuit_proximity: 'Within … % of the circuit limit',
};
export const SYMBOL_RE = /^[A-Za-z0-9&._-]{1,24}$/;

/** Validates a rule the user typed in; returns an error string or null. */
export function validateRule(r: { symbol: string; kind: string; threshold: number; cooldown_min: number }): string | null {
  if (!SYMBOL_RE.test(r.symbol)) return 'Enter a valid symbol.';
  if (!(RULE_KINDS as readonly string[]).includes(r.kind)) return 'Pick a rule type.';
  if (!Number.isFinite(r.threshold) || r.threshold <= 0) return 'Threshold must be a positive number.';
  if ((r.kind === 'pct_up' || r.kind === 'pct_down' || r.kind === 'circuit_proximity') && r.threshold > 100) return 'A percentage threshold cannot exceed 100.';
  if (!Number.isFinite(r.cooldown_min) || r.cooldown_min < 5 || r.cooldown_min > 1440) return 'Cooldown must be 5–1440 minutes.';
  return null;
}

export const dayPct = (q: RuleQuote): number | null => (q.prevClose > 0 && q.ltp > 0 ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : null);

/** The circuit band (5/10/20 %) a stock trades under isn't known from a bare quote, so "proximity" means: |day move| ≥ (band − threshold) for the smallest band the move has not already exceeded. */
export function proximity(pct: number, thresholdPct: number): number | null {
  const a = Math.abs(pct);
  for (const band of [5, 10, 20]) if (a < band) return a >= band - thresholdPct ? band : null;
  return null;
}

export function evaluateRule(rule: AlertRule, q: RuleQuote | undefined, now = Date.now()): RuleHit | null {
  if (!rule.enabled || !q || !(q.ltp > 0)) return null;
  if (rule.last_triggered_at && now - Date.parse(rule.last_triggered_at) < rule.cooldown_min * 60_000) return null;
  const pct = dayPct(q);
  if (pct === null) return null;
  const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sign = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  const hit = (message: string): RuleHit => ({ rule, price: q.ltp, pct, message });
  switch (rule.kind) {
    case 'price_above': return q.ltp >= rule.threshold ? hit(`${rule.symbol} ₹${fmt(q.ltp)} is above ₹${fmt(rule.threshold)} (${sign(pct)})`) : null;
    case 'price_below': return q.ltp <= rule.threshold ? hit(`${rule.symbol} ₹${fmt(q.ltp)} is below ₹${fmt(rule.threshold)} (${sign(pct)})`) : null;
    case 'pct_up': return pct >= rule.threshold ? hit(`${rule.symbol} is up ${sign(pct)} today (₹${fmt(q.ltp)}) — rule ≥ ${rule.threshold}%`) : null;
    case 'pct_down': return pct <= -rule.threshold ? hit(`${rule.symbol} is down ${sign(pct)} today (₹${fmt(q.ltp)}) — rule ≥ ${rule.threshold}%`) : null;
    case 'circuit_proximity': {
      const band = proximity(pct, rule.threshold);
      return band ? hit(`${rule.symbol} ${sign(pct)} is within ${rule.threshold}% of a ${band}% circuit limit (₹${fmt(q.ltp)})`) : null;
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
