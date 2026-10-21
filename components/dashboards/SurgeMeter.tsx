'use client';

import { Card } from '../ui';
import { bucketTrades, surgeLevel, surgeZ, SURGE_LABEL } from '@/lib/analytics/velocity';
import type { MarketEngine } from '@/lib/market';

const lvlTone = (z: number) => (z >= 2 ? 'text-down' : z >= 1 ? 'text-warn' : z <= -1 ? 'text-muted' : 'text-ink');

function Row({ label, z, recent, base, unit, testid }: { label: string; z: { z: number; recent: number; baseline: number } | null; recent?: string; base?: string; unit: string; testid: string }) {
  const pos = z ? Math.max(0, Math.min(100, ((Math.max(-4, Math.min(4, z.z)) + 4) / 8) * 100)) : 50;
  return (
    <div data-testid={testid} data-z={z ? z.z.toFixed(2) : 'na'}>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</span>
        {z ? <span className={`num text-[12px] font-semibold ${lvlTone(z.z)}`}>z = {z.z >= 0 ? '+' : '−'}{Math.abs(z.z).toFixed(2)} · {SURGE_LABEL[surgeLevel(z.z)]}</span> : <span className="text-[11px] text-muted">warming up / N/A</span>}
      </div>
      <div className="relative mt-1.5 h-2 rounded-full bg-gradient-to-r from-line via-muted/30 to-down/60" role="meter" aria-valuemin={-4} aria-valuemax={4} aria-valuenow={z ? Number(z.z.toFixed(2)) : undefined} aria-label={label}>
        <span className="absolute left-1/2 top-0 h-full w-px bg-muted/50" />
        {z && <span className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-ink ring-2 ring-panel" style={{ left: `${pos}%` }} />}
      </div>
      <div className="num mt-1 flex justify-between text-[9px] text-muted"><span>−4σ</span><span>0</span><span>+4σ</span></div>
      {z && <p className="num mt-0.5 text-[10px] text-muted">{recent ?? z.recent.toFixed(1)} now vs {base ?? z.baseline.toFixed(1)} typical ({unit})</p>}
    </div>
  );
}

/** Tick velocity and volume surge z-scores vs the symbol's own recent baseline (10 s buckets live; 1-minute bars otherwise). */
export function SurgeMeter({ engine, mode, className = '' }: { engine: MarketEngine; mode: 'live' | 'delayed' | string; className?: string }) {
  const live = mode === 'live';
  const bucketMs = live ? 10_000 : 60_000;
  const n = live ? 36 : 40;
  const trades = engine.recentTrades(bucketMs * n);
  const end = live ? Date.now() : trades[trades.length - 1]?.t ?? Date.now();
  const b = bucketTrades(trades, end, bucketMs, n);
  const recent = live ? 3 : 2;
  const vz = surgeZ(b.volumes, recent);
  const tz = live ? surgeZ(b.counts, recent) : null;
  return (
    <Card title="Tick velocity & volume surge" badges={[live ? 'smartapi' : 'yahoo', 'computed']} className={className} right={<span className="text-[10px] text-muted">{live ? 'last 30 s vs prior 5 min · 10 s buckets' : 'last 2 bars vs session · 1-min bars'}</span>}>
      <div className="space-y-4" data-testid="surge-meter">
        {live ? (
          <Row label="Tick velocity (trades per 10 s)" z={tz} unit="trades / 10 s" testid="surge-ticks" />
        ) : (
          <p className="text-[11px] text-muted" data-testid="surge-ticks-na">Tick velocity <b>N/A</b> — trade-by-trade ticks come only from the live SmartAPI stream.</p>
        )}
        <Row label={live ? 'Volume surge (shares per 10 s)' : 'Volume surge (shares per 1-min bar)'} z={vz} unit={live ? 'shares / 10 s' : 'shares / min'} testid="surge-volume" recent={vz ? Math.round(vz.recent).toLocaleString('en-IN') : undefined} base={vz ? Math.round(vz.baseline).toLocaleString('en-IN') : undefined} />
        <p className="text-[10px] text-muted">z = (recent mean − baseline mean) ÷ baseline σ. Needs ≥ 8 baseline buckets with some spread; |z| ≥ 2 is unusual, ≥ 3 extreme. Describes pace, not direction.</p>
      </div>
    </Card>
  );
}
