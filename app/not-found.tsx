import Link from 'next/link';

export default function NotFound() {
  return (
    <main data-testid="not-found" className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-3xl" aria-hidden>🔎</div>
      <h1 className="text-lg font-bold text-ink">Page not found</h1>
      <p className="text-[13px] text-muted">That address doesn’t exist. Try the terminal, or check the system status.</p>
      <div className="flex gap-2">
        <Link href="/" className="rounded-md bg-accent px-4 py-2 text-[13px] font-bold text-white">Open UpCircuit</Link>
        <Link href="/status" className="rounded-md border border-line px-4 py-2 text-[13px] font-semibold text-ink">System status</Link>
      </div>
    </main>
  );
}
