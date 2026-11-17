import type { MetadataRoute } from 'next';

/** Web app manifest (served at /manifest.webmanifest; public/manifest.json is the identical static copy). Installs UpCircuit as a standalone PWA on Android Chrome and iPhone (Share → Add to Home Screen) — no app store. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'UpCircuit Financial Terminal',
    short_name: 'UpCircuit',
    description: 'Real-time decision-support analytics and circuit alerts for Indian equities.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#020617',
    theme_color: '#3b82f6',
    categories: ['finance', 'business'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Open terminal', url: '/terminal', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'Settings', url: '/settings', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
