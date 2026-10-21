import { alpha } from '@/lib/theme';
import { avgPairwise, corrWord, extremePairs, type CorrMatrix } from '@/lib/analytics/correlation';

const tint = (r: number) => alpha(r >= 0 ? 'up' : 'down', 0.08 + Math.abs(r) * 0.62);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Pearson r heatmap (green positive, red negative) with the basket's average pairwise r and its extreme pairs. */
export function CorrelationMatrix({ data, highlight, cellTestId, compact = false }: { data: CorrMatrix; highlight?: string; cellTestId?: string; compact?: boolean }) {
  const avg = avgPairwise(data);
  const ex = extremePairs(data);
  return (
    <div data-testid="corr-matrix">
      <div className="overflow-x-auto">
        <table className={`num w-full border-separate text-center text-[11px] ${compact ? 'mx-auto max-w-[520px] border-spacing-1' : 'border-spacing-0.5'}`}>
          <thead>
            <tr>
              <th />
              {data.symbols.map((s) => (
                <th key={s} className={`px-1 pb-1 font-semibold ${s === highlight ? 'text-accent' : 'text-muted'}`}>{short(s, 7)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.symbols.map((rs, i) => (
              <tr key={rs}>
                <th scope="row" className={`pr-2 text-right font-semibold ${rs === highlight ? 'text-accent' : 'text-muted'}`}>{short(rs, 9)}</th>
                {data.matrix[i].map((r, j) => (
                  <td key={j} data-testid={cellTestId} title={`${rs} × ${data.symbols[j]}: r = ${r.toFixed(3)} (${i === j ? 'identity' : corrWord(r)})`} className={`rounded text-ink ${compact ? 'py-2.5 text-[12px] font-semibold' : 'py-1.5'}`} style={{ background: i === j ? alpha('muted', 0.18) : tint(r) }}>
                    {i === j ? '1.00' : r.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {avg !== null && ex && (
        <p data-testid="corr-summary" className="num mt-2 text-[11px] text-ink">
          Average pairwise r <b>{avg.toFixed(2)}</b> ({corrWord(avg)}) · closest pair {ex.high.a}/{ex.high.b} <b>{ex.high.r.toFixed(2)}</b> · most independent {ex.low.a}/{ex.low.b} <b>{ex.low.r.toFixed(2)}</b>
        </p>
      )}
    </div>
  );
}
