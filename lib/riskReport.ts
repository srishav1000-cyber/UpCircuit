// Scheduled risk report: pure computation + rendering (the worker feeds it holdings + quotes). Circuit exposure needs live bands, so it is NOT part of the scheduled report.
import { evaluateLimits, sanitiseLimits, type LimitRow, type Limits } from './analytics/limits';
import { runAllScenarios, type ScenarioResult } from './analytics/hhi';
import { esc } from './email';

export interface ReportHolding { symbol: string; qty: number; sector?: string | null }
export interface RiskReport { asOf: string; total: number; rows: LimitRow[]; breaches: LimitRow[]; scenarios: ScenarioResult[]; missing: string[]; subject: string; html: string; text: string }

export function buildRiskReport(holdings: ReportHolding[], prices: Map<string, number>, limitsRaw: unknown, asOf = new Date()): RiskReport | null {
  const limits: Limits = sanitiseLimits(limitsRaw);
  const missing: string[] = [];
  const positions = holdings.flatMap((h) => {
    const px = prices.get(h.symbol.toUpperCase());
    if (!(px && px > 0)) { missing.push(h.symbol); return []; }
    return [{ symbol: h.symbol, sector: h.sector || 'Others', value: h.qty * px, nearCircuit: false }];
  });
  const rows = evaluateLimits({ positions }, limits)?.filter((r) => r.id !== 'circuit') ?? null;
  if (!rows) return null;
  const total = positions.reduce((a, p) => a + p.value, 0);
  const scenarios = runAllScenarios(positions);
  const breaches = rows.filter((r) => r.status === 'breach');
  const day = asOf.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const val = (r: LimitRow) => (r.unit === '%' ? `${r.actual.toFixed(1)}%` : Math.round(r.actual).toLocaleString('en-IN'));
  const subject = breaches.length ? `UpCircuit risk report · ${breaches.length} limit breach${breaches.length > 1 ? 'es' : ''} · ${day}` : `UpCircuit risk report · all limits OK · ${day}`;
  const text = [`UpCircuit daily risk report — ${day}`, `Portfolio value ${inr(total)} (${positions.length} holdings priced${missing.length ? `; no price for ${missing.join(', ')}` : ''})`, '', 'LIMITS', ...rows.map((r) => `${r.status.toUpperCase().padEnd(6)} ${r.label}: ${val(r)} (limit ${r.limit}${r.unit}) · ${r.detail}`), '', 'STRESS TESTS (illustrative sector betas)', ...scenarios.map((s) => `${s.label}: ${s.deltaPct.toFixed(2)}% (${inr(s.delta)})`), '', 'Delayed quotes; not investment advice.'].join('\n');
  const color = (st: string) => (st === 'breach' ? '#d33' : st === 'near' ? '#c80' : '#2a7');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="margin:0 0 4px">Daily risk report</h2><p style="color:#666;margin:0 0 12px">${esc(day)} · portfolio ${esc(inr(total))}${missing.length ? ` · no price for ${esc(missing.join(', '))}` : ''}</p>
<table style="width:100%;border-collapse:collapse;font-size:13px">${rows.map((r) => `<tr><td style="padding:4px 0;color:${color(r.status)};font-weight:700;width:64px">${r.status.toUpperCase()}</td><td>${esc(r.label)} <span style="color:#888">· ${esc(r.detail)}</span></td><td style="text-align:right">${esc(val(r))} / ${r.limit}${r.unit}</td></tr>`).join('')}</table>
<h3 style="margin:16px 0 4px;font-size:14px">Stress tests</h3><table style="width:100%;border-collapse:collapse;font-size:13px">${scenarios.map((s) => `<tr><td>${esc(s.label)}</td><td style="text-align:right;color:${s.delta < 0 ? '#d33' : '#2a7'}">${s.deltaPct.toFixed(2)}% (${esc(inr(s.delta))})</td></tr>`).join('')}</table>
<p style="color:#888;font-size:11px;margin-top:16px">Delayed quotes · sector betas are illustrative · not investment advice. Turn this report off in Compliance → Risk limits.</p></div>`;
  return { asOf: asOf.toISOString(), total, rows, breaches, scenarios, missing, subject, html, text };
}
