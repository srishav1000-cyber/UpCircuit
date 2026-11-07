// Pure rule engine for the alert daemon: in-memory index + edge-crossing evaluation. No I/O — unit-tested in scripts/verify.ts.
//
// Semantics: a rule fires on the tick where its condition goes from FALSE to TRUE (a crossing), not while it merely stays true.
//  • the first observation of a rule only seeds its state (a rule created while the price is already beyond the threshold does not fire);
//  • a crossing inside the rule's cooldown is swallowed (state still updates, so it will not fire later without a fresh crossing);
//  • a tick that cannot evaluate a percentage rule (no previous close) is ignored — it never flips state, so a missing field cannot fake a crossing.
import { RULE_KINDS, evaluateRule, type AlertRule, type RuleKind } from '../lib/alertRules';

export interface TickIn { symbol: string; ltp: number; prevClose?: number; /** exchange timestamp, epoch ms */ ts: number }
export interface RuleMatch { rule: AlertRule; price: number; pct: number; message: string; tickTime: number; matchedAt: number }

interface State { sig: string; prev: boolean | null; firedAt: number }
const NEEDS_PREV_CLOSE: ReadonlySet<RuleKind> = new Set<RuleKind>(['pct_up', 'pct_down', 'circuit_proximity']);

/** Coerces a DB / Realtime row into an AlertRule (symbol upper-cased); null when it is not a usable rule. */
export function toRule(row: unknown): AlertRule | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const threshold = Number(r.threshold), cooldown = Number(r.cooldown_min);
  if (typeof r.id !== 'string' || typeof r.user_id !== 'string' || typeof r.symbol !== 'string' || !(RULE_KINDS as readonly string[]).includes(r.kind as string)) return null;
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
    const list = this.bySymbol.get(t.symbol.toUpperCase());
    if (!list || !(t.ltp > 0)) return [];
    const quote = { symbol: t.symbol, ltp: t.ltp, prevClose: t.prevClose && t.prevClose > 0 ? t.prevClose : 0 };
    let out: RuleMatch[] | undefined;
    for (const rule of list) {
      const st = this.states.get(rule.id);
      if (!st) continue;
      if (NEEDS_PREV_CLOSE.has(rule.kind) && !(quote.prevClose > 0)) continue;
      const hit = evaluateRule(rule, quote, now);
      const cond = hit !== null;
      const was = st.prev;
      st.prev = cond;
      if (!cond || was !== false) continue;                                  // not a rising edge
      if (now - st.firedAt < rule.cooldown_min * 60_000) continue;           // crossing swallowed by the cooldown
      st.firedAt = now;
      (out ??= []).push({ rule, price: hit.price, pct: hit.pct, message: hit.message, tickTime: t.ts, matchedAt: now });
    }
    return out ?? [];
  }
}
