// Single source of truth for absolute links (auth redirects, e-mail alert links).
// NEXT_PUBLIC_APP_URL is inlined at build time; the fallback is the production domain.
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://upcircuit.vercel.app').replace(/\/+$/, '');

/** Absolute URL for an app path, e.g. appUrl('/login') → https://upcircuit.vercel.app/login */
export const appUrl = (path = '/') => `${APP_URL}${path.startsWith('/') ? path : `/${path}`}`;

/** Deep link that opens a stock in the terminal: /terminal?symbol=XYZ */
export const terminalUrl = (symbol: string) => appUrl(`/terminal?symbol=${encodeURIComponent(symbol)}`);
