// Plan table (pure, client-safe). Enforcement is server-side: lib/entitlements.ts (AI quota) and the database (alert-rule cap, docs/ENTERPRISE_SCHEMA_P1.sql).
export type PlanId = 'day' | 'retail' | 'full';
export interface Entitlements { aiPerHour: number; alertRules: number; riskReport: boolean }
export const ENTITLEMENTS: Record<PlanId, Entitlements> = {
  day: { aiPerHour: 20, alertRules: 5, riskReport: false },
  retail: { aiPerHour: 40, alertRules: 15, riskReport: false },
  full: { aiPerHour: 120, alertRules: 50, riskReport: true },
};
export const ANON_AI_PER_HOUR = 6;
export const coercePlan = (x: unknown): PlanId => (x === 'day' || x === 'retail' || x === 'full' ? x : 'retail');
