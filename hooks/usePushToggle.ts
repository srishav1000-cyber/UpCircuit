'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCloud } from '@/hooks/useCloud';
import { useNotify } from '@/hooks/useNotify';
import { currentPushEndpoint, disablePush, enablePush, pushConfigured, pushSupported } from '@/lib/pushNotifications';

/** Web Push on/off for THIS device (shared by the profile popover and Settings): subscribes / unsubscribes and records the device in the account. */
export function usePushToggle() {
  const { cloud, userId } = useCloud();
  const { prefs, set } = useNotify();
  const [device, setDevice] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState<string>('default');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!pushSupported()) return setDevice('off');
    setPerm(Notification.permission);
    void currentPushEndpoint().then((e) => setDevice(e && Notification.permission === 'granted' ? 'on' : 'off'));
  }, []);

  const toggle = useCallback(
    async (on: boolean) => {
      setMsg(null);
      if (!on) {
        setBusy(true);
        await disablePush(cloud, userId);
        set({ push: false });
        setDevice('off');
        setBusy(false);
        return setMsg({ kind: 'ok', text: 'Push notifications are off for this device.' });
      }
      if (!cloud || !userId) return setMsg({ kind: 'err', text: 'Push notifications need a Supabase account (sign in with e-mail, Google or phone).' });
      setBusy(true);
      const r = await enablePush(cloud, userId);
      setBusy(false);
      if (!r.ok) {
        if (pushSupported()) setPerm(Notification.permission);
        return setMsg({ kind: 'err', text: r.error });
      }
      set({ push: true });
      setDevice('on');
      setPerm('granted');
      setMsg({ kind: 'ok', text: 'Push notifications are on — circuit alerts will reach this device.' });
    },
    [cloud, userId, set],
  );

  const hint = !pushSupported() ? 'Not supported in this browser (on iPhone, install UpCircuit to the Home Screen first).' : !pushConfigured() ? 'Not configured on this deployment (VAPID keys missing).' : perm === 'denied' ? 'Blocked in your browser — allow notifications for this site, then switch on.' : prefs.push && device === 'off' ? 'Enabled on your account but not on this device — switch on to subscribe it.' : 'Circuit-limit alerts pushed to your phone, even from another device’s terminal.';
  return { on: prefs.push && device === 'on', busy, supported: pushSupported(), hint, msg, toggle };
}
