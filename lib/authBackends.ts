import { appUrl } from './appUrl';
import { challengeOf, newVerifier } from './pkce';
import { PLANS, coerceRole, canUse, validateCredentials, type AuthBackend, type AuthResult, type PlanId, type Role, type User, ALL_ROLES } from './auth';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const isRole = (x: unknown): x is Role => typeof x === 'string' && (ALL_ROLES as string[]).includes(x);
const isPlan = (x: unknown): x is PlanId => typeof x === 'string' && PLANS.some((p) => p.id === x);
const fail = (error: string): AuthResult => ({ ok: false, error });
const normEmail = (e: string) => e.trim().toLowerCase();

/* ───────────── local demo backend ───────────── */

interface LocalRec { id: string; email: string; salt: string; hash: string; role: Role; plan: PlanId }
const USERS = 'upcircuit:auth:users';
const SESSION = 'upcircuit:auth:session';
const ITER = 120_000;

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pbkdf2(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITER }, key, 256));
}
/** constant-time-ish compare */
const same = (a: string, b: string) => a.length === b.length && a.split('').reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
const pub = (r: LocalRec): User => ({ id: r.id, email: r.email, role: r.role, plan: r.plan });

/**
 * Browser-only demo accounts: salted PBKDF2 hashes in localStorage. Good for the capstone demo and offline development;
 * anyone with access to the browser profile can read or edit them, so it is NOT an authentication boundary.
 */
export function createLocalBackend(store: Store): AuthBackend {
  const read = (): Record<string, LocalRec> => {
    try {
      return JSON.parse(store.getItem(USERS) ?? '{}') ?? {};
    } catch {
      return {};
    }
  };
  const write = (u: Record<string, LocalRec>) => store.setItem(USERS, JSON.stringify(u));
  return {
    kind: 'local',
    async restore() {
      try {
        const id = store.getItem(SESSION);
        const rec = id ? Object.values(read()).find((r) => r.id === id) : undefined;
        return rec ? pub(rec) : null;
      } catch {
        return null;
      }
    },
    async signUp({ email, password, role, plan }) {
      const bad = validateCredentials(email, password);
      if (bad) return fail(bad);
      if (!isPlan(plan) || !isRole(role)) return fail('Choose a plan and a role.');
      if (!canUse(plan, role)) return fail('That role is not included in the selected plan.');
      const users = read();
      const e = normEmail(email);
      if (users[e]) return fail('An account with this email already exists — log in instead.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const rec: LocalRec = { id: crypto.randomUUID(), email: e, salt: b64(salt), hash: await pbkdf2(password, salt), role, plan };
      users[e] = rec;
      write(users);
      store.setItem(SESSION, rec.id);
      return { ok: true, user: pub(rec) };
    },
    async signIn(email, password) {
      const rec = read()[normEmail(email)];
      const salt = rec ? unb64(rec.salt) : crypto.getRandomValues(new Uint8Array(16)); // same work for unknown emails
      const hash = await pbkdf2(password, salt);
      if (!rec || !same(hash, rec.hash)) return fail('Incorrect email or password.');
      store.setItem(SESSION, rec.id);
      return { ok: true, user: pub(rec) };
    },
    async signOut() {
      store.removeItem(SESSION);
    },
    async accessToken() {
      return null; // demo accounts have no server-verifiable session
    },
    async update(user, patch) {
      const users = read();
      const rec = users[normEmail(user.email)];
      if (!rec || rec.id !== user.id) return fail('Account not found.');
      const plan = patch.plan ?? rec.plan;
      if (!isPlan(plan)) return fail('Unknown plan.');
      rec.plan = plan;
      rec.role = coerceRole(plan, patch.role ?? rec.role);
      write(users);
      return { ok: true, user: pub(rec) };
    },
  };
}

/* ───────────── Supabase backend (REST, no SDK dependency) ───────────── */

interface Tokens { access: string; refresh: string }
const SB = 'upcircuit:auth:sb';

/**
 * Supabase Auth (GoTrue) + `profiles` (id, role, plan) over plain fetch. `plan` is read-only for the client: the SQL in
 * docs/AUTH_SCHEMA.sql only grants UPDATE on `role`, so billing (a webhook with the service-role key) owns the plan.
 */
export function createSupabaseBackend(url: string, anonKey: string, store: Store, f: typeof fetch = (...a) => fetch(...a)): AuthBackend {
  const base = url.replace(/\/+$/, '');
  const hdr = (t?: string): Record<string, string> => ({ apikey: anonKey, 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) });
  const save = (t: Tokens | null) => (t ? store.setItem(SB, JSON.stringify(t)) : store.removeItem(SB));
  const load = (): Tokens | null => {
    try {
      const t = JSON.parse(store.getItem(SB) ?? 'null');
      return t?.access ? t : null;
    } catch {
      return null;
    }
  };
  const msg = async (r: Response, d: string) => {
    const j = await r.json().catch(() => ({}));
    return (j as { error_description?: string; msg?: string; message?: string }).error_description ?? (j as { msg?: string }).msg ?? (j as { message?: string }).message ?? d;
  };
  type GoUser = { id: string; email?: string; phone?: string; phone_confirmed_at?: string | null; user_metadata?: Record<string, unknown>; app_metadata?: { provider?: string; providers?: unknown }; identities?: { provider?: string }[] };
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  async function profile(t: string, u: GoUser): Promise<User | null> {
    const q = (cols: string) => f(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=${cols}`, { headers: hdr(t) });
    let r = await q('primary_role,plan,full_name,avatar_url,phone,phone_verified');
    if (!r.ok) r = await q('primary_role,plan,full_name,avatar_url,phone'); // schema from before Round 30 (no phone_verified yet)
    if (!r.ok) return null;
    const row = ((await r.json().catch(() => [])) as { primary_role?: unknown; plan?: unknown; full_name?: unknown; avatar_url?: unknown; phone?: unknown; phone_verified?: unknown }[])[0];
    if (!row || !isPlan(row.plan)) return null;
    const meta = u.user_metadata ?? {};
    const rawPhone = str(row.phone) ?? str(u.phone);
    const user: User = { id: u.id, email: u.email ?? '', plan: row.plan, role: coerceRole(row.plan, isRole(row.primary_role) ? row.primary_role : undefined) };
    const name = str(row.full_name) ?? str(meta.full_name) ?? str(meta.name);
    const avatar = str(row.avatar_url) ?? str(meta.avatar_url) ?? str(meta.picture);
    if (rawPhone) {
      user.phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
      user.phoneVerified = typeof row.phone_verified === 'boolean' ? row.phone_verified : !!u.phone_confirmed_at;
    }
    const providers = new Set<string>([...(Array.isArray(u.app_metadata?.providers) ? (u.app_metadata!.providers as unknown[]).filter((x): x is string => typeof x === 'string') : []), ...(u.identities ?? []).map((i) => i.provider ?? '').filter(Boolean)]);
    if (providers.size) user.providers = [...providers].sort();
    if (name) user.name = name;
    if (avatar) user.avatar = avatar;
    return user;
  }
  async function refresh(t: Tokens): Promise<Tokens | null> {
    const r = await f(`${base}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: hdr(), body: JSON.stringify({ refresh_token: t.refresh }) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.access_token ? { access: j.access_token, refresh: j.refresh_token ?? t.refresh } : null;
  }
  const finish = async (j: { access_token?: string; refresh_token?: string; user?: GoUser }): Promise<AuthResult> => {
    if (!j.access_token || !j.user) return fail('Account created — confirm your email, then log in.');
    const u = await profile(j.access_token, j.user);
    if (!u) return fail('Signed in, but your profile could not be loaded.');
    save({ access: j.access_token, refresh: j.refresh_token ?? '' });
    return { ok: true, user: u };
  };
  return {
    kind: 'supabase',
    async restore() {
      try {
        let t = load();
        if (!t) return null;
        let r = await f(`${base}/auth/v1/user`, { headers: hdr(t.access) });
        if (r.status === 401 && t.refresh) {
          const n = await refresh(t);
          if (!n) return save(null), null;
          save((t = n));
          r = await f(`${base}/auth/v1/user`, { headers: hdr(t.access) });
        }
        if (!r.ok) return null;
        return await profile(t.access, (await r.json()) as GoUser);
      } catch {
        return null;
      }
    },
    async signUp({ email, password, role, plan }) {
      const bad = validateCredentials(email, password);
      if (bad) return fail(bad);
      if (!canUse(plan, role)) return fail('That role is not included in the selected plan.');
      try {
        const r = await f(`${base}/auth/v1/signup?redirect_to=${encodeURIComponent(appUrl('/login'))}`, { method: 'POST', headers: hdr(), body: JSON.stringify({ email: normEmail(email), password, data: { role, plan } }) });
        if (!r.ok) return fail(await msg(r, 'Sign-up failed.'));
        return finish(await r.json());
      } catch {
        return fail('Network error — please try again.');
      }
    },
    async signIn(email, password) {
      try {
        const r = await f(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers: hdr(), body: JSON.stringify({ email: normEmail(email), password }) });
        if (!r.ok) return fail(r.status === 400 ? 'Incorrect email or password.' : await msg(r, 'Login failed.'));
        return finish(await r.json());
      } catch {
        return fail('Network error — please try again.');
      }
    },
    async signOut() {
      const t = load();
      save(null);
      if (t) await f(`${base}/auth/v1/logout`, { method: 'POST', headers: hdr(t.access) }).catch(() => undefined);
    },
    async accessToken() {
      try {
        let t = load();
        if (!t) return null;
        const r = await f(`${base}/auth/v1/user`, { headers: hdr(t.access) });
        if (r.status === 401 && t.refresh) {
          const n = await refresh(t);
          if (!n) return null;
          save((t = n));
        } else if (!r.ok) return null;
        return t.access;
      } catch {
        return null;
      }
    },
    async startOAuth(provider, redirectTo) {
      try {
        const verifier = newVerifier();
        const q = new URLSearchParams({ provider, redirect_to: redirectTo, code_challenge: await challengeOf(verifier), code_challenge_method: 's256' });
        return { ok: true, url: `${base}/auth/v1/authorize?${q}`, verifier };
      } catch {
        return { ok: false, error: 'This browser cannot start Google sign-in (Web Crypto unavailable).' };
      }
    },
    async adoptSession(t) {
      try {
        const r = await f(`${base}/auth/v1/user`, { headers: hdr(t.access) });
        if (!r.ok) return fail('Google sign-in could not be completed — try again.');
        const gu = (await r.json()) as GoUser;
        const u = await profile(t.access, gu);
        if (!u) return fail('Signed in, but your profile could not be loaded.');
        save({ access: t.access, refresh: t.refresh });
        return { ok: true, user: u };
      } catch {
        return fail('Network error — please try again.');
      }
    },
    async sendOtp(phone, data) {
      try {
        const r = await f(`${base}/auth/v1/otp`, { method: 'POST', headers: hdr(), body: JSON.stringify({ phone, create_user: true, ...(data ? { data } : {}) }) });
        return r.ok ? { ok: true } : { ok: false, error: await msg(r, 'Could not send the code.') };
      } catch {
        return { ok: false, error: 'Network error — please try again.' };
      }
    },
    async verifyOtp(phone, token) {
      try {
        const r = await f(`${base}/auth/v1/verify`, { method: 'POST', headers: hdr(), body: JSON.stringify({ type: 'sms', phone, token }) });
        if (!r.ok) return fail(r.status === 400 || r.status === 403 || r.status === 422 ? 'That code is wrong or has expired.' : await msg(r, 'Verification failed.'));
        return finish(await r.json());
      } catch {
        return fail('Network error — please try again.');
      }
    },
    async startPhoneLink(phone) {
      const t = load();
      if (!t) return { ok: false, error: 'Your session expired — log in again.' };
      try {
        const r = await f(`${base}/auth/v1/user`, { method: 'PUT', headers: hdr(t.access), body: JSON.stringify({ phone }) });
        return r.ok ? { ok: true } : { ok: false, error: await msg(r, 'Could not send the code.') };
      } catch {
        return { ok: false, error: 'Network error — please try again.' };
      }
    },
    async confirmPhoneLink(phone, token) {
      const t = load();
      if (!t) return fail('Your session expired — log in again.');
      try {
        const r = await f(`${base}/auth/v1/verify`, { method: 'POST', headers: hdr(t.access), body: JSON.stringify({ type: 'phone_change', phone, token }) });
        if (!r.ok) return fail(r.status === 400 || r.status === 403 || r.status === 422 ? 'That code is wrong or has expired.' : await msg(r, 'Verification failed.'));
        const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; user?: GoUser };
        const access = j.access_token ?? t.access;
        const ur = j.user ?? ((await (await f(`${base}/auth/v1/user`, { headers: hdr(access) })).json().catch(() => null)) as GoUser | null);
        if (!ur) return fail('Number verified, but your profile could not be reloaded — refresh the page.');
        const u = await profile(access, ur);
        if (!u) return fail('Number verified, but your profile could not be reloaded — refresh the page.');
        save({ access, refresh: j.refresh_token ?? t.refresh });
        return { ok: true, user: u };
      } catch {
        return fail('Network error — please try again.');
      }
    },
    async startGoogleLink(redirectTo) {
      const t = load();
      if (!t) return { ok: false, error: 'Your session expired — log in again.' };
      try {
        const verifier = newVerifier();
        const q = new URLSearchParams({ provider: 'google', redirect_to: redirectTo, code_challenge: await challengeOf(verifier), code_challenge_method: 's256', skip_http_redirect: 'true' });
        const r = await f(`${base}/auth/v1/user/identities/authorize?${q}`, { headers: hdr(t.access) });
        if (!r.ok) return { ok: false, error: await msg(r, 'Could not start Google linking — enable "Manual linking" in Supabase Auth settings.') };
        const j = (await r.json().catch(() => ({}))) as { url?: string };
        return j.url ? { ok: true, url: j.url, verifier } : { ok: false, error: 'Supabase did not return a Google link URL.' };
      } catch {
        return { ok: false, error: 'Network error — please try again.' };
      }
    },
    async update(user, patch) {
      if (patch.plan && patch.plan !== user.plan) return fail('Plan changes are handled by billing — contact support or complete checkout.');
      const t = load();
      if (!t) return fail('Your session expired — log in again.');
      if (!patch.role) return { ok: true, user };
      if (!canUse(user.plan, patch.role)) return fail('That role is not included in your plan.');
      try {
        const r = await f(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH', headers: { ...hdr(t.access), Prefer: 'return=minimal' }, body: JSON.stringify({ primary_role: patch.role }) });
        return r.ok ? { ok: true, user: { ...user, role: patch.role } } : fail(await msg(r, 'Could not save your role.'));
      } catch {
        return fail('Network error — please try again.');
      }
    },
  };
}

/** Supabase when NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY are set (the anon key is public by design), else local demo accounts. */
export function pickBackend(store: Store = localStorage): AuthBackend {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? createSupabaseBackend(url, key, store) : createLocalBackend(store);
}
