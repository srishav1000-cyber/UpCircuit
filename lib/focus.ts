// "Focus basket": the handful of tickers (≤ 6) a Day Trader / Retail Investor personalises the dashboard around.
export const MAX_FOCUS = 6;
export const FOCUS_KEY = 'upcircuit:focus:v1';
/** set once defaults have been applied, so a user who later empties the basket on purpose is not re-seeded */
export const FOCUS_SEEDED_KEY = 'upcircuit:focus:seeded:v1';
/** 'pending' until the first-time welcome banner is dismissed, then 'done' */
export const WELCOME_KEY = 'upcircuit:focus:welcome:v1';
/** Smart default for new users: six highly liquid NIFTY 50 blue-chips. */
export const DEFAULT_FOCUS: readonly string[] = ['RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'ICICIBANK', 'SBIN'];
export const WELCOME_TEXT = "👋 Welcome to UpCircuit Terminal! We've pre-loaded 6 blue-chip NIFTY stocks in your Focus Basket. Click 'Edit' anytime to customize your watchlist.";

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

/**
 * First-run decision. No saved focus stocks AND defaults never applied → seed the six blue-chips (and the caller shows the welcome
 * banner). Anyone with saved stocks is left alone; so is a user who emptied the basket after seeding.
 */
export function initFocus(raw: string | null, alreadySeeded: boolean): { list: string[]; seeded: boolean } {
  const saved = parseFocus(raw);
  if (saved.length === 0 && !alreadySeeded) return { list: [...DEFAULT_FOCUS], seeded: true };
  return { list: saved, seeded: false };
}
