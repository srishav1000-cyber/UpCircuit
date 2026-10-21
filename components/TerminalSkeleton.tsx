/**
 * Dark glassmorphic loading shell. Always dark (own `dark` scope + bg-slate-950) regardless of the saved theme, so nothing white can
 * flash between the login screen and the terminal. Mirrors the terminal layout: top bar, index strip, chart pane, dashboard cards.
 */
export function TerminalSkeleton({ message = 'Initializing UpCircuit Market Analytics Engine...', children }: { message?: string; children?: React.ReactNode }) {
  const glass = 'rounded-lg border border-slate-800/80 bg-slate-900/60 animate-pulse';
  return (
    <div data-testid="terminal-skeleton" className="dark flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-800/80 bg-slate-900/60 px-3">
        <div className="h-6 w-6 rounded-md bg-gradient-to-br from-blue-500/60 to-emerald-500/60" />
        <div className="h-4 w-24 rounded bg-slate-800/80" />
        <div className="ml-4 hidden h-7 w-64 rounded-md bg-slate-800/60 md:block" />
        <div className="ml-auto flex gap-2"><div className="h-7 w-20 rounded-md bg-slate-800/60" /><div className="h-7 w-7 rounded-full bg-slate-800/60" /></div>
      </div>
      <div className="flex shrink-0 gap-3 overflow-hidden border-b border-slate-800/80 px-3 py-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 w-36 shrink-0 rounded-md bg-slate-900/60" />)}
      </div>
      <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)]">
        <div className={`${glass} min-h-[320px]`} />
        <div className="grid content-start gap-3">
          <div className={`${glass} h-24`} />
          <div className="grid grid-cols-2 gap-3"><div className={`${glass} h-28`} /><div className={`${glass} h-28`} /></div>
          <div className={`${glass} h-40`} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-3 px-4 pb-6 text-center text-[13px] text-slate-400" role="status" aria-live="polite">
        <span className="animate-pulse">{message}</span>
        {children}
      </div>
    </div>
  );
}
