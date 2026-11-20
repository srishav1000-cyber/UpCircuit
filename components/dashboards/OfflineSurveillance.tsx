'use client';
// Surveillance lab for sessions without a Supabase account (demo / local accounts, or before sign-in): everything that needs no database —
// the replay sandbox, the replay digest, the ablation matrix and the threshold explorer — so a reviewer can verify the capstone at any hour.
import { useEffect, useState } from 'react';
import { isMarketOpen } from '@/lib/market';
import { RuleSandbox } from './RuleSandbox';
import { EodDigestCard } from './EodDigestCard';
import { SignalAttributionCard } from './SignalAttributionCard';
import { ThresholdExplorer, type ExplorerData } from './ThresholdExplorer';
import { DefenseGuideDrawer } from '../DefenseGuideDrawer';
import type { AblationRowIn } from '@/lib/signalAttribution';

type Bt = ExplorerData & { data?: { snapshots?: number }; ablation?: AblationRowIn[] };

export function OfflineSurveillance({ className = '' }: { className?: string }) {
  const [bt, setBt] = useState<Bt | null | 'none'>(null);
  useEffect(() => {
    let on = true;
    fetch('/backtest-heuristics.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((j) => on && setBt(j)).catch(() => on && setBt('none'));
    return () => { on = false; };
  }, []);
  const data = bt && bt !== 'none' && bt.data ? bt : null;
  return (
    <div className={`space-y-3 ${className}`} data-testid="offline-surveillance">
      <p className="text-[12px] text-muted">Works without an account or a live feed: the replay sandbox, replay digest and backtest views below use only built-in synthetic data. Live feed health, alert rules, the audit pack and the shared register need a Supabase account.</p>
      <DefenseGuideDrawer />
      <RuleSandbox />
      <EodDigestCard input={null} marketOpen={isMarketOpen(Date.now())} />
      {data && <SignalAttributionCard data={data} />}
      {data && <ThresholdExplorer data={data} />}
    </div>
  );
}
