import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LEGAL_DOCS, LEGAL_REVIEW_NOTE, isLegalDoc } from '@/lib/legal';

export function generateStaticParams() { return Object.keys(LEGAL_DOCS).map((doc) => ({ doc })); }

export default function LegalPage({ params }: { params: { doc: string } }) {
  if (!isLegalDoc(params.doc)) notFound();
  const d = LEGAL_DOCS[params.doc];
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 text-ink" data-testid="legal-page">
      <Link href="/" className="text-[12px] text-accent hover:underline">← Back to UpCircuit</Link>
      <h1 className="mt-3 text-2xl font-bold">{d.title}</h1>
      <p className="mb-4 text-[12px] text-muted">Last updated {d.updated}</p>
      <p role="note" className="mb-6 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">{LEGAL_REVIEW_NOTE}</p>
      {d.sections.map((s) => (
        <section key={s.h} className="mb-5">
          <h2 className="mb-1 text-base font-semibold">{s.h}</h2>
          {s.p.map((t, i) => <p key={i} className="mb-2 text-[13px] leading-relaxed text-muted">{t}</p>)}
        </section>
      ))}
      <nav className="mt-8 flex flex-wrap gap-3 border-t border-line pt-3 text-[12px]">
        {Object.entries(LEGAL_DOCS).map(([k, v]) => <Link key={k} href={`/legal/${k}`} className="text-muted hover:text-accent">{v.title}</Link>)}
      </nav>
    </main>
  );
}
