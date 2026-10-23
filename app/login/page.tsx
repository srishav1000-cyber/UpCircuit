'use client';

import { useEffect } from 'react';
import { AuthScreen } from '@/components/AuthScreen';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { appUrl } from '@/lib/appUrl';
import { safeNext } from '@/lib/oauthCallback';

/** Glassmorphic login / sign-up (email + password, plan cards, role radios). Redirects resolve through NEXT_PUBLIC_APP_URL. */
export default function LoginPage() {
  return (
    <AuthProvider>
      <LoginInner />
    </AuthProvider>
  );
}

function LoginInner() {
  const { user } = useAuth();
  useEffect(() => {
    if (user) window.location.assign(appUrl(safeNext(new URLSearchParams(window.location.search).get('next'))));
  }, [user]);
  return <AuthScreen />;
}
