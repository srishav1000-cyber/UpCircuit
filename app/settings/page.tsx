'use client';

import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { useNotifySync } from '@/hooks/useNotify';
import { useCloud } from '@/hooks/useCloud';
import { SettingsModal, type SettingsTab } from '@/components/SettingsModal';
import { appUrl } from '@/lib/appUrl';
import { TerminalSkeleton } from '@/components/TerminalSkeleton';

export default function SettingsPage() {
  return (
    <AuthProvider>
      <SettingsGate />
    </AuthProvider>
  );
}

function SettingsGate() {
  const { user, ready } = useAuth();
  useEffect(() => {
    if (ready && !user) window.location.assign(appUrl('/login?next=/settings'));
  }, [ready, user]);
  if (!ready || !user) return <TerminalSkeleton message="Loading your settings…" />;
  return <Settings />;
}

function Settings() {
  useNotifySync();
  useCloud();
  const [tab, setTab] = useState<SettingsTab>('profile');
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'profile' || t === 'alerts' || t === 'market' || t === 'cloud') setTab(t);
  }, []);
  return (
    <div className="min-h-screen bg-bg px-4 py-6 text-ink sm:py-10">
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <a href={appUrl('/')} data-testid="settings-back" className="self-start rounded-lg border border-line px-3 py-1.5 text-sm font-semibold hover:bg-line">← Terminal</a>
        <SettingsModal inline initialTab={tab} />
      </main>
    </div>
  );
}
