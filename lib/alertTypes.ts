// Alert rule vocabulary shared by the browser UI, the Next.js API (app/api/alerts/rules), the cron backstop and the live daemon.
// Pure: no I/O, no framework imports. The database CHECK constraints in docs/WEEK9_TURN43_SCHEMA.sql mirror RULE_BOUNDS below.

export const RULE_KINDS = [
  'price_above', 'price_below', 'pct_up', 'pct_down', 'circuit_proximity',
  'volume_surge', 'order_imbalance_above', 'order_imbalance_below',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface AlertRule { id: string; user_id: string; symbol: string; kind: RuleKind; threshold: number; cooldown_min: number; channels: { push?: boolean; email?: boolean }; enabled: boolean; last_triggered_at: string | null }
/** A quote as the rule evaluators see it. volume / baselineVolume / imbalance exist only on the live daemon path; the 5-minute cron backstop never has them. */
export interface RuleQuote {
  symbol: string; ltp: number; prevClose: number;
  /** cumulative traded volume today */
  volume?: number;
  /** typical full-day volume (median of recent completed sessions); null / undefined = N/A (history missing or too short) */
  baselineVolume?: number | null;
  /** top-5 depth imbalance in [-1, +1]; null / undefined = N/A (no depth, or a book too thin to mean anything) */
  imbalance?: number | null;
}
export interface RuleHit { rule: AlertRule; price: number; pct: number; message: string }

export const RULE_LABEL: Record<RuleKind, string> = {
  price_above: 'Price rises above ₹',
  price_below: 'Price falls below ₹',
  pct_up: 'Day gain ≥ %',
  pct_down: 'Day loss ≥ %',
  circuit_proximity: 'Within … % of the circuit limit',
  volume_surge: 'Day volume ≥ … × typical daily volume',
  order_imbalance_above: 'Top-5 depth buy-imbalance ≥',
  order_imbalance_below: 'Top-5 depth sell-imbalance ≥',
};

export interface KindMeta {
  unit: '₹' | '%' | '×' | 'ratio';
  min: number; max: number; step: number; placeholder: string;
  /** who can evaluate it: the cron backstop only has delayed price quotes; volume and depth need the live daemon feed */
  engine: 'cron+daemon' | 'daemon';
  help: string;
}
export const KIND_META: Record<RuleKind, KindMeta> = {
  price_above: { unit: '₹', min: 0.01, max: 9_999_999, step: 0.05, placeholder: '1500', engine: 'cron+daemon', help: 'Fires when the last price crosses up through this level.' },
  price_below: { unit: '₹', min: 0.01, max: 9_999_999, step: 0.05, placeholder: '1400', engine: 'cron+daemon', help: 'Fires when the last price crosses down through this level.' },
  pct_up: { unit: '%', min: 0.01, max: 100, step: 0.1, placeholder: '3', engine: 'cron+daemon', help: 'Fires when the day gain reaches this percentage.' },
  pct_down: { unit: '%', min: 0.01, max: 100, step: 0.1, placeholder: '3', engine: 'cron+daemon', help: 'Fires when the day loss reaches this percentage.' },
  circuit_proximity: { unit: '%', min: 0.01, max: 100, step: 0.1, placeholder: '1', engine: 'cron+daemon', help: 'Fires when the day move gets within this many % of a 5 / 10 / 20 % circuit band.' },
  volume_surge: { unit: '×', min: 0.5, max: 50, step: 0.1, placeholder: '1.5', engine: 'daemon', help: "Fires when today's cumulative volume reaches this multiple of the stock's typical full-day volume (median of its last ≤ 20 completed sessions). N/A until at least 10 sessions of history exist." },
  order_imbalance_above: { unit: 'ratio', min: 0.1, max: 1, step: 0.05, placeholder: '0.6', engine: 'daemon', help: 'Fires when (Σ top-5 bid qty − Σ top-5 ask qty) ÷ (Σ bid + Σ ask) rises to +this value. A heuristic of resting orders, not a forecast.' },
  order_imbalance_below: { unit: 'ratio', min: 0.1, max: 1, step: 0.05, placeholder: '0.6', engine: 'daemon', help: 'Fires when the same ratio falls to −this value (ask-heavy book). A heuristic of resting orders, not a forecast.' },
};
/** DB CHECK mirror: [min, max] per kind (the generic threshold > 0 check is separate) */
export const RULE_BOUNDS: Record<RuleKind, readonly [number, number]> = Object.fromEntries(RULE_KINDS.map((k) => [k, [KIND_META[k].min, KIND_META[k].max] as const])) as Record<RuleKind, readonly [number, number]>;

export const SYMBOL_RE = /^[A-Za-z0-9&._-]{1,24}$/;
export const COOLDOWN_MIN = 5;
export const COOLDOWN_MAX = 1440;
export const isRuleKind = (k: unknown): k is RuleKind => typeof k === 'string' && (RULE_KINDS as readonly string[]).includes(k);

/** Validates a rule the user typed in; returns the first error string or null. */
export function validateRule(r: { symbol: string; kind: string; threshold: number; cooldown_min: number }): string | null {
  if (!SYMBOL_RE.test(r.symbol)) return 'Enter a valid symbol.';
  if (!isRuleKind(r.kind)) return 'Pick a rule type.';
  if (!Number.isFinite(r.threshold) || r.threshold <= 0) return 'Threshold must be a positive number.';
  const [lo, hi] = RULE_BOUNDS[r.kind];
  const m = KIND_META[r.kind];
  if (r.threshold < lo || r.threshold > hi) {
    if (r.kind === 'pct_up' || r.kind === 'pct_down' || r.kind === 'circuit_proximity') return 'A percentage threshold cannot exceed 100.';
    if (r.kind === 'volume_surge') return `Volume multiple must be between ${lo}× and ${hi}× the typical daily volume.`;
    if (r.kind === 'order_imbalance_above' || r.kind === 'order_imbalance_below') return `Imbalance threshold must be between ${lo} and ${hi} (0 = balanced, 1 = one-sided book).`;
    return `Threshold must be between ${lo} and ${hi} ${m.unit}.`;
  }
  if (!Number.isFinite(r.cooldown_min) || r.cooldown_min < COOLDOWN_MIN || r.cooldown_min > COOLDOWN_MAX) return `Cooldown must be ${COOLDOWN_MIN}–${COOLDOWN_MAX} minutes.`;
  return null;
}

export interface RuleInput { symbol: string; kind: RuleKind; threshold: number; cooldown_min: number; channels: { push: boolean; email: boolean } }
export type RuleInputResult = { ok: true; value: RuleInput; warnings: string[] } | { ok: false; errors: string[] };

/** Validates and normalises an untrusted JSON body (API route). Collects every problem, not just the first. */
export function validateRuleInput(raw: unknown): RuleInputResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['Body must be a JSON object.'] };
  const b = raw as Record<string, unknown>;
  const errors: string[] = [];
  const symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : '';
  if (!SYMBOL_RE.test(symbol)) errors.push('symbol: enter a valid symbol (letters, digits, & . _ -; up to 24).');
  if (!isRuleKind(b.kind)) errors.push(`kind: must be one of ${RULE_KINDS.join(', ')}.`);
  const threshold = typeof b.threshold === 'number' ? b.threshold : typeof b.threshold === 'string' && b.threshold.trim() ? Number(b.threshold) : NaN;
  if (!Number.isFinite(threshold)) errors.push('threshold: must be a number.');
  const cooldown = b.cooldown_min === undefined ? 60 : typeof b.cooldown_min === 'number' ? b.cooldown_min : Number(b.cooldown_min);
  if (!Number.isInteger(cooldown)) errors.push('cooldown_min: must be a whole number of minutes.');
  const ch = b.channels && typeof b.channels === 'object' && !Array.isArray(b.channels) ? (b.channels as Record<string, unknown>) : b.channels === undefined ? { push: true, email: false } : null;
  if (!ch) errors.push('channels: must be an object like { "push": true, "email": false }.');
  if (!errors.length && isRuleKind(b.kind)) {
    const bad = validateRule({ symbol, kind: b.kind, threshold, cooldown_min: cooldown });
    if (bad) errors.push(bad);
  }
  if (errors.length || !isRuleKind(b.kind) || !ch) return { ok: false, errors };
  const warnings: string[] = [];
  if (KIND_META[b.kind].engine === 'daemon') warnings.push('This rule type is evaluated only by the live alert daemon (it needs the streaming feed). The 5-minute cron backstop cannot check it.');
  if (b.kind === 'volume_surge') warnings.push('Needs at least 10 completed sessions of daily volume for this symbol; until then the rule stays N/A and will not fire.');
  if (b.kind === 'order_imbalance_above' || b.kind === 'order_imbalance_below') warnings.push('Top-5 depth imbalance is a heuristic of resting orders, which can be cancelled before they trade; thin books (very little quantity) are ignored.');
  return { ok: true, value: { symbol, kind: b.kind, threshold, cooldown_min: cooldown, channels: { push: ch.push !== false, email: ch.email === true } }, warnings };
}

/** how a threshold reads in a table cell */
export function fmtThreshold(kind: RuleKind, threshold: number): string {
  const m = KIND_META[kind];
  return m.unit === '×' ? `${threshold}×` : m.unit === 'ratio' ? (kind === 'order_imbalance_below' ? `−${threshold}` : `+${threshold}`) : m.unit === '%' ? `${threshold}%` : `₹${threshold}`;
}
