'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useCloud } from '@/hooks/useCloud';
import { currentPushEndpoint, pushConfigured, pushSupported } from '@/lib/pushNotifications';
import { fmtMs, stagesOf } from '@/lib/deliveryLatency';

type Check = { id: string; label: string; ok: boolean | null; hint?: string };
type Phase =
  | { k: 'idle' }
  | { k: 'sending' }
  | { k: 'sent'; deliveryId: string; sent: number; devices: number; startedAt: number }
  | { k: 'acked'; sent: number; devices: number; latencyMs: number | null; ackMs: number | null }
  | { k: 'noack'; sent: number; devices: number }
  | { k: 'error'; text: string };

const POLL_MS = 1000;
const GIVE_UP_MS = 25_000;

/** Settings → Alerts: verifies the whole closed-app chain (VAPID keys → push service → service worker → ACK) with one real push. */
export function TestPushSection() {
  const { getToken } = useAuth();
  const { cloud } = useCloud();
  const [checks, setChecks] = useState<Check[]>([]);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);

  const refreshChecks = useCallback(async () => {
    const supported = pushSupported();
    const perm = supported ? Notification.permission : 'denied';
    const endpoint = supported ? await currentPushEndpoint() : null;
    setChecks([
      { id: 'browser', label: 'Browser supports web push', ok: supported, hint: supported ? undefined : 'On iPhone, add UpCircuit to the Home Screen first.' },
      { id: 'vapid', label: 'VAPID public key configured', ok: pushConfigured(), hint: pushConfigured() ? undefined : 'NEXT_PUBLIC_VAPID_PUBLIC_KEY is missing on this deployment.' },
      { id: 'perm', label: 'Notification permission granted', ok: perm === 'granted' ? true : perm === 'denied' ? false : null, hint: perm === 'denied' ? 'Blocked — allow notifications for this site in the browser settings.' : perm === 'default' ? 'Not asked yet — switch on Web Push Notifications above.' : undefined },
      { id: 'device', label: 'This device is subscribed', ok: !!endpoint && perm === 'granted', hint: endpoint ? undefined : 'Switch on Web Push Notifications above to register this device.' },
    ]);
  }, []);
  useEffect(() => {
    alive.current = true;
    void refreshChecks();
    return () => { alive.current = false; if (timer.current) clearInterval(timer.current); };
  }, [refreshChecks]);

  async function run() {
    if (timer.current) clearInterval(timer.current);
    setPhase({ k: 'sending' });
    void refreshChecks();
    const token = await getToken().catch(() => null);
    if (!token) return setPhase({ k: 'error', text: 'Sign in with an account (e-mail, Google or phone) to test push.' });
    let r: { ok?: boolean; error?: string; deliveryId?: string; sent?: number; devices?: number };
    try {
      const res = await fetch('/api/alerts/test', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      r = await res.json().catch(() => ({}));
      if (!res.ok && !r.error) r = { error: `Server answered ${res.status}.` };
    } catch {
      return setPhase({ k: 'error', text: 'Could not reach the server.' });
    }
    if (!r.ok || !r.deliveryId) return setPhase({ k: 'error', text: r.error ?? 'The test push was not sent.' });
    const startedAt = Date.now();
    const base = { sent: r.sent ?? 0, devices: r.devices ?? 0 };
    setPhase({ k: 'sent', deliveryId: r.deliveryId, startedAt, ...base });
    if (!cloud) return;
    timer.current = setInterval(async () => {
      if (!alive.current) return;
      const row = await cloud.getDelivery(r.deliveryId!).catch(() => null);
      if (row?.sw_ack_at) {
        if (timer.current) clearInterval(timer.current);
        const s = stagesOf(row);
        setPhase({ k: 'acked', ...base, latencyMs: s.pushToDisplayMs, ackMs: s.pushToAckMs });
      } else if (Date.now() - startedAt > GIVE_UP_MS) {
        if (timer.current) clearInterval(timer.current);
        setPhase({ k: 'noack', ...base });
      }
    }, POLL_MS);
  }

  const busy = phase.k === 'sending' || phase.k === 'sent';
  const Icon = ({ ok }: { ok: boolean | null }) => (ok === true ? <CheckCircle2 size={14} className="text-up" aria-hidden /> : ok === false ? <XCircle size={14} className="text-down" aria-hidden /> : <CircleDashed size={14} className="text-muted" aria-hidden />);
  return (
    <section className="rounded-xl border border-line bg-bg/60 p-4 backdrop-blur-md" data-testid="settings-testpush" aria-label="Test push notification">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted">Closed-app alert check</h3>
      <p className="mt-1 text-[12px] text-muted">Sends one real push to every device on your account and waits for the device to confirm it displayed it — the same path live rule alerts use.</p>
      <ul className="mt-3 space-y-1.5" data-testid="testpush-checks">
        {checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-[12px] text-ink" data-testid={`testpush-check-${c.id}`} data-ok={String(c.ok)}>
            <span className="mt-0.5"><Icon ok={c.ok} /></span>
            <span>{c.label}{c.hint && <span className="block text-muted">{c.hint}</span>}</span>
          </li>
        ))}
      </ul>
      <button type="button" data-testid="testpush-send" disabled={busy} onClick={() => void run()} className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-[12px] font-bold text-white hover:brightness-110 disabled:opacity-60">
        <BellRing size={14} aria-hidden /> {busy ? 'Waiting for the device…' : 'Send Test Push Notification'}
      </button>
      <div role="status" aria-live="polite" data-testid="testpush-result" className="mt-3 text-[12px]">
        {phase.k === 'sending' && <p className="text-muted">Sending…</p>}
        {phase.k === 'sent' && <p className="text-muted">Accepted by the push service for {phase.sent}/{phase.devices} device{phase.devices === 1 ? '' : 's'}. Waiting for a device to confirm it showed the notification…</p>}
        {phase.k === 'acked' && (
          <p className="rounded-md bg-up/10 px-3 py-2 text-up" data-testid="testpush-ok">
            Delivered and displayed on {phase.sent}/{phase.devices} device{phase.devices === 1 ? '' : 's'}.
            {phase.latencyMs !== null ? ` Push accepted → shown: ${fmtMs(phase.latencyMs)} (device clock).` : phase.ackMs !== null ? ` Push accepted → ACK received: ${fmtMs(phase.ackMs)}.` : ''}
          </p>
        )}
        {phase.k === 'noack' && <p className="rounded-md bg-warn/10 px-3 py-2 text-warn" data-testid="testpush-noack">The push service accepted it for {phase.sent}/{phase.devices} device(s), but no device confirmed within {GIVE_UP_MS / 1000} s. The device may be offline, the browser fully closed (desktop), or notifications are silenced by the OS.</p>}
        {phase.k === 'error' && <p role="alert" className="rounded-md bg-down/10 px-3 py-2 text-down" data-testid="testpush-error">{phase.text}</p>}
      </div>
    </section>
  );
}
