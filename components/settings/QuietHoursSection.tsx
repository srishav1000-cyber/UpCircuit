'use client';

import { useEffect, useMemo, useState } from 'react';
import { MoonStar } from 'lucide-react';
import { useCloud } from '@/hooks/useCloud';
import { CRITICAL_KINDS, DEFAULT_QUIET, DEFAULT_TZ, fmtHHMM, isQuietAt, parseHHMM, validateQuiet, type QuietHours } from '@/lib/quietHours';
import { RULE_LABEL } from '@/lib/alertTypes';

const zones = (): string[] => {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return all.length ? all : [DEFAULT_TZ];
  } catch { return [DEFAULT_TZ]; }
};

/** Settings → Alerts: a daily Quiet Hours window (your time zone). Routine alerts are held inside it; circuit-proximity alerts always come through. */
export function QuietHoursSection() {
  const { cloud, userId } = useCloud();
  const [q, setQ] = useState<QuietHours>(DEFAULT_QUIET);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const list = useMemo(() => { const z = zones(); return z.includes(q.tz) ? z : [q.tz, ...z]; }, [q.tz]);

  useEffect(() => {
    if (!cloud) return;
    let live = true;
    cloud.getQuietHours().then((r) => { if (!live) return; if (r) setQ(r); else { try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tz) setQ((x) => ({ ...x, tz })); } catch { /* keep default */ } } setLoaded(true); }).catch(() => setLoaded(true));
    return () => { live = false; };
  }, [cloud]);

  const errs = validateQuiet(q);
  const quietNow = isQuietAt(q, Date.now());
  const critical = [...CRITICAL_KINDS].map((k) => RULE_LABEL[k]).join(', ');

  async function save() {
    if (!cloud || !userId || errs.length) return;
    setBusy(true); setMsg(null);
    try { await cloud.setQuietHours(userId, q); setMsg({ ok: true, text: q.enabled ? 'Quiet Hours saved. Routine alerts are held inside the window (the daemon picks this up within a minute).' : 'Quiet Hours are off.' }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' }); }
    finally { setBusy(false); }
  }

  const field = 'w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-ink';
  return (
    <section data-testid="quiet-hours" className="rounded-lg border border-line bg-panel/60 p-4">
      <h3 className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-muted"><MoonStar size={14} aria-hidden /> Quiet Hours</h3>
      {!cloud || !userId ? (
        <p data-testid="quiet-unavailable" className="mt-2 text-[12px] text-muted">Quiet Hours need a Supabase account — the alert daemon reads them from the database.</p>
      ) : (
        <>
          <label className="mt-2 flex items-center gap-2 text-[13px] text-ink">
            <input data-testid="quiet-enabled" type="checkbox" checked={q.enabled} disabled={!loaded} onChange={(e) => setQ({ ...q, enabled: e.target.checked })} /> Hold routine alerts during Quiet Hours
          </label>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="text-[11px] font-semibold text-muted">From
              <input data-testid="quiet-start" type="time" className={field} value={fmtHHMM(q.start)} onChange={(e) => { const m = parseHHMM(e.target.value); if (m !== null) setQ({ ...q, start: m }); }} />
            </label>
            <label className="text-[11px] font-semibold text-muted">Until
              <input data-testid="quiet-end" type="time" className={field} value={fmtHHMM(q.end)} onChange={(e) => { const m = parseHHMM(e.target.value); if (m !== null) setQ({ ...q, end: m }); }} />
            </label>
            <label className="col-span-2 text-[11px] font-semibold text-muted sm:col-span-1">Time zone
              <select data-testid="quiet-tz" className={field} value={q.tz} onChange={(e) => setQ({ ...q, tz: e.target.value })}>{list.map((z) => <option key={z} value={z}>{z}</option>)}</select>
            </label>
          </div>
          <p className="mt-2 text-[12px] text-muted" data-testid="quiet-hint">
            {q.start > q.end ? 'The window runs overnight. ' : ''}Held alerts are not sent later — they appear in the delivery log as “held: quiet hours”. {critical ? <>Always delivered: <b className="text-ink">{critical}</b>.</> : null}
            {q.enabled && <> Right now: <b data-testid="quiet-now" className={quietNow ? 'text-warn' : 'text-up'}>{quietNow ? 'inside the window' : 'outside the window'}</b>.</>}
          </p>
          {errs.length > 0 && <p role="alert" data-testid="quiet-error" className="mt-2 text-[12px] text-down">{errs.join(' ')}</p>}
          <div className="mt-3 flex items-center gap-3">
            <button type="button" data-testid="quiet-save" onClick={() => void save()} disabled={busy || !loaded || errs.length > 0} className="rounded-md border border-accent/50 bg-accent/15 px-3 py-1.5 text-[12px] font-semibold text-ink disabled:opacity-50">{busy ? 'Saving…' : 'Save Quiet Hours'}</button>
            {msg && <span role="status" data-testid="quiet-msg" className={`text-[12px] ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</span>}
          </div>
        </>
      )}
    </section>
  );
}
