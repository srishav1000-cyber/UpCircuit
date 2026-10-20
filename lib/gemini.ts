// Edge-safe Gemini client (fetch only). Shared by /api/copilot and /api/sentiment.

/** `truncated` = Gemini stopped on its token limit (finishReason MAX_TOKENS) — callers trim to the last complete sentence */
export type GeminiResult = { ok: true; text: string; truncated?: boolean } | { ok: false; reason: 'no_key' | 'cooldown' | 'quota' | 'auth' | 'error'; detail?: string };

let cooldownUntil = 0;
let cooldownReason: 'quota' | 'auth' | 'error' = 'error';

/** Env values often arrive with stray whitespace / quotes (`.env`, Vercel UI paste) — normalise before use. */
const clean = (v: string | undefined) => (v ?? '').trim().replace(/^["']|["']$/g, '').trim();
export const geminiKey = () => clean(process.env.GEMINI_API_KEY);
export const geminiModel = () => clean(process.env.GEMINI_MODEL).replace(/^models\//, '') || 'gemini-2.5-flash';
export const geminiConfigured = () => Boolean(geminiKey());

/** Pull `error.message` out of a Gemini error body so the UI / logs show the real cause. */
const apiDetail = (body: string, status: number) => {
  try {
    const m = JSON.parse(body)?.error?.message;
    if (typeof m === 'string' && m) return `HTTP ${status}: ${m.slice(0, 140)}`;
  } catch {}
  return 'HTTP ' + status;
};

interface Opts {
  system?: string;
  prompt: string;
  /** base64 images / PDFs sent as inlineData parts (vision) */
  images?: { mimeType: string; data: string }[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

/** 2048 output tokens: long, structured analyst answers must finish instead of stopping mid-sentence */
export const DEFAULT_MAX_TOKENS = 2048;

export async function callGemini({ system, prompt, images, json, maxTokens = DEFAULT_MAX_TOKENS, temperature = 0.3 }: Opts): Promise<GeminiResult> {
  const key = geminiKey();
  if (!key) return { ok: false, reason: 'no_key' };
  // after a quota / auth / outage response, stop calling for a while so the local fallback serves traffic
  if (Date.now() < cooldownUntil) return { ok: false, reason: 'cooldown', detail: cooldownReason };

  const model = geminiModel();
  const trip = (reason: 'quota' | 'auth' | 'error', ms: number, detail: string): GeminiResult => {
    cooldownUntil = Date.now() + ms;
    cooldownReason = reason;
    console.error(`[gemini] ${model} ${reason}: ${detail}`);
    return { ok: false, reason, detail };
  };

  try {
    // GEMINI_API_BASE exists so the quota / outage fallback can be tested against a mock server
    const base = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
    const body = JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }, ...(images ?? []).map((im) => ({ inlineData: { mimeType: im.mimeType, data: im.data } }))] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
    });
    const send = () =>
      fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: AbortSignal.timeout(images?.length ? 28_000 : 24_000), // a full 2048-token answer can take ~15 s
      });
    // one quick retry for transient 5xx / network blips (Gemini 503 "overloaded" is common)
    let res: Response;
    try {
      res = await send();
      if (res.status >= 500) res = await send();
    } catch {
      res = await send();
    }

    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      return trip('quota', Math.min(10 * 60_000, Math.max(30_000, (Number.isFinite(retry) ? retry : 60) * 1000)), 'HTTP 429');
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403 || (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(errBody))) return trip('auth', 10 * 60_000, apiDetail(errBody, res.status));
      if (/RESOURCE_EXHAUSTED/.test(errBody)) return trip('quota', 60_000, 'RESOURCE_EXHAUSTED');
      return trip('error', 15_000, apiDetail(errBody, res.status));
    }
    const data = await res.json();
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('');
    if (!text?.trim()) return trip('error', 15_000, 'empty response (possibly blocked by safety filters)');
    return { ok: true, text: text.trim(), truncated: data?.candidates?.[0]?.finishReason === 'MAX_TOKENS' };
  } catch (e) {
    return trip('error', 15_000, e instanceof Error ? e.message : 'network error');
  }
}
