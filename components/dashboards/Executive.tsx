'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Card, Meter, Stat, ZONE, sentimentTone } from '../ui';
import { AreaChart, CARD_GRID, WIDE } from './charts';
import { fmtCr, fmtPct, tone } from '@/lib/format';
import { annualVolPct, breadth, hhi, riskScore, trendGrowthYoY, weightedRiskScore } from '@/lib/analytics';
import type { SentimentLabel } from '@/lib/types';
import { CircuitTracker } from '../CircuitTracker';
import { RiskPanel } from './RiskPanel';
import { PortfolioRiskEngine } from '../PortfolioRiskEngine';
import { VarCard } from './VarCard';
import { DrawdownCard } from './DrawdownCard';
import { LimitMonitor } from './LimitMonitor';
import { CircuitPredictor } from '../CircuitPredictor';
import type { DashboardProps } from './types';

interface Sentiment {
  score: number;
  label: SentimentLabel;
  source: 'gemini' | 'local';
  sample: boolean;
  headlines: number;
  fallbackReason?: string;
  /** client time of the last successful refresh */
  at?: number;
}

function useSentiment(): Sentiment | null | 'error' {
  const [s, setS] = useState<Sentiment | null | 'error'>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/sentiment')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((j: Sentiment) => alive && setS({ ...j, at: Date.now() }))
        .catch(() => alive && setS((cur) => cur ?? 'error'));
    load();
    const id = setInterval(load, 60_000); // server caches; this just keeps the meter fresh
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return s;
}

export function ExecutiveDashboard({ engine, holdings, onSelect }: DashboardProps) {
  const sentiment = useSentiment();
  const all = Array.from(engine.quotes.values());
  const b = breadth(all);
  const mcap = engine.totalMcapCr();
  const trend = engine.mcapTrend;
  const trendPct = trend.length > 1 ? (trend[trend.length - 1] / trend[0] - 1) * 100 : 0;

  // concentration on the user's holdings (fallback: the universe by market cap)
  const weights = holdings.map((h) => h.qty * (engine.quotes.get(h.symbol)?.ltp ?? 0)).filter((v) => v > 0);
  const useOwn = weights.length >= 2;
  const h = hhi(useOwn ? weights : all.map((q) => q.mcapCr));
  const diversification = 1 - h / 10000;

  const nifty = engine.indices[0];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const growth = useMemo(() => trendGrowthYoY(engine.closes('NIFTY')), [engine, engine.histVer]);

  // weighted portfolio risk: Σ wᵢ·σᵢ over the holdings' 1Y daily volatility (falls back to the 8 largest caps)
  const holdKey = holdings.map((x) => x.symbol + x.qty).join(',');
  const wrisk = useMemo(() => {
    const base = holdings.length >= 1 ? holdings.map((x) => ({ symbol: x.symbol, weight: x.qty * (engine.quotes.get(x.symbol)?.ltp ?? x.avg) })) : [...engine.quotes.values()].sort((a, c) => c.mcapCr - a.mcapCr).slice(0, 8).map((q) => ({ symbol: q.symbol, weight: q.mcapCr }));
    const items = base.map((x) => ({ ...x, volPct: annualVolPct(engine.closes(x.symbol)) }));
    const tot = items.reduce((a, i) => a + i.weight, 0) || 1;
    return { ...weightedRiskScore(items), items: items.map((i) => ({ ...i, w: i.weight / tot })).sort((a, c) => c.w * c.volPct - a.w * a.volPct), own: holdings.length >= 1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdKey, engine, engine.histVer]);
  const wTone = wrisk.score < 35 ? 'text-up' : wrisk.score < 65 ? 'text-warn' : 'text-down';

  const risk = riskScore(engine.realisedVol(), h, b.ratio);
  const riskLabel = risk < 35 ? 'Low' : risk < 65 ? 'Moderate' : 'High';
  const riskTone = risk < 35 ? 'text-up' : risk < 65 ? 'text-warn' : 'text-down';
  const sent = sentiment && sentiment !== 'error' ? sentiment : null;

  return (
    <div className={CARD_GRID}>
      <div className={WIDE}><CircuitTracker engine={engine} onOpenChart={onSelect} /></div>
        <Card title="Aggregated market cap trend" right={<span className={`num text-[11px] ${tone(trendPct)}`}>{fmtPct(trendPct)} / {trend.length} pts</span>}>
          <div className="num text-2xl font-semibold text-ink sm:text-3xl">{fmtCr(mcap)}</div>
          <div className="mt-2">
            <AreaChart data={trend} fmtY={(n) => (n / 1e5).toFixed(2) + 'L'} xLabels={['oldest', 'now']} />
          </div>
          <p className="mt-1 text-[10px] text-muted">Σ market cap of the {all.length} tracked stocks (₹ lakh crore).</p>
        </Card>

        <Card
          title="Gemini RSS news sentiment · live"
          right={
            sent && (
              <span className="flex gap-1">
                {sent.sample && <Badge tone="warn">sample news</Badge>}
                <Badge tone={sent.source === 'gemini' ? 'accent' : 'muted'}>{sent.source === 'gemini' ? 'Gemini' : 'Local VADER'}</Badge>
              </span>
            )
          }
        >
          {sent ? (
            <>
              <div className="flex items-baseline gap-3">
                <span className={`num text-3xl font-semibold ${tone(sent.score)}`}>
                  {sent.score > 0 ? '+' : sent.score < 0 ? '−' : ''}
                  {Math.abs(sent.score).toFixed(2)}
                </span>
                <Badge tone={sentimentTone(sent.label)}>{sent.label}</Badge>
              </div>
              <div className="mt-3">
                <Meter value={sent.score} min={-1} max={1} zones={[{ to: -0.25, color: ZONE.down }, { to: 0.25, color: ZONE.muted }, { to: 1, color: ZONE.up }]} />
                <div className="num mt-1 flex justify-between text-[10px] text-muted">
                  <span>−1 Bearish</span>
                  <span>0</span>
                  <span>Bullish +1</span>
                </div>
              </div>
              <p className="mt-2 text-[10px] text-muted">
                Scored from {sent.headlines} headlines · updated {sent.at ? new Date(sent.at).toLocaleTimeString('en-IN', { hour12: false }) : '—'} (refreshes every minute).{sent.source === 'local' && sent.fallbackReason && sent.fallbackReason !== 'no_key' ? ` Gemini unavailable (${sent.fallbackReason.split(' ')[0]}), using local scoring.` : ''}
                {sent.source === 'local' && sent.fallbackReason === 'no_key' ? ' Set GEMINI_API_KEY for Gemini scoring.' : ''}
              </p>
            </>
          ) : sentiment === 'error' ? (
            <div className="py-6 text-[13px] text-down">Couldn’t load sentiment.</div>
          ) : (
            <div className="py-6 text-[13px] text-muted">Scoring headlines…</div>
          )}
        </Card>

      <div className={`grid grid-cols-2 gap-2 ${WIDE}`}>
        <Stat label="Weighted portfolio risk" value={`${wrisk.score}/100`} valueClass={wTone} sub={`Σ wᵢσᵢ = ${wrisk.weightedVolPct.toFixed(1)}% vol`} hint="Σ wᵢ·σᵢ (annualised 1Y vol), 60% vol = 100" />
        <Stat label="Market risk exposure" value={`${risk}/100`} valueClass={riskTone} sub={`${riskLabel} · vol, concentration, breadth`} />
        <Stat label="Forecast growth YoY" value={growth === null ? '—' : fmtPct(growth, 1)} valueClass={growth === null ? '' : tone(growth)} sub="Log-linear trend, NIFTY 50" hint="Annualised slope of a log-linear regression on 1Y of daily closes. Not investment advice." />
        <Stat label="Herfindahl (HHI)" value={Math.round(h).toLocaleString('en-IN')} sub={useOwn ? 'your holdings · Σwᵢ²' : 'universe by mcap · Σwᵢ²'} hint="HHI = 10 000 × Σ wᵢ². 0 = fully diversified, 10 000 = a single name" />
        <Stat label="Diversification index" value={diversification.toFixed(2)} valueClass={diversification > 0.8 ? 'text-up' : diversification > 0.6 ? 'text-ink' : 'text-down'} sub="1 − HHI/10 000" />
      </div>

      <PortfolioRiskEngine engine={engine} holdings={holdings} className={WIDE} />
      <RiskPanel engine={engine} holdings={holdings} />
      <VarCard engine={engine} holdings={holdings} className={WIDE} />
      <DrawdownCard engine={engine} holdings={holdings} className={WIDE} />
      <LimitMonitor engine={engine} holdings={holdings} className={WIDE} />
      <CircuitPredictor engine={engine} onSelect={onSelect} className={WIDE} />

      <Card title="Weighted portfolio risk score" badges={['yahoo', 'computed']} right={<span className={`num text-[12px] font-semibold ${wTone}`}>{wrisk.score}/100</span>} className={WIDE}>
        <Meter value={wrisk.score} zones={[{ to: 35, color: ZONE.up }, { to: 65, color: ZONE.warn }, { to: 100, color: ZONE.down }]} />
        <div className="num mt-1 flex justify-between text-[10px] text-muted"><span>0 Low</span><span>Moderate</span><span>High 100</span></div>
        <table className="num mt-3 w-full text-[12px]">
          <thead className="text-[10px] uppercase tracking-wider text-muted">
            <tr><th className="text-left font-medium">{wrisk.own ? 'Holding' : 'Largest caps'}</th><th className="text-right font-medium">Weight</th><th className="text-right font-medium">Vol</th><th className="text-right font-medium">Risk share</th></tr>
          </thead>
          <tbody>
            {wrisk.items.slice(0, 6).map((i) => (
              <tr key={i.symbol} className="border-t border-line"><td className="py-1 font-semibold">{i.symbol}</td><td className="text-right">{(i.w * 100).toFixed(1)}%</td><td className="text-right text-muted">{i.volPct.toFixed(1)}%</td><td className="text-right text-ink">{((i.w * i.volPct) / (wrisk.weightedVolPct || 1) * 100).toFixed(0)}%</td></tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[10px] text-muted">Risk share = wᵢσᵢ ÷ Σ wᵢσᵢ. {wrisk.own ? 'Based on your holdings.' : 'No holdings loaded — showing the largest caps.'}</p>
      </Card>

      <Card title="Market risk gauge" className={WIDE}>
        <Meter value={risk} zones={[{ to: 35, color: ZONE.up }, { to: 65, color: ZONE.warn }, { to: 100, color: ZONE.down }]} />
        <div className="num mt-1 flex justify-between text-[10px] text-muted">
          <span>0 Low</span>
          <span>Moderate</span>
          <span>High 100</span>
        </div>
      </Card>
    </div>
  );
}
