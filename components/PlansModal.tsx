'use client';

import { useState } from 'react';
import { PLANS, planFor, type PlanId, type Role } from '@/lib/auth';
import { roleDef } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';

/** Plan comparison + switch. `want` highlights the plan that unlocks the role the user just tried to open. */
export function PlansModal({ want, onClose }: { want?: Role; onClose: () => void }) {
  const { user, update, backend } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suggested = want ? planFor(want).id : undefined;
  const choose = async (id: PlanId) => {
    setBusy(true);
    setErr(null);
    const r = await update({ plan: id, role: want });
    setBusy(false);
    if (r.ok) onClose();
    else setErr(r.error);
  };
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Plans" data-testid="plans-modal" onClick={onClose}>
      <div className="w-full max-w-xl space-y-3 rounded-xl border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-bold text-ink">Plans</h2>
            <p className="text-[12px] text-muted">{want ? `${roleDef(want).label} is not in your plan. ` : ''}Current plan: <b className="text-ink">{PLANS.find((p) => p.id === user?.plan)?.name}</b></p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-ink">✕</button>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {PLANS.map((p) => {
            const cur = user?.plan === p.id;
            return (
              <div key={p.id} className={`flex flex-col rounded-lg border p-3 text-[12px] ${suggested === p.id ? 'border-accent bg-accent/10' : 'border-line'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted">Tier {p.tier}</div>
                <div className="font-bold text-ink">{p.name}</div>
                <div className="num mb-1 text-ink">{p.price}</div>
                <ul className="mb-2 flex-1 space-y-0.5 text-muted">{p.roles.map((r) => <li key={r}>{roleDef(r).icon} {roleDef(r).label}</li>)}</ul>
                <button disabled={cur || busy} onClick={() => choose(p.id)} data-testid={`switch-${p.id}`} className="h-8 rounded-md border border-accent text-[12px] font-semibold text-accent hover:bg-accent/10 disabled:cursor-default disabled:border-line disabled:text-muted disabled:hover:bg-transparent">
                  {cur ? 'Current plan' : 'Switch'}
                </button>
              </div>
            );
          })}
        </div>
        {err && <p role="alert" className="rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{err}</p>}
        <p className="text-[10px] text-muted">{backend === 'local' ? 'Demo: switching is instant and free. ' : ''}With Supabase, plan changes are written by your billing webhook, not the browser.</p>
      </div>
    </div>
  );
}
