import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';

export const metadata: Metadata = {
  title: 'UpCircuit — Trading Terminal',
  description: 'Discovery, stock research and role-based analytics for NSE equities.',
};
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0B0E14' },
    { media: '(prefers-color-scheme: light)', color: '#F1F3F8' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes sets the theme class on <html> before hydration
    <html lang="en" suppressHydrationWarning>
      <body className="bg-bg font-sans text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
