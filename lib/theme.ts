/** CSS-variable colour tokens (see app/globals.css) for inline styles and SVG, which Tailwind classes can't reach. */
export const C = {
  up: 'rgb(var(--c-up))',
  down: 'rgb(var(--c-down))',
  muted: 'rgb(var(--c-muted))',
  accent: 'rgb(var(--c-accent))',
  warn: 'rgb(var(--c-warn))',
  ink: 'rgb(var(--c-ink))',
  line: 'rgb(var(--c-line))',
};
export const alpha = (name: 'up' | 'down' | 'muted' | 'accent' | 'warn' | 'ink', a: number) => `rgb(var(--c-${name}) / ${a})`;

/** lightweight-charts takes concrete colours, so the chart mirrors the CSS palette per theme. */
export const CHART_THEME = {
  dark: { bg: '#0B0E14', grid: '#1E222D', text: '#787B86', up: '#26A69A', down: '#EF5350', crosshair: '#5D6272' },
  light: { bg: '#FFFFFF', grid: '#E9ECF3', text: '#6A6D78', up: '#089981', down: '#F23645', crosshair: '#9AA0AE' },
} as const;
export type ThemeName = keyof typeof CHART_THEME;
