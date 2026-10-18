import type { Config } from 'tailwindcss';

// Colours are CSS variables (see globals.css) so one class set serves both light and dark themes.
const c = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: c('bg'),
        panel: c('panel'),
        line: c('line'),
        ink: c('ink'),
        muted: c('muted'),
        up: c('up'),
        down: c('down'),
        accent: c('accent'),
        warn: c('warn'),
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'scale(0.98)' }, to: { opacity: '1', transform: 'scale(1)' } },
        'pop-in': { from: { opacity: '0', transform: 'scale(0.95) translateY(-4px)' }, to: { opacity: '1', transform: 'scale(1) translateY(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 300ms ease-out backwards',
        'pop-in': 'pop-in 150ms ease-out backwards',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Trebuchet MS"', 'Roboto', 'Ubuntu', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
