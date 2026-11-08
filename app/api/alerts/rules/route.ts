import { NextRequest } from 'next/server';
import { allowAsync } from '@/lib/ttlCache';
import { bearer, supabaseConfigured, whoami } from '@/lib/serverAuth';
import { KIND_META, validateRule, validateRuleInput, type RuleInput } from '@/lib/alertTypes';
import { UUID_RE } from '@/lib/ackToken';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Alert-rule API — server-side validation in front of PostgREST. Every call acts AS THE USER (their access token), so Row Level Security,
 * the 50-rules-per-user trigger and the table CHECK constraints (docs/WEEK9_TURN43_SCHEMA.sql) all still apply; this route adds
 * per-kind validation with readable errors, a dry-run, and honest warnings (e.g. "the daemon is not running").
 *
 *   GET    /api/alerts/rules                       → { rules }
 *   POST   /api/alerts/rules                       body { symbol, kind, threshold, cooldown_min?, channels? }  → 201 { rule, warnings }
 *   POST   /api/alerts/rules?dry_run=1             same body → 200 { valid: true, normalized, warnings, notes } or 422 { errors }
 *   PATCH  /api/alerts/rules                       body { id, threshold?, cooldown_min?, channels?, enabled? }  → { rule }
 *   DELETE /api/alerts/rules?id=<uuid>             → { ok: true }
 * Symbol and kind are fixed once created (delete and re-create to change them): the daemon keys its in-memory state on them.
 */
const COLS = 'id,symbol,kind,threshold,cooldown_min,channels,enabled,last_triggered_at,created_at';
type Json = Record<string, unknown>;
const j = (body: Json, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function authed(req: NextRequest): Promise<{ token: string; id: string } | Response> {
  if (!supabaseConfigured()) return j({ ok: false, errors: ['Cloud accounts are not configured on this deployment.'] }, 501);
  const token = bearer(req);
  if (!token) return j({ ok: false, errors: ['Sign in first.'] }, 401);
  const u = await whoami(token);
  if (!u) return j({ ok: false, errors: ['Invalid or expired session.'] }, 401);
  if (!(await allowAsync(`rules:${u.id}`, 60, 60_000))) return j({ ok: false, errors: ['Too many requests — slow down.'] }, 429);
  return { token, id: u.id };
}

function pg(token: string) {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL as string).replace(/\/+$/, '');
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
  return (path: string, init: RequestInit = {}) =>
    fetch(`${base}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(8000) });
}

/** PostgREST error → status + readable message */
async function dbError(r: Response): Promise<Response> {
  const e = (await r.json().catch(() => ({}))) as { code?: string; message?: string };
  if (e.code === '54000') return j({ ok: false, errors: ['You already have 50 alert rules — delete one first.'] }, 409);
  if (e.code === '23514') return j({ ok: false, errors: ['The database rejected this rule (kind or threshold out of range). Has docs/WEEK9_TURN43_SCHEMA.sql been applied?'] }, 422);
  if (e.code === '42501' || r.status === 401 || r.status === 403) return j({ ok: false, errors: ['Not allowed.'] }, 403);
  return j({ ok: false, errors: ['Could not save the rule.'] }, 502);
}

/** best-effort context for a dry run: is the daemon alive, and is there a volume baseline for this symbol? Never fails the request. */
async function notes(db: ReturnType<typeof pg>, v: RuleInput): Promise<Json> {
  const out: Json = {};
  if (KIND_META[v.kind].engine === 'daemon') {
    try {
      const r = await db('rpc/daemon_health', { method: 'POST', body: '{}' });
      const rows = r.ok ? ((await r.json()) as { age_ms: number }[]) : null;
      out.daemon = !rows ? 'unknown' : !rows.length ? 'not_seen' : Number(rows[0].age_ms) < 20_000 ? 'running' : 'not_responding';
    } catch { out.daemon = 'unknown'; }
  }
  if (v.kind === 'volume_surge') {
    try {
      const r = await db(`volume_baselines?symbol=eq.${encodeURIComponent(v.symbol)}&select=status,sessions,median_volume`);
      const rows = r.ok ? ((await r.json()) as { status: string; sessions: number; median_volume: number | null }[]) : null;
      out.baseline = rows && rows[0] ? { status: rows[0].status, sessions: rows[0].sessions, medianVolume: rows[0].median_volume } : { status: 'not_computed_yet' };
    } catch { out.baseline = { status: 'unknown' }; }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const a = await authed(req); if (a instanceof Response) return a;
  const r = await pg(a.token)(`alert_rules?select=${COLS}&order=created_at.desc`);
  if (!r.ok) return dbError(r);
  return j({ ok: true, rules: await r.json() });
}

export async function POST(req: NextRequest) {
  const a = await authed(req); if (a instanceof Response) return a;
  let body: unknown; try { body = await req.json(); } catch { return j({ ok: false, errors: ['Bad JSON.'] }, 400); }
  const v = validateRuleInput(body);
  if (!v.ok) return j({ ok: false, errors: v.errors }, 422);
  const db = pg(a.token);
  const dry = req.nextUrl.searchParams.get('dry_run') === '1' || (body as Json).dry_run === true;
  if (dry) return j({ ok: true, valid: true, normalized: v.value, warnings: v.warnings, notes: await notes(db, v.value) });
  const r = await db('alert_rules', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ user_id: a.id, ...v.value }]) });
  if (!r.ok) return dbError(r);
  const rows = (await r.json()) as Json[];
  return j({ ok: true, rule: rows[0] ?? null, warnings: v.warnings }, 201);
}

export async function PATCH(req: NextRequest) {
  const a = await authed(req); if (a instanceof Response) return a;
  let b: Json; try { b = (await req.json()) as Json; } catch { return j({ ok: false, errors: ['Bad JSON.'] }, 400); }
  if (typeof b.id !== 'string' || !UUID_RE.test(b.id)) return j({ ok: false, errors: ['id: a rule id is required.'] }, 422);
  if (b.symbol !== undefined || b.kind !== undefined) return j({ ok: false, errors: ['symbol and kind cannot be changed — delete the rule and create a new one.'] }, 422);
  const db = pg(a.token);
  const cur = await db(`alert_rules?id=eq.${b.id}&select=${COLS}`);
  if (!cur.ok) return dbError(cur);
  const row = ((await cur.json()) as { symbol: string; kind: RuleInput['kind']; threshold: number; cooldown_min: number; channels: { push?: boolean; email?: boolean } }[])[0];
  if (!row) return j({ ok: false, errors: ['Rule not found.'] }, 404);
  const patch: Json = {};
  const errors: string[] = [];
  if (b.threshold !== undefined) { const t = Number(b.threshold); if (!Number.isFinite(t)) errors.push('threshold: must be a number.'); else patch.threshold = t; }
  if (b.cooldown_min !== undefined) { const c = Number(b.cooldown_min); if (!Number.isInteger(c)) errors.push('cooldown_min: must be a whole number of minutes.'); else patch.cooldown_min = c; }
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') errors.push('enabled: must be true or false.'); else patch.enabled = b.enabled; }
  if (b.channels !== undefined) {
    if (!b.channels || typeof b.channels !== 'object' || Array.isArray(b.channels)) errors.push('channels: must be an object like { "push": true, "email": false }.');
    else patch.channels = { push: (b.channels as Json).push !== false, email: (b.channels as Json).email === true };
  }
  if (!errors.length && !Object.keys(patch).length) errors.push('Nothing to change.');
  if (!errors.length) {
    const bad = validateRule({ symbol: row.symbol, kind: row.kind, threshold: (patch.threshold as number | undefined) ?? Number(row.threshold), cooldown_min: (patch.cooldown_min as number | undefined) ?? row.cooldown_min });
    if (bad) errors.push(bad);
  }
  if (errors.length) return j({ ok: false, errors }, 422);
  const r = await db(`alert_rules?id=eq.${b.id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
  if (!r.ok) return dbError(r);
  const rows = (await r.json()) as Json[];
  return rows[0] ? j({ ok: true, rule: rows[0] }) : j({ ok: false, errors: ['Rule not found.'] }, 404);
}

export async function DELETE(req: NextRequest) {
  const a = await authed(req); if (a instanceof Response) return a;
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!UUID_RE.test(id)) return j({ ok: false, errors: ['id: a rule id is required.'] }, 422);
  const r = await pg(a.token)(`alert_rules?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  if (!r.ok) return dbError(r);
  return ((await r.json()) as unknown[]).length ? j({ ok: true }) : j({ ok: false, errors: ['Rule not found.'] }, 404);
}
