/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';
const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };

/**
 * Content-Security-Policy. `script-src 'unsafe-inline'` is required by Next's inline bootstrap scripts (nonce-based CSP needs a custom middleware — roadmap);
 * everything else is an allow-list: the SmartAPI socket, the Supabase project, same-origin APIs. Override extra hosts with CSP_CONNECT_EXTRA (space separated).
 */
export const csp = () => {
  const supa = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  return [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' wss://smartapisocket.angelone.in https://smartapisocket.angelone.in ${origin(supa)} ${supa.startsWith('http://') ? supa.replace(/^http/, 'ws') : ''} ${process.env.CSP_CONNECT_EXTRA || ''}${isDev ? ' ws: http:' : ''}`.replace(/\s+/g, ' ').trim(),
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
};

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp() },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  webpack: (config) => {
    // pdfjs-dist optionally requires the native `canvas` package; the browser build doesn't need it
    config.resolve.alias.canvas = false;
    return config;
  },
};
export default nextConfig;
