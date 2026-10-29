'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const KEY = 'upcircuit:consent:v1';
/** First-visit notice (DPDP-style): what is stored, the purpose, links to the policies. Stored locally; shown again if the policy version changes. */
export function ConsentBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => { try { setShow(localStorage.getItem(KEY) !== 'accepted'); } catch { setShow(false); } }, []);
  if (!show) return null;
  return (
    <div role="dialog" aria-label="Privacy notice" data-testid="consent" className="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-2xl rounded-xl border border-line bg-panel/95 p-4 text-[12px] text-muted shadow-2xl backdrop-blur">
      <p>UpCircuit stores your account, portfolio, watchlists, alert settings and an audit log of your actions to run the service. Market data is delayed and nothing here is investment advice. See the <Link href="/legal/privacy" className="text-accent underline">Privacy notice</Link>, <Link href="/legal/disclaimer" className="text-accent underline">Risk disclaimer</Link> and <Link href="/legal/data-sources" className="text-accent underline">Data sources</Link>.</p>
      <div className="mt-3 flex justify-end"><button data-testid="consent-accept" onClick={() => { try { localStorage.setItem(KEY, 'accepted'); } catch { /* ignore */ } setShow(false); }} className="rounded-md bg-accent px-4 py-1.5 text-[12px] font-bold text-white hover:brightness-110">I understand</button></div>
    </div>
  );
}

export function LegalFooter({ className = '' }: { className?: string }) {
  return (
    <footer data-testid="legal-footer" className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-muted ${className}`}>
      <span>Delayed data · not investment advice</span>
      {[['disclaimer', 'Risk disclaimer'], ['data-sources', 'Data sources'], ['privacy', 'Privacy'], ['terms', 'Terms']].map(([s, l]) => <Link key={s} href={`/legal/${s}`} className="hover:text-accent hover:underline">{l}</Link>)}
    </footer>
  );
}
