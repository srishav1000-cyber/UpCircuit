// Mandatory Regulatory & Risk Disclosure, re-shown on every fresh browser session / login.
export const DISCLOSURE_VERSION = '2026-11';
export const disclosureKey = (userId: string) => `upcircuit:disclosure:${DISCLOSURE_VERSION}:${userId}`;
export const DISCLOSURE_POINTS: readonly string[] = [
  'UpCircuit is a real-time market analytics and educational telemetry platform. It is NOT a SEBI-registered Investment Adviser or Research Analyst.',
  'Nothing shown here — indicators, heuristic depth flags, backtests, alerts, AI output or any other data — is investment advice, a buy/sell/hold recommendation, or a solicitation.',
  'Every trading and investment decision is made solely at your own discretion and risk. You bear full financial responsibility for your trades and their outcomes.',
];
/**
 * Per-SESSION acknowledgement. Stored in sessionStorage (gone when the tab / browser closes) under a key for this user + disclosure version, with the
 * login-session stamp as its value — the Supabase access token's `session_id` claim (stable across token refreshes, new on every sign-in).
 * So a new tab session, a sign-out → sign-in, or a different login always asks again; a token refresh or page reload inside one login does not.
 * The accept time is additionally recorded in the auth user metadata as an audit trail (it never suppresses the modal).
 */
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>;
const session = (): Store | null => { try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; } };
export const DISCLOSURE_PREFIX = 'upcircuit:disclosure:';

/** the login session a JWT belongs to ('' when there is no token / claim, e.g. demo accounts) */
export function sessionStamp(token: string | null | undefined): string {
  const part = token?.split('.')[1];
  if (!part) return '';
  try {
    const j = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { session_id?: unknown };
    return typeof j.session_id === 'string' ? j.session_id : '';
  } catch { return ''; }
}
export function readAck(userId: string, stamp = '', storage: Store | null = session()): boolean {
  try { return storage?.getItem(disclosureKey(userId)) === `ok:${stamp}`; } catch { return false; }
}
export function writeAck(userId: string, stamp = '', storage: Store | null = session()): void {
  try { storage?.setItem(disclosureKey(userId), `ok:${stamp}`); } catch { /* in-memory only: the modal returns on the next load */ }
}
/** sign-out: forget every acknowledgement of this browser session so the next sign-in shows the modal again */
export function clearAck(storage: Store | null = session()): void {
  try {
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < (storage.length ?? 0); i++) { const k = storage.key?.(i); if (k && k.startsWith(DISCLOSURE_PREFIX)) keys.push(k); }
    keys.forEach((k) => storage.removeItem(k));
  } catch { /* nothing to clear */ }
}
/** audit trail: record when the user accepted (auth user metadata); best effort, never throws, never read back to skip the modal */
export async function saveMetadataAck(token: string, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY): Promise<boolean> {
  if (!url || !key) return false;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/user`, { method: 'PUT', headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { disclosure_ack: DISCLOSURE_VERSION, disclosure_ack_at: new Date().toISOString() } }) });
    return r.ok;
  } catch { return false; }
}
