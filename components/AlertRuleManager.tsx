'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AlertDelivery, AlertRuleRow, CloudClient } from '@/lib/cloud';
import { RULE_KINDS, RULE_LABEL, validateRule, type RuleKind } from '@/lib/alertRules';
import { audit } from '@/lib/auditBus';

const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');

export function AlertRuleManager({ cloud, userId }: { cloud: CloudClient; userId: string }) {
  const [rules, setRules] = useState<AlertRuleRow[] | null>(null);
  const [deliveries, setDeliveries] = useState<AlertDelivery[]>([]);
  const [err, setErr] = useState('');
  const [f, setF] = useState({ symbol: '', kind: 'price_above' as RuleKind, threshold: '', cooldown: '60', push: true, email: false });
  const load = useCallback(async () => {
    try { const [r, d] = await Promise.all([cloud.listRules(), cloud.listDeliveries(30)]); setRules(r); setDeliveries(d); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load rules'); }
  }, [cloud]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const draft = { symbol: f.symbol.trim().toUpperCase(), kind: f.kind, threshold: Number(f.threshold), cooldown_min: Number(f.cooldown) };
    const bad = validateRule(draft);
    if (bad) return setErr(bad);
    try {
      await cloud.addRule(userId, { ...draft, channels: { push: f.push, email: f.email } });
      audit({ action: 'alert_rule.create', entity: 'alert_rule', entity_id: draft.symbol, meta: { kind: draft.kind, threshold: draft.threshold } });
      setErr(''); setF({ ...f, symbol: '', threshold: '' }); await load();
    } catch (x) { setErr(x instanceof Error ? x.message.replace(/^cloud \d+: /, '') : 'Could not save the rule'); }
  }
  const input = 'h-9 rounded-md border border-line bg-transparent px-2 text-[13px] text-ink outline-none focus:border-accent';
  return (
    <section data-testid="rules" aria-label="Alert rules">
      <form onSubmit={add} className="mb-3 grid gap-2 rounded-lg border border-line bg-panel p-3 sm:grid-cols-[1fr_1.6fr_1fr_1fr_auto] sm:items-end">
        <label className="text-[11px] text-muted">Symbol<input data-testid="rule-symbol" value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })} placeholder="RELIANCE" className={`${input} mt-1 w-full uppercase`} /></label>
        <label className="text-[11px] text-muted">Condition<select data-testid="rule-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as RuleKind })} className={`${input} mt-1 w-full`}>{RULE_KINDS.map((k) => <option key={k} value={k} className="bg-panel">{RULE_LABEL[k]}</option>)}</select></label>
        <label className="text-[11px] text-muted">Threshold<input data-testid="rule-threshold" inputMode="decimal" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} placeholder="1500" className={`${input} mt-1 w-full`} /></label>
        <label className="text-[11px] text-muted">Cooldown (min)<input data-testid="rule-cooldown" inputMode="numeric" value={f.cooldown} onChange={(e) => setF({ ...f, cooldown: e.target.value })} className={`${input} mt-1 w-full`} /></label>
        <button data-testid="rule-add" className="h-9 rounded-md bg-accent px-4 text-[13px] font-bold text-white hover:brightness-110">Add rule</button>
        <div className="flex gap-4 text-[12px] text-ink sm:col-span-5">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.push} onChange={(e) => setF({ ...f, push: e.target.checked })} /> Web push</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.email} onChange={(e) => setF({ ...f, email: e.target.checked })} /> E-mail</label>
          <span className="text-muted">Rules run on the server every few minutes, even with the app closed. Prices are delayed server-side quotes.</span>
        </div>
      </form>
      {err && <div role="alert" data-testid="rule-error" className="mb-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[640px] text-left text-[12px]">
          <thead className="bg-line/40 text-[11px] uppercase tracking-wide text-muted"><tr>{['Stock', 'Rule', 'Cooldown', 'Channels', 'Last fired', 'On', ''].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {rules !== null && !rules.length && <tr><td colSpan={7} data-testid="rule-empty" className="px-3 py-6 text-center text-muted">No rules yet — add your first one above (up to 50).</td></tr>}
            {(rules ?? []).map((r) => (
              <tr key={r.id} data-testid="rule-row" className="border-t border-line">
                <td className="px-3 py-2 font-bold text-ink">{r.symbol}</td>
                <td className="px-3 py-2">{RULE_LABEL[r.kind]} <span className="num font-semibold">{r.threshold}</span></td>
                <td className="px-3 py-2 text-muted">{r.cooldown_min} min</td>
                <td className="px-3 py-2 text-muted">{[r.channels.push && 'push', r.channels.email && 'e-mail'].filter(Boolean).join(' · ') || 'in-app only'}</td>
                <td className="px-3 py-2 text-muted">{ago(r.last_triggered_at)}</td>
                <td className="px-3 py-2"><input type="checkbox" aria-label={`Enable ${r.symbol} rule`} checked={r.enabled} onChange={async (e) => { const on = e.target.checked; setRules((rs) => rs && rs.map((x) => (x.id === r.id ? { ...x, enabled: on } : x))); await cloud.setRuleEnabled(r.id, e.target.checked).catch((x) => setErr(String(x.message))); audit({ action: 'alert_rule.toggle', entity: 'alert_rule', entity_id: r.symbol, meta: { enabled: e.target.checked } }); void load(); }} /></td>
                <td className="px-3 py-2 text-right"><button data-testid="rule-delete" aria-label={`Delete ${r.symbol} rule`} onClick={async () => { await cloud.deleteRule(r.id).catch((x) => setErr(String(x.message))); audit({ action: 'alert_rule.delete', entity: 'alert_rule', entity_id: r.symbol }); void load(); }} className="text-muted hover:text-down">🗑</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="mb-1 mt-4 text-[12px] font-semibold uppercase tracking-wide text-muted">Recent deliveries</h3>
      <ul data-testid="deliveries" className="divide-y divide-line rounded-lg border border-line text-[12px]">
        {!deliveries.length && <li className="px-3 py-4 text-center text-muted">Nothing has fired yet.</li>}
        {deliveries.map((d) => <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2"><span className="font-bold text-ink">{d.symbol}</span><span className="text-muted">{d.channel}</span><span className={d.status === 'sent' ? 'text-up' : d.status === 'failed' ? 'text-down' : 'text-warn'}>{d.status}</span><span className="min-w-0 flex-1 truncate text-muted" title={d.detail ?? ''}>{d.detail}</span><span className="text-muted">{ago(d.fired_at)}</span></li>)}
      </ul>
    </section>
  );
}
