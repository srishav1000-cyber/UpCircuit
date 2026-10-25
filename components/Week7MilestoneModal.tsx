'use client';

import { useEffect, useRef } from 'react';
import { HHI_HIGH, HHI_MODERATE } from '@/lib/analytics/hhi';

const SECTIONS: { id: string; title: string; points: string[] }[] = [
  {
    id: 'hhi',
    title: '1 · Quantitative HHI risk engine',
    points: [
      `Herfindahl–Hirschman Index: HHI = Σ sᵢ² with sᵢ in percent (0–10,000), computed for stock weights and for sector weights of the user's holdings.`,
      `Badge uses the worse of the two: LOW CONCENTRATION (< ${HHI_MODERATE.toLocaleString('en-IN')}), MODERATE RISK (${HHI_MODERATE.toLocaleString('en-IN')}–${HHI_HIGH.toLocaleString('en-IN')}), HIGH CONCENTRATION RISK (> ${HHI_HIGH.toLocaleString('en-IN')}).`,
      'Portfolio beta vs NIFTY 50 = Cov(Rp, Rm) ÷ Var(Rm) on right-aligned daily returns of real Yahoo 1-year closes (≥ 30 paired observations, otherwise N/A).',
      'Sharpe estimate = annualised mean excess return ÷ annualised volatility of the holdings\' combined value series; recomputed on every holding or price change.',
    ],
  },
  {
    id: 'stream',
    title: '2 · Hybrid streaming architecture',
    points: [
      'Primary: Angel One SmartAPI WebSocket straight from the browser (only clientCode + feedToken ever reach the client; the JWT stays on the server). Ticks update the chart directly with no frame delay.',
      'Fallback: Yahoo Finance quotes + bars over REST (cookie + crumb, per-symbol chart fallback), polled every 10 s while the market is open and 60 s when closed. Real data only — missing values show N/A.',
      'DOM repaints are batched to one animation frame every 250 ms (4 fps); outside market hours prices freeze to the last session close instead of simulating moves.',
      'Supabase REST (no SDK) syncs watchlist, holdings, preferences and the circuit-alert history with row-level security; localStorage is the offline cache.',
    ],
  },
  {
    id: 'search',
    title: '3 · Fuzzy universal search',
    points: [
      'Index over the full NSE + BSE scrip master (ticker, company name, aliases, BSE scrip code).',
      'Ranking: exact ticker first, then prefix, word-prefix, alias and typo-tolerant fuzzy matches; Enter opens the top hit.',
      'Selecting a result can add the stock to the Focus basket or the portfolio.',
    ],
  },
  {
    id: 'pdf',
    title: '4 · One-click PDF research report',
    points: [
      'Generated in the browser with jsPDF (lazy-loaded) in a light, print-ready or dark theme — no server round-trip for the document itself.',
      'Sections: executive summary & company profile, key valuation ratios, technical summary (EMA 20/50, RSI 14, support & resistance), AI Copilot valuation insights and a news-sentiment summary.',
      'Unavailable ratios are printed as N/A; ₹ is written as "Rs." because the standard PDF fonts have no rupee glyph.',
    ],
  },
  {
    id: 'ux',
    title: '5 · Terminal UX added in this milestone',
    points: [
      'Visual Copilot answers: verdict banner, KPI chips, bold-lead bullets, collapsible risk / headline sections and quick-action chips.',
      'Full-screen research dashboard at 100 % width with a slide-out "Ask UpCircuit" Copilot drawer; live RSS news (Google News India, Economic Times, Mint, Moneycontrol) with relative timestamps, ticker tags and sentiment.',
      'Chart drawing suite: trend line, horizontal level, Fibonacci, text, measure, brush, price range and eraser — anchored in (time, price) space so drawings follow pan and zoom.',
    ],
  },
];

/** "Week 7 Specs" — one-screen architecture summary for the project submission. Esc or backdrop closes. */
export function Week7MilestoneModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('keydown', k);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid="week7-backdrop">
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Week 7 specs" data-testid="week7-modal" className="flex max-h-[92vh] w-full max-w-[760px] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl outline-none">
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">Week 7 milestone</p>
            <h2 className="text-[18px] font-bold text-ink">UpCircuit — system specification</h2>
            <p className="text-[11.5px] text-muted">Real-Time Stock Market Analytics &amp; Circuit Breaker Engine · M.Sc. Data Science capstone</p>
          </div>
          <button onClick={onClose} aria-label="Close Week 7 specs" data-testid="week7-close" className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-line text-[18px] leading-none text-muted hover:bg-line hover:text-ink">×</button>
        </header>
        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {SECTIONS.map((s) => (
            <section key={s.id} data-testid={`week7-${s.id}`}>
              <h3 className="mb-1.5 text-[13px] font-bold text-ink">{s.title}</h3>
              <ul className="space-y-1.5 text-[12px] leading-relaxed text-muted">
                {s.points.map((p) => (
                  <li key={p} className="border-l-2 border-accent/50 pl-2.5">{p}</li>
                ))}
              </ul>
            </section>
          ))}
          <p className="border-t border-line pt-3 text-[10.5px] text-muted">Educational project — not investment advice. Live numbers (latency, throughput, indexed instruments) are on the System telemetry panel in the status bar.</p>
        </div>
      </div>
    </div>
  );
}
