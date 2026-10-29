// AI output governance: provenance fields recorded with every human sign-off (model, prompt revision, data used, SHA-256 of the exact text).
import type { CopilotContext } from './copilot';
export const PROMPT_VERSION = 'copilot-2026.10';

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Which data classes were actually in the prompt context (so a reviewer knows what the AI could and could not see). */
export function dataUsed(ctx: Partial<CopilotContext> | null | undefined, headlines = true): string[] {
  const out: string[] = [];
  if (ctx?.price) out.push(ctx.simulated ? 'price (simulated)' : 'live price');
  if (ctx?.ratios && Object.values(ctx.ratios).some((v) => v !== null && v !== undefined)) out.push('fundamentals');
  if (ctx?.technicals && (ctx.technicals.rsi !== null || ctx.technicals.sma50 !== null)) out.push('technicals');
  if (headlines) out.push('news headlines');
  return out;
}
export const SIGNOFF_DECISIONS = ['approved', 'rejected'] as const;
