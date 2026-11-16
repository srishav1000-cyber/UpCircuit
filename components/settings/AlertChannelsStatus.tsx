'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { syncPushDevice } from '@/lib/pushNotifications';

type Status = { ok: boolean; error?: string; devices?: number; push?: { configured: boolean; note?: string }; email?: { configured: boolean; to?: string; note?: string }; kinds?: string[] };
const KIND_LABEL: Record<string, string> = { price_above: 'price crossings', price_below: 'price crossings', pct_up: '% move', pct_down: '% move', volume_surge: 'volume surges', order_imbalance_above: 'order-book imbalance', order_imbalance_below: 'order-book imbalance', circuit_proximity: 'circuit proximity' };

/** Settings → Alerts: live readiness of the two delivery channels for frequent alerts (Chrome Web Push + e-mail), with clear inline status. */
export function AlertChannelsStatus() {
  const { getToken, user } = useAuth();
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const token = await getToken().catch(() => null);
    if (!token) return setSt({ ok: false, error: 'Sign in with an account to use push and e-mail alerts.' });
    setBusy(true);
    await syncPushDevice(token);                                       // auto-register this browser before reading the device list
    try {
      const r = await fetch('/api/alerts/push', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      setSt((await r.json().catch(() => ({ ok: false, error: `Server answered ${r.status}.` }))) as Status);
    } catch {
      setSt({ ok: false, error: 'Could not reach the server.' });
    }
    setBusy(false);
  }, [getToken]);
  useEffect(() => { void load(); }, [load, user?.id]);

  const kinds = Array.from(new Set((st?.kinds ?? []).map((k) => KIND_LABEL[k] ?? k)));
  const Row = ({ ok, label, detail, id }: { ok: boolean | null; label: string; detail: string; id: string }) => (
    <li className="flex items-start gap-2 text-[12px]" data-testid={id} data-ok={String(ok)}>
      <span aria-hidden className={`mt-1 h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-up' : ok === false ? 'bg-down' : 'bg-muted'}`} />
      <span><b className="text-ink">{label}</b> <span className="text-muted">— {detail}</span></span>
    </li>
  );
  return (
    <section className="rounded-lg border border-line bg-panel p-4" data-testid="alert-channels">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted">Alert channels</h3>
        <button type="button" onClick={() => void load()} disabled={busy} data-testid="alert-channels-refresh" className="rounded border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-line disabled:opacity-50">{busy ? 'Checking…' : 'Refresh'}</button>
      </div>
      <p className="mt-1 text-[12px] text-muted">Frequent alerts ({kinds.length ? kinds.join(', ') : 'price crossings, % move, volume surges, order-book imbalance, circuit proximity'}) are delivered to every channel you tick on a rule — Chrome Web Push and e-mail.</p>
      {st && !st.ok ? <p role="alert" data-testid="alert-channels-error" className="mt-2 rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{st.error ?? 'Could not load channel status.'}</p> : null}
      {st?.ok ? (
        <ul className="mt-2 space-y-1.5">
          <Row id="ch-push" ok={Boolean(st.push?.configured) && (st.devices ?? 0) > 0} label="Chrome Web Push" detail={!st.push?.configured ? st.push?.note ?? 'not configured on the server' : (st.devices ?? 0) > 0 ? `${st.devices} device${st.devices === 1 ? '' : 's'} registered` : 'no device registered yet — switch on Web Push Notifications above'} />
          <Row id="ch-email" ok={Boolean(st.email?.configured)} label="E-mail (Resend)" detail={st.email?.configured ? `delivering to ${st.email.to ?? 'your account e-mail'}` : st.email?.note ?? 'RESEND_API_KEY is not set on the server — e-mail alerts are disabled'} />
        </ul>
      ) : null}
    </section>
  );
}
