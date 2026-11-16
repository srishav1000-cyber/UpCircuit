// Mandatory post-login Regulatory & Risk Disclosure: acknowledgement is stored per user + version in localStorage and (Supabase) in the auth user metadata.
export const DISCLOSURE_VERSION = '2026-11';
export const disclosureKey = (userId: string) => `upcircuit:disclosure:${DISCLOSURE_VERSION}:${userId}`;
export const DISCLOSURE_POINTS: readonly string[] = [
  'UpCircuit is a real-time market analytics and educational telemetry platform. It is NOT a SEBI-registered Investment Adviser or Research Analyst.',
  'Nothing shown here — indicators, heuristic depth flags, backtests, alerts, AI output or any other data — is investment advice, a buy/sell/hold recommendation, or a solicitation.',
  'Every trading and investment decision is made solely at your own discretion and risk. You bear full financial responsibility for your trades and their outcomes.',
];
export function readAck(userId: string, storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): boolean {
  try { return storage?.getItem(disclosureKey(userId)) === '1'; } catch { return false; }
}
export function writeAck(userId: string, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem(disclosureKey(userId), '1'); } catch { /* in-memory only: the modal returns next load */ }
}
/** Supabase: GET/PUT the auth user's metadata (`disclosure_ack: <version>`); best effort, never throws */
export async function metadataAcked(token: string, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY): Promise<boolean> {
  if (!url || !key) return false;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    const j = (await r.json().catch(() => ({}))) as { user_metadata?: { disclosure_ack?: unknown } };
    return r.ok && j.user_metadata?.disclosure_ack === DISCLOSURE_VERSION;
  } catch { return false; }
}
export async function saveMetadataAck(token: string, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY): Promise<boolean> {
  if (!url || !key) return false;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/user`, { method: 'PUT', headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { disclosure_ack: DISCLOSURE_VERSION, disclosure_ack_at: new Date().toISOString() } }) });
    return r.ok;
  } catch { return false; }
}
