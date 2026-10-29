'use client';

import { useEffect, useState } from 'react';
import { useCloud } from './useCloud';
import { createAuditor } from '@/lib/audit';
import { installAuditor } from '@/lib/auditBus';
import { DEFAULT_ROLE, type AppRole } from '@/lib/rbac';

/** The signed-in user's application role (viewer … admin), read from the database (never from the client). null = no Supabase account → governance features are off. */
export function useRole(): { role: AppRole | null; loading: boolean } {
  const { cloud, userId } = useCloud();
  const [role, setRole] = useState<AppRole | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!cloud || !userId) { setRole(null); return; }
    let live = true;
    setLoading(true);
    const pull = () => cloud.loadRole().then((r) => live && setRole(r)).catch(() => live && setRole((x) => x ?? DEFAULT_ROLE)).finally(() => live && setLoading(false));
    void pull();
    const t = setInterval(() => void pull(), 5 * 60_000); // a role change by an admin shows up without a reload
    return () => { live = false; clearInterval(t); };
  }, [cloud, userId]);
  return { role, loading };
}

/** Mount once: installs the audit writer for this session and records one `auth.login` per browser tab session. */
export function useAuditSession(): void {
  const { cloud, userId } = useCloud();
  useEffect(() => {
    if (!cloud || !userId) { installAuditor(null); return; }
    const a = createAuditor(cloud);
    installAuditor(a);
    try {
      const k = `upcircuit:audit-login:${userId}`;
      if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, '1'); a.log({ action: 'auth.login', entity: 'session' }); }
    } catch { /* storage blocked → skip */ }
    return () => installAuditor(null);
  }, [cloud, userId]);
}
