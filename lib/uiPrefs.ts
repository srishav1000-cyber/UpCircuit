// Workspace UI preferences that follow the account across devices: chart timeframe + indicator toggles.
// (Watchlists, MY FOCUS, holdings, notification/audio toggles and the persona/role already sync through their own tables.)
import type { Timeframe } from './types';

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '1D', '1W', '1M', '1Y', '5Y', '10Y'];
export const INDICATOR_IDS = ['ema20', 'ema50', 'vwap', 'rsi'] as const;
export type IndicatorKey = (typeof INDICATOR_IDS)[number];
export type IndicatorState = Record<IndicatorKey, boolean>;
export interface UiPrefs { tf: Timeframe; ind: IndicatorState; /** epoch ms of the last user change; 0 = untouched defaults (never uploaded) */ updatedAt: number }

export const DEFAULT_IND: IndicatorState = { ema20: false, ema50: false, vwap: false, rsi: false };
export const DEFAULT_UI: UiPrefs = { tf: '1D', ind: DEFAULT_IND, updatedAt: 0 };
export const UI_KEY = 'upcircuit.ui';

/** coerce anything (a stored string, a jsonb value, a legacy blob) into a valid UiPrefs; null when it carries no usable field */
export function sanitizeUi(raw: unknown): UiPrefs | null {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const tf = TIMEFRAMES.includes(o.tf as Timeframe) ? (o.tf as Timeframe) : null;
  const indRaw = o.ind && typeof o.ind === 'object' ? (o.ind as Record<string, unknown>) : null;
  if (!tf && !indRaw) return null;
  const ind = { ...DEFAULT_IND };
  for (const k of INDICATOR_IDS) ind[k] = indRaw?.[k] === true;
  const at = typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) && o.updatedAt > 0 ? Math.floor(o.updatedAt) : 0;
  return { tf: tf ?? DEFAULT_UI.tf, ind, updatedAt: at };
}
/** the newer of two copies wins; untouched defaults (updatedAt 0) never beat a real choice; ties go to the cloud copy */
export function pickNewer(local: UiPrefs | null, cloud: UiPrefs | null): { value: UiPrefs; source: 'local' | 'cloud' | 'default'; pushLocal: boolean } {
  if (cloud && (!local || cloud.updatedAt >= local.updatedAt)) return { value: cloud, source: 'cloud', pushLocal: false };
  if (local && local.updatedAt > 0) return { value: local, source: 'local', pushLocal: true };   // newer than (or absent from) the cloud → upload
  return { value: local ?? DEFAULT_UI, source: local ? 'local' : 'default', pushLocal: false };
}
