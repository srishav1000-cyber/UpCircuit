import { RSI_LABEL, RSI_OVERBOUGHT, RSI_OVERSOLD, rsiZone } from '@/lib/analytics/rsi';

const R = 70;
const CX = 90;
const CY = 86;
const pt = (v: number, r = R) => {
  const a = Math.PI * (1 - v / 100);
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)] as const;
};
const arc = (from: number, to: number, r = R) => {
  const [x1, y1] = pt(from, r);
  const [x2, y2] = pt(to, r);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};

/** Semicircular RSI(14) gauge: green 0–30 (oversold), grey 30–70, red 70–100 (overbought), needle at the value. */
export function RSIGauge({ value }: { value: number | null }) {
  const z = rsiZone(value);
  const v = value === null ? 50 : Math.max(0, Math.min(100, value));
  const [nx, ny] = pt(v, R - 10);
  const tone = z === 'overbought' ? 'text-down' : z === 'oversold' ? 'text-up' : 'text-ink';
  return (
    <div data-testid="rsi-gauge" data-rsi={value === null ? 'na' : value.toFixed(1)} className="flex flex-col items-center">
      <svg viewBox="0 0 180 104" className="w-full max-w-[220px]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value)} aria-label="RSI 14">
        <path d={arc(0, RSI_OVERSOLD)} fill="none" strokeWidth="12" strokeLinecap="butt" style={{ stroke: 'rgb(var(--c-up) / 0.75)' }} />
        <path d={arc(RSI_OVERSOLD, RSI_OVERBOUGHT)} fill="none" strokeWidth="12" style={{ stroke: 'rgb(var(--c-muted) / 0.5)' }} />
        <path d={arc(RSI_OVERBOUGHT, 100)} fill="none" strokeWidth="12" style={{ stroke: 'rgb(var(--c-down) / 0.75)' }} />
        {value !== null && (
          <>
            <line x1={CX} y1={CY} x2={nx} y2={ny} strokeWidth="2.5" strokeLinecap="round" style={{ stroke: 'rgb(var(--c-ink))' }} />
            <circle cx={CX} cy={CY} r="4.5" style={{ fill: 'rgb(var(--c-ink))' }} />
          </>
        )}
        <text x={pt(0)[0]} y={CY + 12} textAnchor="middle" className="num" style={{ fill: 'rgb(var(--c-muted))', fontSize: 8 }}>0</text>
        <text x={pt(30, R + 10)[0]} y={pt(30, R + 10)[1]} textAnchor="middle" className="num" style={{ fill: 'rgb(var(--c-muted))', fontSize: 8 }}>30</text>
        <text x={pt(70, R + 10)[0]} y={pt(70, R + 10)[1]} textAnchor="middle" className="num" style={{ fill: 'rgb(var(--c-muted))', fontSize: 8 }}>70</text>
        <text x={pt(100)[0]} y={CY + 12} textAnchor="middle" className="num" style={{ fill: 'rgb(var(--c-muted))', fontSize: 8 }}>100</text>
      </svg>
      <div className={`num -mt-4 text-3xl font-semibold ${tone}`}>{value === null ? '—' : value.toFixed(1)}</div>
      <div className={`text-[11px] font-semibold ${tone}`}>{z ? RSI_LABEL[z] : 'Needs 15+ daily closes'}</div>
    </div>
  );
}
