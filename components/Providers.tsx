'use client';

import { ThemeProvider } from 'next-themes';
import { PWAProvider } from './PWAProvider';
import { ConsentBanner } from './ConsentBanner';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem storageKey="upcircuit:theme" disableTransitionOnChange>
      <PWAProvider>{children}<ConsentBanner /></PWAProvider>
    </ThemeProvider>
  );
}
