// Legal / compliance copy. TEMPLATES for a student capstone — must be reviewed by qualified counsel before any commercial launch (stated on every page).
export const LEGAL_REVIEW_NOTE = 'Template text prepared for a capstone project. It is not legal advice and must be reviewed by a qualified lawyer (SEBI, DPDP Act 2023, exchange-data licensing) before any commercial launch.';
export const SHORT_DISCLAIMER = 'UpCircuit shows delayed / indicative market data and AI-generated commentary for information and education only. It is not investment advice or a research report, and UpCircuit is not registered with SEBI as a Research Analyst or Investment Adviser. Verify prices with your broker before acting.';
export type LegalDoc = 'privacy' | 'terms' | 'data-sources' | 'disclaimer';
type Doc = { title: string; updated: string; sections: { h: string; p: string[] }[] };
export const LEGAL_DOCS: Record<LegalDoc, Doc> = {
  disclaimer: {
    title: 'Risk & AI disclaimer', updated: '2026-10-27',
    sections: [
      { h: 'Not investment advice', p: [SHORT_DISCLAIMER, 'Circuit predictions, sentiment scores, Copilot answers and post-mortems are model outputs built from public data. They can be wrong, late or incomplete and are never a recommendation to buy, sell or hold any security.'] },
      { h: 'AI-generated content', p: ['Text produced by the AI Copilot and post-mortem generator is labelled as AI-generated. It may cite stale or mistaken facts; check it against exchange filings and your broker.', 'Where a figure is unavailable UpCircuit shows “N/A” — it never fills gaps with invented values.'] },
      { h: 'Trading risk', p: ['Equity trading can lose money. Stocks in a circuit band may have no buyers or sellers; you may be unable to exit a position.'] },
    ],
  },
  'data-sources': {
    title: 'Data sources & licensing', updated: '2026-10-27',
    sections: [
      { h: 'Where prices come from', p: ['Live prices stream to your browser from Angel One SmartAPI using the market-data entitlement of the account configured by the operator. When that feed is unavailable the app falls back to delayed public quotes (Yahoo Finance, an unofficial interface) or the last NSE close, and labels which one you are seeing in the status badge.', 'The server-side alert worker has no socket to SmartAPI, so it uses the delayed fallback quotes; alerts fired by it are therefore delayed.'] },
      { h: 'Redistribution', p: ['Exchange data is licensed. A market-data licence is what permits display: Angel One’s API terms cover the account holder’s own use; showing real-time prices to other users, or selling access, may require an exchange data-redistribution agreement (NSE / BSE) and a vendor licence. Yahoo Finance data is for personal, non-commercial use only.', 'Until such licences are in place, UpCircuit should be operated as a single-organisation or personal tool, not resold.'] },
      { h: 'News', p: ['Headlines are fetched from public RSS feeds and linked to their publishers; UpCircuit stores no article text.'] },
    ],
  },
  privacy: {
    title: 'Privacy policy', updated: '2026-10-27',
    sections: [
      { h: 'What we collect', p: ['Account details (e-mail, optional name and verified mobile number), your portfolio holdings, watchlists, preferences, alert rules and history, web-push device tokens, and an audit log of significant actions (sign-in, exports, alert-rule changes, circuit-event reviews).', 'Portfolio screenshots and PDFs are processed in your browser (OCR); only the extracted holdings you confirm are saved.'] },
      { h: 'Why (purposes)', p: ['To run the app, sync your data across devices, deliver the alerts you configure, and keep a tamper-evident record for compliance review. We do not sell personal data or use it for advertising.'] },
      { h: 'Processors', p: ['Supabase (database and authentication), Vercel (hosting), Resend (alert e-mail), Google (Gemini, only the text of questions you ask the Copilot — never your identity), and browser push services (FCM / Mozilla / Apple / Microsoft).'] },
      { h: 'Your rights (DPDP Act 2023)', p: ['You can access, correct and erase your data. Settings → Cloud & Data lets you export and reset your account data; to delete the account itself write to the grievance contact below. Audit entries are retained for a limited period for security and compliance, then removed.', 'Grievance contact: the operator of this deployment (set a real address before launch).'] },
      { h: 'Security', p: ['Row Level Security confines every user to their own rows; access tokens are never stored server-side; API keys are never entered in the UI.'] },
    ],
  },
  terms: {
    title: 'Terms of use', updated: '2026-10-27',
    sections: [
      { h: 'Use of the service', p: ['UpCircuit is provided “as is” for information and education. You are responsible for your trading decisions and for keeping your credentials safe.'] },
      { h: 'Roles & acceptable use', p: ['Roles (viewer, analyst, risk officer, compliance, admin) control access to the surveillance register and audit trail. Do not attempt to bypass access controls, scrape the service, or redistribute market data shown in it.'] },
      { h: 'Liability', p: ['To the extent permitted by law, the operator is not liable for losses arising from reliance on delayed data, alerts that arrive late or not at all, or AI-generated content.'] },
    ],
  },
};
export const isLegalDoc = (x: string): x is LegalDoc => x in LEGAL_DOCS;

export const LEGAL: (Doc & { slug: LegalDoc })[] = (Object.keys(LEGAL_DOCS) as LegalDoc[]).map((slug) => ({ slug, ...LEGAL_DOCS[slug] }));
export const legalDoc = (slug: string) => LEGAL.find((d) => d.slug === slug);
