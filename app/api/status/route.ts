import { geminiKey, geminiModel } from '@/lib/gemini';
import { TtlCache, allow } from '@/lib/ttlCache';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const SMARTAPI_VARS = ['SMARTAPI_API_KEY', 'SMARTAPI_CLIENT_CODE', 'SMARTAPI_PASSWORD', 'SMARTAPI_TOTP_SECRET'] as const;

interface GeminiState {
  configured: boolean;
  /** true = the key was accepted by Google; false = rejected; null = unknown (not configured, offline, timeout) */
  valid: boolean | null;
  reason?: 'rejected' | 'quota' | 'unreachable';
  model: string;
}
const cache = new TtlCache<GeminiState>(60_000, 4);
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { 'Cache-Control': 'no-store' } });

/** Validates the key with a metadata GET (models.get): no tokens are generated, so it costs no generation quota. */
async function geminiState(): Promise<GeminiState> {
  const key = geminiKey();
  const model = geminiModel();
  if (!key) return { configured: false, valid: null, model };
  const hit = cache.get('g');
  if (hit) return hit.value;
  let st: GeminiState;
  try {
    const base = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
    const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(4000) });
    if (res.ok) st = { configured: true, valid: true, model };
    else if (res.status === 429) st = { configured: true, valid: true, reason: 'quota', model };
    else if (res.status === 400 || res.status === 401 || res.status === 403) st = { configured: true, valid: false, reason: 'rejected', model };
    else st = { configured: true, valid: null, reason: 'unreachable', model };
  } catch {
    st = { configured: true, valid: null, reason: 'unreachable', model };
  }
  cache.set('g', st);
  return st;
}

/**
 * GET /api/status — which integrations are configured on THIS server. Booleans and variable names only: values never leave the server.
 * (`smartapi.serverCreds` = the four server-side SmartAPI secrets for /api/smartapi/session; `publicKeyConfigured` = the build-time browser key.)
 */
export async function GET(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
  if (!allow('status:' + ip, 30, 60_000)) return json({ error: 'Too many requests' }, 429);
  // the API key may be supplied as either SMARTAPI_API_KEY (server) or NEXT_PUBLIC_SMARTAPI_API_KEY (browser) — they are the same key
  const missing = SMARTAPI_VARS.filter((v) => !(process.env[v] || (v === 'SMARTAPI_API_KEY' && process.env.NEXT_PUBLIC_SMARTAPI_API_KEY)));
  return json({
    gemini: await geminiState(),
    smartapi: { serverCreds: missing.length === 0, missing, publicKeyConfigured: Boolean(process.env.NEXT_PUBLIC_SMARTAPI_API_KEY) },
  });
}
