'use client';

import { useState } from 'react';
import type { CloudClient } from '@/lib/cloud';
import { ROLE_INFO, can, opsTabs, type AppRole, type OpsTab } from '@/lib/rbac';
import { SurveillanceRegister } from './SurveillanceRegister';
import { AlertRuleManager } from './AlertRuleManager';
import { AuditTrail } from './AuditTrail';
import { UserAdmin } from './UserAdmin';
import { AiSignoffs } from './AiSignoffs';
import { PredictionBacktest } from './PredictionBacktest';

const LABEL: Record<OpsTab, string> = { register: '🛡 Surveillance register', rules: '⏰ Alert rules', audit: '🔗 Audit trail', ai: '🤖 AI sign-offs', backtest: '📈 Prediction back-test', users: '👥 Users & roles' };

export function ComplianceWorkspace({ cloud, userId, role, onOpenStock, backtestSymbols = [] }: { cloud: CloudClient | null; userId: string | null; role: AppRole | null; onOpenStock: (s: string) => void; backtestSymbols?: string[] }) {
  const tabs = opsTabs(role);
  const [tab, setTab] = useState<OpsTab>(tabs[0] ?? 'rules');
  const active = tabs.includes(tab) ? tab : tabs[0];
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 p-3 sm:p-6" data-testid="compliance">
      <header className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-lg font-bold text-ink">Compliance &amp; Surveillance</h1>
          <p className="text-[12px] text-muted">Circuit-event register, server-side alert rules and the audit trail.</p>
        </div>
        {role && <span data-testid="role-badge" title={ROLE_INFO[role].blurb} className="ml-auto rounded-full border border-accent/50 bg-accent/10 px-3 py-1 text-[11px] font-bold text-accent">Role: {ROLE_INFO[role].label}</span>}
      </header>
      {!cloud || !userId || !role ? (
        <div data-testid="compliance-unavailable" className="rounded-lg border border-line bg-panel p-6 text-center text-[13px] text-muted">The governance workspace needs a Supabase account (roles, the shared register and the audit log live in the database). Demo / local accounts run without it.</div>
      ) : (
        <>
          <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist" aria-label="Compliance sections">
            {tabs.map((t) => <button key={t} role="tab" aria-selected={active === t} data-testid={`tab-${t}`} onClick={() => setTab(t)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-semibold ${active === t ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink'}`}>{LABEL[t]}</button>)}
          </nav>
          {active === 'register' && <SurveillanceRegister cloud={cloud} role={role} onOpenStock={onOpenStock} />}
          {active === 'rules' && <AlertRuleManager cloud={cloud} userId={userId} />}
          {active === 'audit' && <AuditTrail cloud={cloud} canVerify={can(role, 'audit.verify')} canExport={can(role, 'audit.export')} />}
          {active === 'backtest' && <PredictionBacktest defaultSymbols={backtestSymbols} />}
          {active === 'ai' && <AiSignoffs cloud={cloud} />}
          {active === 'users' && <UserAdmin cloud={cloud} selfId={userId} />}
          {!can(role, 'register.view') && <p className="mt-4 text-[11px] text-muted">Your role (Viewer) does not include the surveillance register. Ask an admin for the Analyst role.</p>}
        </>
      )}
    </main>
  );
}
