// "Focus basket": the handful of tickers (≤ 6) a Day Trader / Retail Investor personalises the dashboard around.
export const MAX_FOCUS = 6;
export const FOCUS_KEY = 'upcircuit:focus:v1';

export function parseFocus(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? 'null');
    return Array.isArray(v) ? normalizeFocus(v.filter((x): x is string => typeof x === 'string')) : [];
  } catch {
    return [];
  }
}
/** upper-case, trim, de-duplicate, cap at MAX_FOCUS (first wins) */
export function normalizeFocus(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_FOCUS);
}
export type FocusResult = { ok: true; list: string[] } | { ok: false; error: string };
export function toggleFocus(list: string[], sym: string): FocusResult {
  const s = sym.trim().toUpperCase();
  if (!s) return { ok: false, error: 'Pick a symbol.' };
  if (list.includes(s)) return { ok: true, list: list.filter((x) => x !== s) };
  if (list.length >= MAX_FOCUS) return { ok: false, error: `Focus basket is full (${MAX_FOCUS}) — remove one first.` };
  return { ok: true, list: [...list, s] };
}
/** drop symbols that no longer exist in the universe */
export const pruneFocus = (list: string[], known: ReadonlySet<string>) => list.filter((s) => known.has(s));
