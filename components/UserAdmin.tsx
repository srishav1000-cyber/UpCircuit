'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminUser, CloudClient } from '@/lib/cloud';
import { APP_ROLES, ROLE_INFO, type AppRole } from '@/lib/rbac';

export function UserAdmin({ cloud, selfId }: { cloud: CloudClient; selfId: string }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => { try { setUsers(await cloud.adminListUsers()); setErr(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load users'); } }, [cloud]);
  useEffect(() => { void load(); }, [load]);
  async function change(u: AdminUser, role: AppRole) {
    try { await cloud.setRole(u.id, role); await load(); } catch (e) { setErr(e instanceof Error ? e.message.replace(/^cloud \d+: /, '') : 'Could not change the role'); }
  }
  return (
    <section data-testid="users" aria-label="User roles">
      {err && <div role="alert" data-testid="users-error" className="mb-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      <p className="mb-2 text-[11px] text-muted">Role changes take effect within five minutes in the user’s open session and are written to the audit trail. The last remaining admin cannot be demoted.</p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[560px] text-left text-[12px]">
          <thead className="bg-line/40 text-[11px] uppercase tracking-wide text-muted"><tr>{['User', 'E-mail', 'Role'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id} data-testid="user-row" className="border-t border-line">
                <td className="px-3 py-2 font-semibold text-ink">{u.full_name || '—'}{u.id === selfId && <span className="ml-1 text-[10px] text-muted">(you)</span>}</td>
                <td className="px-3 py-2 text-muted">{u.email}</td>
                <td className="px-3 py-2"><select aria-label={`Role for ${u.email}`} data-testid="user-role" value={u.role} onChange={(e) => void change(u, e.target.value as AppRole)} className="h-8 rounded-md border border-line bg-transparent px-2 text-[12px] text-ink" title={ROLE_INFO[u.role]?.blurb}>{APP_ROLES.map((r) => <option key={r} value={r} className="bg-panel">{ROLE_INFO[r].label}</option>)}</select></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
