import { callGemini, geminiConfigured } from '@/lib/gemini';
import { allow } from '@/lib/ttlCache';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const PROMPT =
  'Extract the stock holdings table from the attached broker statement / screenshot. ' +
  'Return ONLY a JSON array of objects {"symbol": string, "quantity": integer, "buy_price": number}. ' +
  'symbol = the NSE trading symbol in upper case (e.g. RELIANCE, TCS, HDFCBANK; strip suffixes like -EQ); ' +
  'quantity = number of shares held; buy_price = AVERAGE BUY PRICE / average cost per share in rupees (not LTP, not current value). ' +
  'Skip rows you cannot read with confidence and never guess or invent values. Return [] if there is no holdings table.';

/**
 * POST /api/parse-portfolio  { images: [{ mimeType, data(base64) }] }
 * LLM-vision extraction of [symbol, quantity, buy_price]. Always answers 200: { ok:false, reason } tells the client
 * to fall back to in-browser OCR (no key / quota / outage). The upload is only sent when the user asks for it.
 */
export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
  if (!allow('parse:' + ip, 8, 60_000)) return json({ error: 'Too many requests — wait a minute.' }, 429);

  let body: { images?: { mimeType?: string; data?: string }[] };
  try {
    const raw = await req.text();
    if (raw.length > 4_000_000) return json({ error: 'Image too large (max ~3 MB after compression).' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }
  const images = (body.images ?? []).slice(0, 3).filter((i) => typeof i?.data === 'string' && /^image\/(png|jpeg|webp)$/.test(i.mimeType ?? '')) as { mimeType: string; data: string }[];
  if (images.length === 0) return json({ error: 'No valid image supplied.' }, 400);

  if (!geminiConfigured()) return json({ ok: false, reason: 'no_key' });
  const g = await callGemini({ prompt: PROMPT, images, json: true, maxTokens: 2000, temperature: 0 });
  if (!g.ok) return json({ ok: false, reason: g.reason, detail: g.detail });

  try {
    const parsed = JSON.parse(g.text.replace(/^```(?:json)?|```$/g, '').trim());
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.holdings) ? parsed.holdings : [];
    const rows = arr
      .map((r: { symbol?: unknown; quantity?: unknown; buy_price?: unknown }) => ({ symbol: String(r.symbol ?? '').toUpperCase().replace(/-EQ$/, '').trim(), quantity: Number(r.quantity), buy_price: Number(r.buy_price) }))
      .filter((r: { symbol: string; quantity: number; buy_price: number }) => /^[A-Z0-9&-]{1,20}$/.test(r.symbol) && Number.isFinite(r.quantity) && Number.isFinite(r.buy_price))
      .slice(0, 100);
    return json({ ok: true, rows, source: 'gemini' });
  } catch {
    return json({ ok: false, reason: 'error', detail: 'unparseable model output' });
  }
}
