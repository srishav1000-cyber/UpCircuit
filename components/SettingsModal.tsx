'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useCloud } from '@/hooks/useCloud';
import { useNotify } from '@/hooks/useNotify';
import { usePushToggle } from '@/hooks/usePushToggle';
import { usePWA } from '@/components/PWAProvider';
import { OtpInput } from '@/components/AuthScreen';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ROLES, OTP_RE, canUse, maskPhone, normalizeIndianMobile, planFor, planOf } from '@/lib/auth';
import { backupFilename, buildBackup, forceSync, readSnapshot } from '@/lib/backup';
import { purgeUserCache } from '@/lib/signOutClean';
import { scoped } from '@/lib/scope';
import { testChime } from '@/lib/audioAlerts';
import { getSync, serverSync, subscribeSync, syncLabel } from '@/lib/syncStatus';
import { useSyncExternalStore } from 'react';

export type SettingsTab = 'profile' | 'alerts' | 'market' | 'cloud';
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'profile', label: 'Profile & Auth' },
  { id: 'alerts', label: 'Alert Channels' },
  { id: 'market', label: 'Market & Layout' },
  { id: 'cloud', label: 'Cloud & Data' },
];

const card = 'rounded-xl border border-line bg-bg/60 p-4';
const h2 = 'text-[11px] font-bold uppercase tracking-wider text-muted';
const btn = 'rounded-md border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-line disabled:opacity-50';
const primary = 'rounded-md bg-accent px-3 py-1.5 text-[12px] font-bold text-white hover:opacity-90 disabled:opacity-50';

export function Toggle({ on, onChange, label, hint, testid, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; testid: string; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} data-testid={testid} disabled={disabled} onClick={() => onChange(!on)} className={`relative h-7 w-12 shrink-0 rounded-full border transition ${on ? 'border-accent bg-accent/80' : 'border-line bg-line'} disabled:opacity-50`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-6' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options, label, testid }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; label: string; testid: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap overflow-hidden rounded-md border border-line">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} data-testid={`${testid}-${o.id}`} onClick={() => onChange(o.id)} className={`px-3 py-1.5 text-[12px] font-semibold ${value === o.id ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-line hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const initials = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';

/* ───────────── Profile & Auth ───────────── */

function PhoneLink() {
  const { user, backend, sendPhoneLink, confirmPhoneLink } = useAuth();
  const [editing, setEditing] = useState(false);
  const [digits, setDigits] = useState('');
  const [stage, setStage] = useState<'enter' | 'code'>('enter');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  if (!user) return null;
  const verified = !!user.phone && user.phoneVerified !== false;
  const e164 = normalizeIndianMobile(digits);

  const send = async () => {
    setErr('');
    setOk('');
    if (!e164) return setErr('Enter a valid 10-digit Indian mobile number (starts with 6–9).');
    setBusy(true);
    const r = await sendPhoneLink(e164);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setStage('code');
    setCode('');
    setWait(30);
  };
  const verify = async () => {
    setErr('');
    if (!e164) return setErr('Enter a valid 10-digit Indian mobile number.');
    if (!OTP_RE.test(code)) return setErr('Enter the 6-digit code.');
    setBusy(true);
    const r = await confirmPhoneLink(e164, code);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setOk(`Verified — ${maskPhone(r.user.phone ?? e164)} is linked to this account.`);
    setEditing(false);
    setStage('enter');
    setDigits('');
    setCode('');
  };

  return (
    <section className={card} data-testid="phone-link">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={h2}>Mobile number</h3>
        {verified ? <span className="rounded bg-up/15 px-1.5 py-0.5 text-[10px] font-bold text-up" data-testid="phone-verified">✓ VERIFIED</span> : <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-400" data-testid="phone-unverified">{user.phone ? '⚠ NOT VERIFIED' : '⚠ NOT LINKED'}</span>}
      </div>
      {user.phone && <div className="mt-1 text-sm text-ink" data-testid="phone-current">{maskPhone(user.phone)}</div>}
      {ok && <p role="status" data-testid="link-ok" className="mt-2 rounded-md bg-up/10 px-3 py-2 text-[12px] text-up">{ok}</p>}
      {backend !== 'supabase' ? (
        <p className="mt-2 text-[12px] text-muted">Linking a mobile number needs a Supabase account (this is a browser-only demo account).</p>
      ) : verified && !editing ? (
        <button type="button" className={`${btn} mt-2`} data-testid="phone-change" onClick={() => { setEditing(true); setOk(''); }}>Change number</button>
      ) : (
        <div className="mt-3 space-y-2">
          {stage === 'enter' ? (
            <div className="flex gap-2">
              <span className="flex items-center rounded-md border border-line px-2 text-[12px] text-muted">🇮🇳 +91</span>
              <input data-testid="link-phone" inputMode="numeric" autoComplete="tel-national" maxLength={14} placeholder="10-digit mobile number" value={digits} onChange={(e) => setDigits(e.target.value.replace(/[^\d\s-]/g, ''))} className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-sm text-ink outline-none focus:border-accent" />
              <button type="button" className={primary} disabled={busy} data-testid="link-send" onClick={() => void send()}>{busy ? 'Sending…' : 'Send OTP'}</button>
            </div>
          ) : (
            <div data-testid="link-otp-block" className="space-y-2">
              <div className="text-[12px] text-muted">Enter the 6-digit code sent to {e164 ? maskPhone(e164) : 'your number'}.</div>
              <OtpInput value={code} onChange={setCode} testid="link-otp" />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={primary} disabled={busy} data-testid="link-verify" onClick={() => void verify()}>{busy ? 'Verifying…' : 'Verify & link'}</button>
                <button type="button" className={btn} disabled={wait > 0 || busy} data-testid="link-resend" onClick={() => void send()}>{wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}</button>
                <button type="button" className={btn} data-testid="link-change" onClick={() => { setStage('enter'); setErr(''); }}>Edit number</button>
              </div>
            </div>
          )}
          {err && <p role="alert" data-testid="link-error" className="rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{err}</p>}
        </div>
      )}
    </section>
  );
}

function GoogleLink() {
  const { user, backend, linkGoogle } = useAuth();
  const [err, setErr] = useState('');
  if (!user) return null;
  const linked = !!user.providers?.includes('google');
  return (
    <section className={card} data-testid="google-link">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={h2}>Google</h3>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${linked ? 'bg-up/15 text-up' : 'bg-line text-muted'}`} data-testid="google-status">{linked ? '✓ LINKED' : 'NOT LINKED'}</span>
      </div>
      <p className="mt-1 text-[12px] text-muted">{linked ? 'You can sign in with “Continue with Google”.' : 'Link your Google account to sign in with one tap.'}</p>
      {!linked && backend === 'supabase' && (
        <button type="button" className={`${btn} mt-2`} data-testid="link-google" onClick={async () => { setErr(''); const r = await linkGoogle('/settings'); if (r.error && !/Redirecting/.test(r.error)) setErr(r.error); }}>Link Google account</button>
      )}
      {!linked && backend !== 'supabase' && <p className="mt-2 text-[12px] text-muted">Needs a Supabase account.</p>}
      {err && <p role="alert" data-testid="google-error" className="mt-2 rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{err}</p>}
    </section>
  );
}

function ProfileTab() {
  const { user, update, signOut, backend } = useAuth();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  if (!user) return null;
  const plan = planOf(user.plan);
  const name = user.name ?? user.email ?? user.phone ?? 'Account';
  return (
    <div className="space-y-4">
      <section className={card} data-testid="settings-profile">
        <div className="flex items-center gap-4">
          {user.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatar} alt="" referrerPolicy="no-referrer" className="h-16 w-16 rounded-full border border-line object-cover" data-testid="settings-avatar" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/20 text-xl font-bold text-accent ring-1 ring-accent/50" data-testid="settings-avatar">{initials(name)}</div>
          )}
          <div className="min-w-0">
            {user.name && <div className="truncate text-lg font-bold text-ink" data-testid="settings-name">{user.name}</div>}
            <div className="truncate text-sm text-ink" data-testid="settings-email">{user.email || 'No e-mail on this account'}</div>
            <div className="truncate text-sm text-muted" data-testid="settings-phone">{user.phone ?? 'No phone number'}</div>
          </div>
        </div>
        <div className="mt-3 text-[12px] text-muted" data-testid="settings-plan">Plan: Tier {plan.tier} · {plan.name} · {backend === 'supabase' ? 'synced to your account' : 'demo account (this browser only)'}</div>
      </section>

      <PhoneLink />
      <GoogleLink />

      <section className={card} data-testid="settings-role">
        <h3 className={h2}>Default primary role</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Default primary role">
          {ROLES.map((r) => {
            const ok = canUse(user.plan, r.id);
            const active = user.role === r.id;
            return (
              <button key={r.id} type="button" role="radio" aria-checked={active} disabled={!ok} data-testid={`settings-role-${r.id}`} title={ok ? r.blurb : `Needs the ${planFor(r.id).name} plan`} onClick={async () => { setMsg(null); const x = await update({ role: r.id }); setMsg(x.ok ? { kind: 'ok', text: 'Default role saved.' } : { kind: 'err', text: x.error }); }} className={`rounded-lg border px-3 py-2.5 text-left text-sm transition ${!ok ? 'cursor-not-allowed border-line text-muted opacity-50' : active ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink hover:bg-line'}`}>
                <span aria-hidden>{r.icon}</span> <b className="font-semibold">{r.label}</b>{!ok && ' 🔒'}
                <div className="text-[11px] text-muted">{r.blurb}</div>
              </button>
            );
          })}
        </div>
        {msg && <p role="status" data-testid="settings-role-msg" className={`mt-3 rounded-md px-3 py-2 text-[12px] ${msg.kind === 'ok' ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>{msg.text}</p>}
      </section>

      <button type="button" onClick={() => void signOut()} data-testid="settings-logout" className="rounded-lg border border-down/40 px-4 py-2 text-sm font-semibold text-down hover:bg-down/10">Log out</button>
    </div>
  );
}

/* ───────────── Alert Channels ───────────── */

export function SoundPicker({ compact }: { compact?: boolean }) {
  const { prefs, set } = useNotify();
  const val = !prefs.audio ? 'mute' : prefs.sound === 'arpeggio' ? 'arpeggio' : 'default';
  const pick = (v: 'default' | 'arpeggio' | 'mute') => (v === 'mute' ? set({ audio: false }) : set({ audio: true, sound: v }));
  if (compact)
    return (
      <select aria-label="Alarm sound" data-testid="quick-sound" value={val} onChange={(e) => pick(e.target.value as 'default' | 'arpeggio' | 'mute')} className="rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink">
        <option value="default">Default Siren</option>
        <option value="arpeggio">Arpeggio</option>
        <option value="mute">Mute</option>
      </select>
    );
  return <Segmented value={val} onChange={pick} label="Alarm sound" testid="sound" options={[{ id: 'default', label: 'Default Siren' }, { id: 'arpeggio', label: 'Arpeggio' }, { id: 'mute', label: 'Mute' }]} />;
}

function AlertsTab() {
  const { user } = useAuth();
  const { prefs, set } = useNotify();
  const push = usePushToggle();
  return (
    <div className="space-y-4">
      <section className={card} data-testid="settings-notifications">
        <h3 className={h2}>Channels</h3>
        <div className="divide-y divide-line">
          <Toggle testid="toggle-push" on={push.on} disabled={push.busy || !push.supported} onChange={(v) => void push.toggle(v)} label="Web Push Notifications" hint={push.hint} />
          <Toggle testid="toggle-email" on={prefs.email} onChange={(v) => set({ email: v })} label="Email Circuit Alerts" hint={user?.email ? `Sent to ${user.email} when a stock hits an upper or lower circuit.` : 'Add an e-mail address to receive these.'} disabled={!user?.email} />
          <Toggle testid="toggle-audio" on={prefs.audio} onChange={(v) => set({ audio: v })} label="Audio Alarm Chimes" hint="Siren for lower circuits, chime for upper circuits while the terminal is open." />
        </div>
        {push.msg && <p role="status" data-testid="settings-msg" className={`mt-3 rounded-md px-3 py-2 text-[12px] ${push.msg.kind === 'ok' ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>{push.msg.text}</p>}
      </section>
      <section className={card} data-testid="settings-sound">
        <h3 className={h2}>Alarm sound</h3>
        <div className="mt-2"><SoundPicker /></div>
        <p className="mt-2 text-[12px] text-muted">Default Siren: lower circuits sound the siren, upper circuits the chime. Arpeggio: the chime for both. Both are synthesised in your browser.</p>
        <label className="mt-3 block text-[12px] font-semibold text-ink" htmlFor="alert-volume">Siren volume · <span data-testid="volume-label">{Math.round(prefs.volume * 100)}%</span></label>
        <input id="alert-volume" data-testid="alert-volume" type="range" min={10} max={100} step={5} value={Math.round(prefs.volume * 100)} onChange={(e) => set({ volume: Number(e.target.value) / 100 })} className="mt-1 w-full accent-[var(--accent,#3b82f6)]" />
        <div className="mt-2 flex gap-2">
          <button type="button" className={btn} data-testid="test-lower" onClick={() => void testChime('lower', prefs.volume)}>▼ Test siren</button>
          <button type="button" className={btn} data-testid="test-upper" onClick={() => void testChime('upper', prefs.volume)}>▲ Test chime</button>
        </div>
      </section>
    </div>
  );
}

/* ───────────── Market & Layout ───────────── */

export function LandingPicker({ compact }: { compact?: boolean }) {
  const { prefs, set } = useNotify();
  if (compact)
    return (
      <select aria-label="Startup screen" data-testid="quick-landing" value={prefs.landing} onChange={(e) => set({ landing: e.target.value as 'home' | 'terminal' })} className="rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink">
        <option value="home">Discovery Hub</option>
        <option value="terminal">Terminal</option>
      </select>
    );
  return <Segmented value={prefs.landing} onChange={(v) => set({ landing: v })} label="Startup screen" testid="landing" options={[{ id: 'home', label: 'Discovery Hub' }, { id: 'terminal', label: 'Terminal' }]} />;
}

function MarketTab() {
  const { prefs, set } = useNotify();
  return (
    <div className="space-y-4">
      <section className={card} data-testid="settings-landing">
        <h3 className={h2}>Startup screen</h3>
        <div className="mt-2"><LandingPicker /></div>
        <p className="mt-2 text-[12px] text-muted">Where UpCircuit opens after you sign in. Saved to your account.</p>
      </section>
      <section className={card} data-testid="settings-appearance">
        <h3 className={h2}>Appearance</h3>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <div><div className="mb-1 text-[11px] text-muted">Theme (this device)</div><ThemeToggle /></div>
          <div>
            <div className="mb-1 text-[11px] text-muted">Density</div>
            <Segmented value={prefs.density} onChange={(v) => set({ density: v })} label="Density" testid="density" options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }]} />
          </div>
        </div>
      </section>
      <InstallCard />
    </div>
  );
}

function InstallCard() {
  const pwa = usePWA();
  return (
    <section className={card} data-testid="settings-install">
      <h3 className={h2}>Mobile app</h3>
      <p className="mt-2 text-[13px] text-ink">{pwa.installed ? 'UpCircuit is installed on this device.' : 'Install UpCircuit to your home screen for a full-screen app and background alerts.'}</p>
      {!pwa.installed && (
        <button type="button" disabled={!pwa.canInstall} onClick={() => void pwa.install()} data-testid="install-app" className={`${primary} mt-3`}>
          {pwa.canInstall ? 'Install app' : 'Install from your browser menu (Add to Home Screen)'}
        </button>
      )}
    </section>
  );
}

/* ───────────── Cloud & Data ───────────── */

/** shared by the popover and this tab: push this browser's cache to Supabase */
export function useForceSync() {
  const { user } = useAuth();
  const { cloud, userId } = useCloud();
  const { prefs } = useNotify();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const run = useCallback(async () => {
    if (!cloud || !userId || !user) return setMsg({ kind: 'err', text: 'Cloud sync needs a Supabase account — this session only has a local cache.' });
    setBusy(true);
    setMsg(null);
    const r = await forceSync(cloud, userId, readSnapshot((b) => localStorage.getItem(scoped(b))), prefs);
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: `Synced to Supabase${r.holdings !== null ? ` · ${r.holdings} holdings` : ''}${r.watchlistSymbols !== null ? ` · ${r.watchlistSymbols} watchlist symbols` : ''}.` } : { kind: 'err', text: `Could not sync: ${r.errors.join(', ')}. Your local copy is untouched — retry when online.` });
  }, [cloud, userId, user, prefs]);
  return { run, busy, msg, canSync: !!cloud };
}

export function downloadBackup(user: { id: string; email?: string; phone?: string }, prefs: Parameters<typeof buildBackup>[0]['prefs']): void {
  const file = buildBackup({ user, snap: readSnapshot((b) => localStorage.getItem(scoped(b))), prefs });
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFilename();
  a.click();
  URL.revokeObjectURL(url);
}

function CloudTab() {
  const { user } = useAuth();
  const { cloud, userId } = useCloud();
  const { prefs } = useNotify();
  const sync = useSyncExternalStore(subscribeSync, getSync, serverSync);
  const fs = useForceSync();
  const [confirm, setConfirm] = useState<'' | 'cache' | 'cloud'>('');
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState('');
  if (!user) return null;
  const last = sync.lastOkAt ? new Date(sync.lastOkAt).toLocaleTimeString() : null;

  const resetCache = () => {
    purgeUserCache(localStorage, user.id);
    setMsg('Local cache cleared — reloading from your account…');
    setTimeout(() => window.location.reload(), 600);
  };
  const resetCloud = async () => {
    if (!cloud || !userId) return;
    try {
      await cloud.resetAccountData(userId);
      purgeUserCache(localStorage, user.id);
      setMsg('Cloud data deleted — reloading…');
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setMsg('Could not delete cloud data — nothing was changed.');
    }
  };

  return (
    <div className="space-y-4">
      <section className={card} data-testid="settings-cloud">
        <h3 className={h2}>Persistence</h3>
        <div className="mt-2 text-sm font-semibold text-ink" data-testid="cloud-status" data-state={sync.state}>{syncLabel(sync.state)}</div>
        <p className="mt-1 text-[12px] text-muted">{cloud ? `Holdings, watchlists, focus basket and settings are stored in your Supabase account${last ? ` · last successful sync ${last}` : ''}.` : 'This account keeps data in this browser only. Sign in with e-mail, Google or phone (Supabase) to sync across devices.'}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={primary} disabled={fs.busy || !fs.canSync} data-testid="cloud-force-sync" onClick={() => void fs.run()}>{fs.busy ? 'Syncing…' : 'Force Sync Cloud State'}</button>
          <button type="button" className={btn} data-testid="cloud-backup" onClick={() => downloadBackup({ id: user.id, email: user.email, phone: user.phone }, prefs)}>⬇ Export Portfolio &amp; Watchlist Backup (JSON)</button>
        </div>
        {fs.msg && <p role="status" data-testid="cloud-msg" className={`mt-3 rounded-md px-3 py-2 text-[12px] ${fs.msg.kind === 'ok' ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>{fs.msg.text}</p>}
      </section>
      <section className={card} data-testid="settings-reset">
        <h3 className={h2}>Reset</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={btn} data-testid="reset-cache" onClick={() => setConfirm(confirm === 'cache' ? '' : 'cache')}>Clear this device’s cache</button>
          {cloud && <button type="button" className="rounded-md border border-down/40 px-3 py-1.5 text-[12px] font-semibold text-down hover:bg-down/10" data-testid="reset-cloud" onClick={() => { setConfirm(confirm === 'cloud' ? '' : 'cloud'); setTyped(''); }}>Delete my cloud data…</button>}
        </div>
        {confirm === 'cache' && (
          <div className="mt-3 text-[12px] text-ink" data-testid="reset-cache-confirm">
            Removes the offline copy on this device. {cloud ? 'Your account data is re-downloaded on reload.' : <b className="text-down">This account has no cloud copy — your holdings and watchlists on this device will be lost. Export a backup first.</b>}
            <div className="mt-2"><button type="button" className={primary} data-testid="reset-cache-go" onClick={resetCache}>Clear cache</button></div>
          </div>
        )}
        {confirm === 'cloud' && (
          <div className="mt-3 text-[12px] text-ink" data-testid="reset-cloud-confirm">
            Permanently deletes your saved portfolio, watchlists, focus basket, preferences and alert history from Supabase (on every device). Type <b>RESET</b> to confirm.
            <div className="mt-2 flex gap-2">
              <input data-testid="reset-cloud-input" value={typed} onChange={(e) => setTyped(e.target.value)} className="w-28 rounded-md border border-line bg-bg px-2 py-1 text-sm text-ink" />
              <button type="button" disabled={typed !== 'RESET'} className="rounded-md bg-down px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-40" data-testid="reset-cloud-go" onClick={() => void resetCloud()}>Delete</button>
            </div>
          </div>
        )}
        {msg && <p role="status" data-testid="reset-msg" className="mt-3 rounded-md bg-line px-3 py-2 text-[12px] text-ink">{msg}</p>}
      </section>
    </div>
  );
}

/* ───────────── shell ───────────── */

/**
 * Account control centre: Profile & Auth · Alert Channels · Market & Layout · Cloud & Data.
 * `inline` renders it as a normal page body (/settings); otherwise it is a dialog over the terminal.
 */
export function SettingsModal({ onClose, initialTab = 'profile', inline = false, onPlans }: { onClose?: () => void; initialTab?: SettingsTab; inline?: boolean; onPlans?: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => {
    if (inline || !onClose) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [inline, onClose]);

  const body: Record<SettingsTab, ReactNode> = { profile: <ProfileTab />, alerts: <AlertsTab />, market: <MarketTab />, cloud: <CloudTab /> };
  const shell = (
    <div ref={ref} tabIndex={-1} role={inline ? undefined : 'dialog'} aria-modal={inline ? undefined : true} aria-label="Account & Profile Settings" data-testid="settings-modal" className={`flex w-full flex-col overflow-hidden bg-panel text-ink outline-none ${inline ? 'rounded-2xl border border-line' : 'max-h-[min(90vh,720px)] max-w-2xl rounded-2xl border border-line shadow-2xl shadow-black/50'}`}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <h1 className="text-base font-black tracking-tight">Account &amp; Profile Settings</h1>
        {onPlans && <button type="button" className={`${btn} ml-auto`} data-testid="settings-plans" onClick={onPlans}>💳 Plans &amp; upgrade</button>}
        {!inline && onClose && <button type="button" aria-label="Close settings" data-testid="settings-close" onClick={onClose} className={`${onPlans ? '' : 'ml-auto '}rounded-md px-2 py-1 text-muted hover:bg-line hover:text-ink`}>✕</button>}
      </div>
      <div role="tablist" aria-label="Settings sections" className="flex gap-1 overflow-x-auto border-b border-line px-3 pt-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`settings-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="settings-panel" data-testid={`settings-tab-${t.id}`} onClick={() => setTab(t.id)} className={`shrink-0 rounded-t-md border-b-2 px-3 py-2 text-[12px] font-semibold ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto p-4">{body[tab]}</div>
    </div>
  );
  if (inline) return shell;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      {shell}
    </div>
  );
}
