'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
interface PWA {
  /** the browser offered "install to home screen" and it has not been used yet */
  canInstall: boolean;
  /** already running as an installed app */
  installed: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}
const Ctx = createContext<PWA>({ canInstall: false, installed: false, install: async () => 'unavailable' });
export const usePWA = () => useContext(Ctx);

/** Registers /sw.js (push handler) and captures the browser's install prompt so Settings can offer "Install app". */
export function PWAProvider({ children }: { children: ReactNode }) {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      const reg = () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      if (document.readyState === 'complete') reg();
      else window.addEventListener('load', reg, { once: true });
    }
    setInstalled(window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
    const before = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const done = () => {
      setInstalled(true);
      setEvt(null);
    };
    window.addEventListener('beforeinstallprompt', before);
    window.addEventListener('appinstalled', done);
    return () => {
      window.removeEventListener('beforeinstallprompt', before);
      window.removeEventListener('appinstalled', done);
    };
  }, []);

  const install = useCallback(async () => {
    if (!evt) return 'unavailable' as const;
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    setEvt(null);
    return outcome;
  }, [evt]);

  const value = useMemo(() => ({ canInstall: !!evt && !installed, installed, install }), [evt, installed, install]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
