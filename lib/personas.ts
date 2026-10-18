export type Persona = 'day' | 'retail' | 'institutional' | 'executive';

export interface PersonaDef {
  id: Persona;
  icon: string;
  label: string;
  /** compact name for the "👁️ Lens: …" trigger */
  short: string;
  /** one-line description (menu card + dashboard header) */
  blurb: string;
  /** category badge on the menu card */
  badge: string;
  /** segmented-control label + icon (Navbar) */
  seg: { icon: string; label: string };
}

export const PERSONAS: PersonaDef[] = [
  { id: 'day', icon: '⚡', label: 'Day Trader', short: 'Day Trader', blurb: 'Short-term momentum, depth charts, level 2 order flow & hotkeys.', badge: 'Intraday', seg: { icon: '⚡', label: 'Intraday' } },
  { id: 'retail', icon: '📈', label: 'Retail Investor', short: 'Retail Investor', blurb: 'Portfolio P&L tracking, dividend yields, diversification & simple ratios.', badge: 'Wealth', seg: { icon: '📊', label: 'Retail' } },
  { id: 'institutional', icon: '🏛️', label: 'Institutional Investor', short: 'Institutional', blurb: 'Concentration risk, HHI diagnostics, sector allocation & deep analytics.', badge: 'Institutional', seg: { icon: '🏛️', label: 'Institutional' } },
  { id: 'executive', icon: '🏢', label: 'Executive / Risk Manager', short: 'Executive & Risk', blurb: 'Macro market sentiment, circuit alerts, governance & executive overview.', badge: 'Macro & Risk', seg: { icon: '🛡️', label: 'Executive' } },
];

/** display order of the segmented control */
export const PERSONA_SEGMENTS: Persona[] = ['retail', 'day', 'institutional', 'executive'];

export const personaOf = (id: Persona) => PERSONAS.find((p) => p.id === id)!;
