// Saved layouts: a named snapshot of how the workspace is arranged (view · persona lens · density). Stored per user in this browser and, for Supabase accounts, in preferences.layouts.
import { scoped } from './scope';
import type { Persona } from './personas';

export type LayoutView = 'home' | 'terminal' | 'compliance';
export interface Layout { name: string; view: LayoutView; persona: Persona; density: 'comfortable' | 'compact' }
export const MAX_LAYOUTS = 10;
const KEY = 'upcircuit:layouts:v1';
const VIEWS: LayoutView[] = ['home', 'terminal', 'compliance'];
const PERSONAS: Persona[] = ['day', 'retail', 'institutional', 'executive'];

export const cleanName = (s: string) => s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
export function sanitizeLayouts(x: unknown): Layout[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>(); const out: Layout[] = [];
  for (const r of x as Partial<Layout>[]) {
    const name = typeof r?.name === 'string' ? cleanName(r.name) : '';
    if (!name || seen.has(name.toLowerCase()) || !VIEWS.includes(r.view as LayoutView) || !PERSONAS.includes(r.persona as Persona)) continue;
    seen.add(name.toLowerCase());
    out.push({ name, view: r.view as LayoutView, persona: r.persona as Persona, density: r.density === 'compact' ? 'compact' : 'comfortable' });
    if (out.length >= MAX_LAYOUTS) break;
  }
  return out;
}
/** Insert or replace by name (case-insensitive); the newest save goes first; the oldest is dropped past MAX_LAYOUTS. */
export function upsertLayout(list: Layout[], l: Layout): Layout[] {
  const name = cleanName(l.name);
  if (!name) return list;
  return sanitizeLayouts([{ ...l, name }, ...list.filter((x) => x.name.toLowerCase() !== name.toLowerCase())]);
}
export const removeLayout = (list: Layout[], name: string): Layout[] => list.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
export function loadLayoutsLocal(): Layout[] { try { return sanitizeLayouts(JSON.parse(localStorage.getItem(scoped(KEY)) ?? '[]')); } catch { return []; } }
export function saveLayoutsLocal(l: Layout[]): void { try { localStorage.setItem(scoped(KEY), JSON.stringify(l)); } catch { /* ignore */ } }
