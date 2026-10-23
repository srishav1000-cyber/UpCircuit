'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/hooks/useAuth';
import { useCloud } from '@/hooks/useCloud';
import { useNotify } from '@/hooks/useNotify';
import { useDismiss } from '@/hooks/useClickOutside';
import { usePushToggle } from '@/hooks/usePushToggle';
import { LandingPicker, SettingsModal, SoundPicker, Toggle, downloadBackup, useForceSync, type SettingsTab } from '@/components/SettingsModal';
import { maskPhone, planOf } from '@/lib/auth';
import { smartApiStatus, type FeedConn, type FeedMode, type LiveReason } from '@/lib/market';
import { getSync, serverSync, subscribeSync, syncLabel } from '@/lib/syncStatus';
import { cleanBeforeSignOut } from '@/lib/signOutClean';
import { disablePush } from '@/lib/pushNotifications';
import { scoped } from '@/lib/scope';
import { testChime } from '@/lib/audioAlerts';

const item = 'block w-full px-3 py-1.5 text-left text-ink hover:bg-line';
const sec = 'border-t border-line px-3 py-2';
const cap = 'mb-1 text-[10px] font-bold uppercase tracking-wider text-muted';

/** Header avatar → account control centre (identity, sync status, quick alert / startup controls, feed status, exports, plans, sign-out). */
export function ProfilePopover({ mode, conn, liveReason, onPlans }: { mode: FeedMode; conn: FeedConn; liveReason?: LiveReason; onPlans?: () => void }) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<SettingsTab | null>(null);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  useEffect(() => setMounted(true), []);
  const { user, signOut, required, getToken, backend } = useAuth();
  const { cloud, userId } = useCloud();
  const { prefs, set } = useNotify();
  const push = usePushToggle();
  const fs = useForceSync();
  const sync = useSyncExternalStore(subscribeSync, getSync, serverSync);
  const [csvMsg, setCsvMsg] = useState('');
  const [leaving, setLeaving] = useState(false);

  const exportTicks = async () => {
    setCsvMsg('Preparing…');
    try {
      const token = await getToken();
      const r = await fetch('/api/market/export-csv', { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        return setCsvMsg(j.message ?? 'No ticks available yet.');
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'upcircuit-ticks.csv';
      a.click();
      URL.revokeObjectURL(url);
      setCsvMsg('');
    } catch {
      setCsvMsg('Export failed.');
    }
  };

  const logout = async () => {
    setLeaving(true);
    if (user && cloud && userId) {
      await cleanBeforeSignOut({ cloud, userId, read: (b) => localStorage.getItem(scoped(b)), prefs, store: localStorage, removePush: () => disablePush(cloud, userId) });
    }
    await signOut();
  };

  const email = user?.email ?? '';
  const label = user?.name ?? email ?? user?.phone ?? 'U';
  const initials = (label.split('@')[0] || 'U').slice(0, 2).toUpperCase();
  const plan = planOf(user?.plan);
  const feed = smartApiStatus({ mode, conn, reason: liveReason });
  const cloudAccount = backend === 'supabase' && !!user && user.id !== 'guest';
  const openSettings = (t: SettingsTab) => { setOpen(false); setModal(t); };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" data-testid="account-menu" className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/20 text-[12px] font-bold text-accent ring-1 ring-accent/50 hover:bg-accent/30">
        {user?.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatar} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        ) : (
          initials
        )}
      </button>
      {open && (
        <div role="menu" data-testid="profile-popover" className="absolute right-0 top-full z-50 mt-2 max-h-[min(80vh,640px)] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-md border border-line bg-panel py-1 text-[13px] shadow-2xl shadow-black/40">
          {/* header card */}
          <div className="px-3 py-2">
            <div className="truncate font-semibold text-ink" data-testid="account-email">{email || user?.name || 'Signed in'}</div>
            {user?.phone ? (
              <div className="text-[11px] text-muted" data-testid="account-phone">{maskPhone(user.phone)}{user.phoneVerified === false ? ' · unverified' : ''}</div>
            ) : (
              cloudAccount && (
                <button type="button" data-testid="account-link-mobile" onClick={() => openSettings('profile')} className="mt-1 inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-400 hover:bg-amber-500/25">⚠️ Link Mobile</button>
              )
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold text-accent" data-testid="account-plan">Tier {plan.tier} - {plan.name}</span>
              <span className="rounded bg-line px-1.5 py-0.5 text-[10px] font-semibold text-ink" data-testid="account-sync" data-state={sync.state}>{syncLabel(sync.state)}</span>
            </div>
          </div>

          <button role="menuitem" data-testid="account-settings" className={item} onClick={() => openSettings('profile')}>⚙ Account &amp; Profile Settings</button>

          {/* notification + alert preferences */}
          <div className={sec} data-testid="quick-alerts">
            <div className={cap}>Notifications &amp; alerts</div>
            <Toggle testid="quick-push" label="Web Push" on={push.on} disabled={push.busy || !push.supported} onChange={(v) => void push.toggle(v)} />
            <Toggle testid="quick-email" label="Email Circuit Alerts" on={prefs.email} disabled={!email} onChange={(v) => set({ email: v })} />
            {push.msg && <div role="status" data-testid="quick-push-msg" className={`pb-1 text-[11px] ${push.msg.kind === 'ok' ? 'text-up' : 'text-down'}`}>{push.msg.text}</div>}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-ink">Alarm sound</span>
              <span className="flex items-center gap-1">
                <SoundPicker compact />
                <button type="button" aria-label="Test alarm" title="Test the lower-circuit sound" data-testid="quick-sound-test" disabled={!prefs.audio} onClick={() => void testChime('lower', prefs.volume)} className="rounded border border-line px-1.5 py-1 text-[11px] text-muted hover:bg-line disabled:opacity-40">▶</button>
              </span>
            </div>
          </div>

          {/* startup screen */}
          <div className={`${sec} flex items-center justify-between gap-2`}>
            <span className="text-ink">Open on</span>
            <LandingPicker compact />
          </div>

          {/* data feed + cloud */}
          <div className={sec} data-testid="quick-feed">
            <div className={cap}>Data feed &amp; API</div>
            <div className="flex items-center gap-2" data-testid="account-feed" data-health={feed.health}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${feed.health === 'ok' ? 'bg-up' : feed.health === 'warn' ? 'bg-amber-400' : 'bg-muted'}`} aria-hidden />
              <span className="font-semibold text-ink">SmartAPI · {feed.label}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted">Rate limit: N/A — SmartAPI streams ticks over one WebSocket and reports no quota to the browser. Reconnects back off 1 s → 2 s → 4 s.</div>
            <button type="button" role="menuitem" data-testid="account-force-sync" disabled={fs.busy || !fs.canSync} onClick={() => void fs.run()} className="mt-2 w-full rounded-md border border-line px-3 py-1.5 text-left text-ink hover:bg-line disabled:opacity-50">{fs.busy ? '⟳ Syncing…' : '⟳ Force Sync Cloud State'}</button>
            {fs.msg && <div role="status" data-testid="account-sync-msg" className={`pt-1 text-[11px] ${fs.msg.kind === 'ok' ? 'text-up' : 'text-down'}`}>{fs.msg.text}</div>}
            {!fs.canSync && <div className="pt-1 text-[11px] text-muted">Local cache only — sign in with a Supabase account to sync.</div>}
          </div>

          {/* exports + plans */}
          <div className="border-t border-line py-1">
            <button role="menuitem" data-testid="account-export-ticks" className={item} onClick={() => void exportTicks()}>⬇ Export session ticks (CSV)</button>
            {csvMsg && <div className="px-3 pb-1 text-[11px] text-muted" data-testid="account-export-msg">{csvMsg}</div>}
            <button role="menuitem" data-testid="account-export-backup" className={item} onClick={() => user && downloadBackup({ id: user.id, email: user.email, phone: user.phone }, prefs)}>⬇ Export Portfolio &amp; Watchlist Backup (JSON)</button>
            <button role="menuitem" data-testid="account-plans" className={item} onClick={() => { close(); onPlans?.(); }}>💳 Plans &amp; upgrade</button>
          </div>
          {required && (
            <button role="menuitem" data-testid="account-logout" disabled={leaving} className="block w-full border-t border-line px-3 py-1.5 text-left text-down hover:bg-line disabled:opacity-60" onClick={() => void logout()}>{leaving ? 'Signing out…' : 'Sign out'}</button>
          )}
        </div>
      )}
      {mounted && modal && createPortal(<SettingsModal initialTab={modal} onClose={() => setModal(null)} onPlans={onPlans ? () => { setModal(null); onPlans(); } : undefined} />, document.body)}
    </div>
  );
}
