'use client';

import { parseCopilotCard, type ChipTone, type Verdict } from '@/lib/copilotCards';
import { Markdown } from './Markdown';

const CHIP: Record<ChipTone, string> = {
  up: 'border-up/40 bg-up/10 text-up',
  down: 'border-down/40 bg-down/10 text-down',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  muted: 'border-line bg-bg text-muted',
};
const BANNER: Record<Verdict, { cls: string; icon: string }> = {
  BULLISH: { cls: 'border-up/50 bg-up/15 text-up', icon: '▲' },
  BEARISH: { cls: 'border-down/50 bg-down/15 text-down', icon: '▼' },
  NEUTRAL: { cls: 'border-warn/40 bg-warn/10 text-warn', icon: '◆' },
};

/** Renders a Copilot answer as a verdict banner + KPI chips + bullet insights + collapsible sections; plain markdown when the answer has no card markup. */
export function CopilotCards({ text }: { text: string }) {
  const c = parseCopilotCard(text);
  if (!c.structured) return <Markdown text={text} />;
  const disclaimer = /^(Educational overview[^\n]*)$/m.exec(c.body)?.[1];
  const body = disclaimer ? c.body.replace(disclaimer, '').trim() : c.body;
  return (
    <div className="space-y-2" data-testid="copilot-card">
      {c.verdict && (
        <div data-testid="copilot-verdict" data-verdict={c.verdict} className={`flex items-start gap-2 rounded-md border px-2.5 py-2 ${BANNER[c.verdict].cls}`}>
          <span className="mt-px text-[12px]" aria-hidden>{BANNER[c.verdict].icon}</span>
          <div className="min-w-0">
            <div className="text-[11px] font-extrabold tracking-wider">{c.verdict}</div>
            {c.takeaway && <div className="text-[12px] font-medium leading-snug text-ink">{c.takeaway}</div>}
          </div>
        </div>
      )}
      {c.chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="copilot-chips">
          {c.chips.map((k, i) => (
            <span key={i} data-testid="copilot-chip" className={`num inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${CHIP[k.tone]}`}>
              <span className="font-medium opacity-80">{k.label}</span>
              <span className="text-ink">{k.value}</span>
              {k.tag && <span className="rounded bg-black/10 px-1 text-[10px] uppercase tracking-wide">{k.tag}</span>}
            </span>
          ))}
        </div>
      )}
      {body && <Markdown text={body} className="[&_ul]:ml-3 [&_ul]:list-none [&_li]:rounded [&_li]:border-l-2 [&_li]:border-accent/50 [&_li]:bg-bg/60 [&_li]:py-0.5 [&_li]:pl-2 [&_ul]:space-y-1" />}
      {c.sections.map((s, i) => (
        <details key={i} data-testid="copilot-section" className="group rounded-md border border-line bg-bg/50">
          <summary className="flex cursor-pointer list-none items-center justify-between px-2.5 py-1.5 text-[12px] font-semibold text-ink marker:hidden">
            {s.title}
            <span className="text-muted transition-transform group-open:rotate-90" aria-hidden>›</span>
          </summary>
          <div className="border-t border-line px-2.5 py-2"><Markdown text={s.body} className="[&_ul]:ml-3 [&_ul]:list-none [&_ul]:space-y-1" /></div>
        </details>
      ))}
      {disclaimer && <p className="text-[10px] text-muted">{disclaimer}</p>}
    </div>
  );
}
