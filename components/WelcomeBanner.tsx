import { WELCOME_TEXT } from '@/lib/focus';

/** One-time, dismissible onboarding banner (dismissal is remembered per user). */
export function WelcomeBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div data-testid="welcome-banner" role="status" className="flex items-start gap-3 border-b border-blue-500/30 bg-gradient-to-r from-blue-950/60 via-slate-900/60 to-slate-900/40 px-4 py-2 text-[12px] text-slate-200 backdrop-blur">
      <p className="min-w-0 flex-1 leading-relaxed">{WELCOME_TEXT}</p>
      <button type="button" onClick={onDismiss} data-testid="welcome-dismiss" aria-label="Dismiss welcome message" className="shrink-0 rounded border border-slate-600/70 px-2 py-0.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-700/50">Got it ✕</button>
    </div>
  );
}
