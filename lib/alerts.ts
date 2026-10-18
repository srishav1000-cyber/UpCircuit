/** Price alerts: pure logic (UI state lives in hooks/usePriceAlerts.ts). Alerts fire only while the app is open. */

export interface PriceAlert {
  id: string;
  symbol: string;
  target: number;
  /** side of the price at creation: fire when LTP reaches/crosses the target in that direction */
  dir: 'above' | 'below';
  createdAt: number;
  triggeredAt?: number;
  triggeredPrice?: number;
}

export const MAX_ALERTS = 50;

export type AddResult = { ok: true; alerts: PriceAlert[]; alert: PriceAlert } | { ok: false; error: string };

export function addAlert(alerts: PriceAlert[], symbol: string, target: number, ltp: number, now = Date.now()): AddResult {
  if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'Enter a price greater than 0.' };
  if (!Number.isFinite(ltp) || ltp <= 0) return { ok: false, error: 'No live price for this symbol yet.' };
  const t = Math.round(target * 100) / 100;
  if (Math.abs(t - ltp) < 0.005) return { ok: false, error: 'Target equals the current price — pick a different level.' };
  const dir: PriceAlert['dir'] = t > ltp ? 'above' : 'below';
  if (alerts.some((a) => !a.triggeredAt && a.symbol === symbol && a.target === t && a.dir === dir)) return { ok: false, error: 'You already have this alert.' };
  if (alerts.filter((a) => !a.triggeredAt).length >= MAX_ALERTS) return { ok: false, error: `Limit of ${MAX_ALERTS} active alerts reached.` };
  const alert: PriceAlert = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, symbol, target: t, dir, createdAt: now };
  return { ok: true, alerts: [alert, ...alerts], alert };
}

/** Marks alerts whose condition is met; returns the updated list and the alerts that just fired. */
export function checkAlerts(alerts: PriceAlert[], ltpOf: (symbol: string) => number | undefined, now = Date.now()): { alerts: PriceAlert[]; fired: PriceAlert[] } {
  const fired: PriceAlert[] = [];
  const next = alerts.map((a) => {
    if (a.triggeredAt) return a;
    const p = ltpOf(a.symbol);
    if (p === undefined || !Number.isFinite(p)) return a;
    if ((a.dir === 'above' && p >= a.target) || (a.dir === 'below' && p <= a.target)) {
      const hit = { ...a, triggeredAt: now, triggeredPrice: p };
      fired.push(hit);
      return hit;
    }
    return a;
  });
  return fired.length ? { alerts: next, fired } : { alerts, fired };
}

/** Defensive parse of whatever is in storage. */
export function parseAlerts(raw: string | null): PriceAlert[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    return j
      .filter((a) => a && typeof a.id === 'string' && typeof a.symbol === 'string' && a.symbol.length <= 24 && Number.isFinite(a.target) && a.target > 0 && (a.dir === 'above' || a.dir === 'below'))
      .map((a) => ({ id: a.id, symbol: a.symbol, target: a.target, dir: a.dir, createdAt: Number(a.createdAt) || 0, ...(Number.isFinite(a.triggeredAt) ? { triggeredAt: a.triggeredAt, triggeredPrice: Number(a.triggeredPrice) || undefined } : {}) }))
      .slice(0, 100);
  } catch {
    return [];
  }
}
