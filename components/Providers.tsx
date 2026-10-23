'use client';

import { ThemeProvider } from 'next-themes';
import { PWAProvider } from './PWAProvider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem storageKey="upcircuit:theme" disableTransitionOnChange>
      <PWAProvider>{children}</PWAProvider>
    </ThemeProvider>
  );
}
