// Pure rule engine for the alert daemon: in-memory index + edge-crossing evaluation. No I/O — unit-tested in scripts/verify.ts.
// Rule kinds: price_above / price_below / pct_up / pct_down / circuit_proximity, plus (Turn 43)
//   volume_surge            today's cumulative volume ≥ threshold × the stock's typical full-day volume (baseline lookup; N/A while the baseline is missing or short)
//   order_imbalance_above   top-5 depth (Σbid − Σask) ÷ (Σbid + Σask) ≥ +threshold   (a heuristic of resting orders)
//   order_imbalance_below   the same ratio ≤ −threshold
// Turn 44: every depth snapshot of a watched symbol also feeds a DepthFlagTracker (lib/heuristicFlags.ts) — large resting-order walls and rapid
// add/cancel patterns are reported through the flag sink as "Heuristic Flag / Possible Manipulation Pattern" (never proof, never an alert rule).
//
// Semantics: a rule fires on the tick where its condition goes from FALSE to TRUE (a crossing), not while it merely stays true.
//  • the first observation of a rule only seeds its state (a rule created while the price is already beyond the threshold does not fire);
//  • a crossing inside the rule's cooldown is swallowed (state still updates, so it will not fire later without a fresh crossing);
//  • a tick that cannot evaluate a percentage rule (no previous close) is ignored — it never flips state, so a missing field cannot fake a crossing.
import { canEvaluate, evaluateRule, isRuleKind, type AlertRule, type RuleKind, type RuleQuote } from '../lib/alertRules';
import { topFiveImbalance } from '../lib/depthImbalance';
import { DepthFlagTracker, type DepthFlag } from '../lib/heuristicFlags';
import type { DepthLevel } from '../lib/types';

export interface TickIn {
  symbol: string; ltp: number; prevClose?: number; /** exchange timestamp, epoch ms */ ts: number;
  /** cumulative traded volume today */
  volume?: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
}
/** typical full-day volume for a symbol, or null when N/A (see daemon/baselines.ts) */
export type BaselineLookup = (symbol: string) => number | null;
export interface RuleMatch { rule: AlertRule; price: number; pct: number; message: string; tickTime: number; matchedAt: number }

interface State { sig: string; prev: boolean | null; firedAt: number }

/** Coerces a DB / Realtime row into an AlertRule (symbol upper-cased); null when it is not a usable rule. */
export function toRule(row: unknown): AlertRule | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const threshold = Number(r.threshold), cooldown = Number(r.cooldown_min);
  if (typeof r.id !== 'string' || typeof r.user_id !== 'string' || typeof r.symbol !== 'string' || !isRuleKind(r.kind)) return null;
  if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(cooldown) || cooldown < 0) return null;
  const ch = r.channels && typeof r.channels === 'object' ? (r.channels as { push?: unknown; email?: unknown }) : {};
  return {
    id: r.id, user_id: r.user_id, symbol: r.symbol.trim().toUpperCase(), kind: r.kind as RuleKind, threshold, cooldown_min: cooldown,
    channels: { push: ch.push === true, email: ch.email === true }, enabled: r.enabled !== false,
    last_triggered_at: typeof r.last_triggered_at === 'string' ? r.last_triggered_at : null,
  };
}

export class RuleIndex {
  /** symbol → rules watching it (the hot-path lookup) */
  readonly bySymbol = new Map<string, AlertRule[]>();
  private readonly rules = new Map<string, AlertRule>();
  private readonly states = new Map<string, State>();
  private baseline: BaselineLookup = () => null;
  private readonly flags = new DepthFlagTracker();
  private flagSink: ((f: DepthFlag) => void) | null = null;
  private flagsSeen = 0;
  private lastPrune = 0;

  /** receives every NEW heuristic depth flag (daemon/index.ts persists them to depth_flags); null disables flag detection */
  setFlagSink(f: ((flag: DepthFlag) => void) | null): void { this.flagSink = f; }
  flagStats(): { symbols: number; emitted: number } { return { symbols: this.flags.size, emitted: this.flagsSeen }; }

  /** where volume_surge rules get their baseline from (until set, every volume rule is N/A) */
  setBaselineLookup(f: BaselineLookup): void { this.baseline = f; }
  /** symbols that have at least one enabled rule of this kind */
  symbolsWithKind(kind: RuleKind): string[] { return [...this.bySymbol.entries()].filter(([, l]) => l.some((r) => r.kind === kind)).map(([s]) => s); }
  /** volume_surge rules whose symbol currently has no usable baseline (they stay silent — shown as N/A) */
  volumeRulesNA(): number { let n = 0; for (const l of this.bySymbol.values()) for (const r of l) if (r.kind === 'volume_surge' && this.baseline(r.symbol) === null) n++; return n; }

  get size(): number { return this.rules.size; }
  symbols(): string[] { return [...this.bySymbol.keys()]; }
  has(id: string): boolean { return this.rules.has(id); }

  /** Insert or update. Disabled rules are removed. State survives an edit that does not change symbol / kind / threshold (e.g. our own last_triggered_at update echoing back). */
  upsert(raw: AlertRule): void {
    if (!raw.enabled) return this.remove(raw.id);
    const old = this.rules.get(raw.id);
    const sig = `${raw.symbol.trim().toUpperCase()}|${raw.kind}|${raw.threshold}`;
    const prior = this.states.get(raw.id);
    const lt = raw.last_triggered_at ? Date.parse(raw.last_triggered_at) : NaN;
    const firedAt = Math.max(prior?.firedAt ?? -Infinity, Number.isFinite(lt) ? lt : -Infinity);   // -Infinity = never fired
    // the stored copy never carries last_triggered_at: cooldown is the engine's job (firedAt), so evaluateRule() is a pure condition check
    const rule: AlertRule = { ...raw, symbol: raw.symbol.trim().toUpperCase(), last_triggered_at: null };
    if (old && old.symbol !== rule.symbol) this.detach(old);
    if (!old || old.symbol !== rule.symbol) this.bySymbol.set(rule.symbol, [...(this.bySymbol.get(rule.symbol) ?? []), rule]);
    else this.bySymbol.set(rule.symbol, (this.bySymbol.get(rule.symbol) ?? []).map((x) => (x.id === rule.id ? rule : x)));
    this.rules.set(rule.id, rule);
    this.states.set(rule.id, { sig, prev: prior && prior.sig === sig ? prior.prev : null, firedAt });
  }

  remove(id: string): void {
    const old = this.rules.get(id);
    if (!old) return;
    this.detach(old);
    this.rules.delete(id);
    this.states.delete(id);
  }

  private detach(r: AlertRule): void {
    const left = (this.bySymbol.get(r.symbol) ?? []).filter((x) => x.id !== r.id);
    if (left.length) this.bySymbol.set(r.symbol, left);
    else this.bySymbol.delete(r.symbol);
  }

  /** Full resync: upsert everything given, drop everything not given. Returns { added, removed }. */
  replaceAll(rules: AlertRule[]): { added: number; removed: number } {
    const keep = new Set(rules.map((r) => r.id));
    let added = 0, removed = 0;
    for (const id of [...this.rules.keys()]) if (!keep.has(id)) { this.remove(id); removed++; }
    for (const r of rules) { if (r.enabled && !this.rules.has(r.id)) added++; this.upsert(r); }
    return { added, removed };
  }

  /** Evaluate one tick against the rules for its symbol. O(rules on that symbol). */
  onTick(t: TickIn, now = Date.now()): RuleMatch[] {
    const sym = t.symbol.toUpperCase();
    const list = this.bySymbol.get(sym);
    if (!list || !(t.ltp > 0)) return [];
    if (this.flagSink && t.depth && (t.depth.bids.length || t.depth.asks.length)) {
      try { for (const f of this.flags.observe(sym, t.depth, t.ltp, t.ts > 0 ? t.ts : now)) { this.flagsSeen++; this.flagSink(f); } }
      catch { /* a flag problem must never stop rule evaluation */ }
      if (now - this.lastPrune > 60_000) { this.lastPrune = now; this.flags.prune(now); }
    }
    const quote: RuleQuote = { symbol: t.symbol, ltp: t.ltp, prevClose: t.prevClose && t.prevClose > 0 ? t.prevClose : 0, volume: t.volume };
    // derived inputs are computed once per tick, and only if some rule on the symbol needs them
    let derived = false;
    let out: RuleMatch[] | undefined;
    for (const rule of list) {
      const st = this.states.get(rule.id);
      if (!st) continue;
      if (!derived && (rule.kind === 'volume_surge' || rule.kind === 'order_imbalance_above' || rule.kind === 'order_imbalance_below')) {
        quote.baselineVolume = this.baseline(sym);
        quote.imbalance = t.depth ? (topFiveImbalance(t.depth.bids, t.depth.asks)?.value ?? null) : null;
        derived = true;
      }
      if (!canEvaluate(rule.kind, quote)) continue;                         // N/A input: never flips state
      const was = st.prev;
      const hit = evaluateRule(rule, quote, now, was === true);
      const cond = hit !== null;
      st.prev = cond;
      if (!cond || was !== false) continue;                                  // not a rising edge
      if (now - st.firedAt < rule.cooldown_min * 60_000) continue;           // crossing swallowed by the cooldown
      st.firedAt = now;
      (out ??= []).push({ rule, price: hit.price, pct: hit.pct, message: hit.message, tickTime: t.ts, matchedAt: now });
    }
    return out ?? [];
  }
}
