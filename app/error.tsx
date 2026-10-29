'use client';

import { useEffect } from 'react';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    void fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: error.message, stack: error.stack, where: error.digest ?? 'app' }) }).catch(() => undefined);
  }, [error]);
  return (
    <main role="alert" data-testid="error-state" className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-3xl" aria-hidden>⚠️</div>
      <h1 className="text-lg font-bold text-ink">Something went wrong</h1>
      <p className="text-[13px] text-muted">The error was reported. Your portfolio and settings are safe — they live in your account, not on this screen.</p>
      <div className="flex gap-2">
        <button onClick={reset} className="rounded-md bg-accent px-4 py-2 text-[13px] font-bold text-white">Try again</button>
        <a href="/" className="rounded-md border border-line px-4 py-2 text-[13px] font-semibold text-ink">Home</a>
      </div>
    </main>
  );
}
