'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { currentPushEndpoint, syncPushDevice } from '@/lib/pushNotifications';
import { describeDevice, isStandalone } from '@/lib/deviceLabel';

type Dev = { id: string | null; label: string; platform: string | null; addedAt: string | null; tail: string; usable: boolean };
type Status = { ok: boolean; error?: string; devices?: number; deviceList?: Dev[]; push?: { configured: boolean; note?: string }; email?: { configured: boolean; to?: string; note?: string }; kinds?: string[] };
const KIND_LABEL: Record<string, string> = { price_above: 'price crossings', price_below: 'price crossings', pct_up: '% move', pct_down: '% move', volume_surge: 'volume surges', order_imbalance_above: 'order-book imbalance', order_imbalance_below: 'order-book imbalance', circuit_proximity: 'circuit proximity' };

/** Settings → Alerts: live readiness of the two delivery channels for frequent alerts (Chrome Web Push + e-mail), with clear inline status. */
export function AlertChannelsStatus() {
  const { getToken, user } = useAuth();
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<string | null>(null);              // tail of THIS browser's push endpoint
  const [note, setNote] = useState('');
  const here = typeof navigator === 'undefined' ? null : describeDevice(navigator.userAgent, isStandalone());
  const load = useCallback(async () => {
    const token = await getToken().catch(() => null);
    if (!token) return setSt({ ok: false, error: 'Sign in with an account to use push and e-mail alerts.' });
    setBusy(true);
    await syncPushDevice(token);                                       // auto-register this browser before reading the device list
    setMine((await currentPushEndpoint())?.slice(-12) ?? null);
    try {
      const r = await fetch('/api/alerts/push', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      setSt((await r.json().catch(() => ({ ok: false, error: `Server answered ${r.status}.` }))) as Status);
    } catch {
      setSt({ ok: false, error: 'Could not reach the server.' });
    }
    setBusy(false);
  }, [getToken]);
  useEffect(() => { void load(); }, [load, user?.id]);

  const remove = async (d: Dev) => {
    if (!d.id) return;
    const token = await getToken().catch(() => null);
    if (!token) return;
    setNote('');
    const r = await fetch('/api/alerts/push', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.id }) }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!r?.ok || !j?.ok) return setNote(j?.error ?? 'Could not remove this device.');
    if (mine && d.tail === mine) { try { const reg = await navigator.serviceWorker.getRegistration(); await (await reg?.pushManager.getSubscription())?.unsubscribe(); } catch { /* already gone */ } }
    setNote(`Removed ${d.label}.`);
    void load();
  };
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
      {st?.ok ? (
        <div className="mt-3" data-testid="device-list-wrap">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted">Your devices ({st.deviceList?.length ?? 0})</h4>
          {st.deviceList?.length ? (
            <ul className="mt-1.5 divide-y divide-line rounded-md border border-line" data-testid="device-list">
              {st.deviceList.map((d) => (
                <li key={d.id ?? d.tail} className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]" data-testid="device-row" data-device={d.label}>
                  <span className="min-w-0">
                    <b className="text-ink">{d.label}</b>
                    {mine && d.tail === mine ? <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold text-accent" data-testid="device-this">This device</span> : null}
                    {!d.usable ? <span className="ml-1.5 text-down">· invalid subscription</span> : null}
                    <span className="block text-muted">{d.addedAt ? `added ${new Date(d.addedAt).toLocaleDateString()}` : 'added earlier'}</span>
                  </span>
                  <button type="button" disabled={!d.id} onClick={() => void remove(d)} data-testid="device-remove" aria-label={`Remove ${d.label}`} className="shrink-0 rounded border border-down/40 px-2 py-0.5 text-[11px] font-semibold text-down hover:bg-down/10 disabled:opacity-40">Remove</button>
                </li>
              ))}
            </ul>
          ) : <p className="mt-1 text-[12px] text-muted" data-testid="device-empty">No device registered yet{here ? ` — this one is ${here.label}` : ''}.</p>}
          {note ? <p role="status" data-testid="device-note" className="mt-1.5 text-[12px] text-muted">{note}</p> : null}
        </div>
      ) : null}
      <details className="mt-3 rounded-md border border-line bg-bg/40 px-3 py-2 text-[12px] text-muted" data-testid="mobile-guide" open={Boolean(here?.mobile)}>
        <summary className="cursor-pointer font-semibold text-ink">Get alerts on your phone — no app store</summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-4">
          <li><b className="text-ink">Android · Chrome:</b> open UpCircuit in Chrome, sign in, switch on <i>Web Push Notifications</i> above and allow notifications. This phone appears in the list and alerts arrive on the lock screen like any app. (Menu → <i>Install app</i> adds an icon too.)</li>
          <li><b className="text-ink">iPhone · Safari:</b> tap <i>Share</i> → <i>Add to Home Screen</i>, open UpCircuit from that icon (iOS only delivers push to the installed Home Screen app), sign in and switch on <i>Web Push Notifications</i>.</li>
          <li>Each device you enable is registered to your account; every alert goes to <b className="text-ink">all</b> of them at once, plus e-mail when configured. Remove a lost or old phone with its <i>Remove</i> button.</li>
        </ol>
      </details>
    </section>
  );
}
