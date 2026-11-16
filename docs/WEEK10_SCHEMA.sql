-- UpCircuit Week 10 — daemon leader election + intraday volume profile storage.
-- Run AFTER ENTERPRISE_SCHEMA → WEEK9_SCHEMA → WEEK9_TURN43_SCHEMA → WEEK9_TURN44_SCHEMA. Safe to re-run.
--   1. daemon_leases + acquire_daemon_lease() / release_daemon_lease()   (one active alert daemon; the others stand by)
--   2. volume_baselines.profile                                          (median cumulative volume per 15-minute bucket, for the time-of-day volume_surge basis)

/* ───────────── 1. leader lease ───────────── */
create table if not exists public.daemon_leases (
  lease_name  text primary key check (lease_name ~ '^[a-z0-9-]{1,40}$'),
  holder_id   text,                                                 -- null / expired = nobody holds it
  expires_at  timestamptz not null default now(),
  epoch       bigint not null default 0,                            -- fencing token: +1 on every change of leader (not on renewals)
  renewed_at  timestamptz not null default now()
);
alter table public.daemon_leases enable row level security;          -- no policies: reachable only through the SECURITY DEFINER functions below
revoke all on public.daemon_leases from anon, authenticated;

/** Atomically acquire or renew a lease. Every comparison uses the DATABASE clock — daemon clocks (and skew between them) play no part.
 *  acquired = true  → the caller is the leader until expires_at (renew before then)
 *  acquired = false → someone else holds an unexpired lease; holder_id / expires_at say who and until when */
create or replace function public.acquire_daemon_lease(p_lease_name text, p_holder_id text, p_ttl_seconds int)
returns table (acquired boolean, holder_id text, expires_at timestamptz, epoch bigint)
language plpgsql security definer set search_path = public as $$
declare r public.daemon_leases;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'daemon only' using errcode = '42501'; end if;
  if p_lease_name is null or p_lease_name !~ '^[a-z0-9-]{1,40}$' then raise exception 'bad lease name' using errcode = '22023'; end if;
  if p_holder_id is null or length(p_holder_id) not between 1 and 100 then raise exception 'bad holder id' using errcode = '22023'; end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 5 and 300 then raise exception 'ttl must be 5-300 seconds' using errcode = '22023'; end if;

  -- one statement: insert the first lease, or take over / renew only when it is expired or already ours (row lock serialises racing daemons)
  insert into public.daemon_leases as l (lease_name, holder_id, expires_at, epoch, renewed_at)
  values (p_lease_name, p_holder_id, now() + make_interval(secs => p_ttl_seconds), 1, now())
  on conflict (lease_name) do update
     set holder_id  = excluded.holder_id,
         epoch      = case when l.holder_id = excluded.holder_id and l.expires_at > now() then l.epoch else l.epoch + 1 end,
         expires_at = excluded.expires_at,
         renewed_at = now()
   where l.expires_at <= now() or l.holder_id = excluded.holder_id
  returning * into r;

  if found then
    return query select true, r.holder_id, r.expires_at, r.epoch;
  else
    select * into r from public.daemon_leases where lease_name = p_lease_name;
    return query select false, r.holder_id, r.expires_at, r.epoch;
  end if;
end $$;

/** graceful shutdown: expire the caller's own lease immediately so a standby takes over on its next poll (no-op if someone else holds it) */
create or replace function public.release_daemon_lease(p_lease_name text, p_holder_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'daemon only' using errcode = '42501'; end if;
  update public.daemon_leases set expires_at = now() where lease_name = p_lease_name and holder_id = p_holder_id and expires_at > now();
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke execute on function public.acquire_daemon_lease(text, text, int) from public, anon, authenticated;
revoke execute on function public.release_daemon_lease(text, text) from public, anon, authenticated;
grant  execute on function public.acquire_daemon_lease(text, text, int) to service_role;
grant  execute on function public.release_daemon_lease(text, text) to service_role;

/* ───────────── 2. intraday volume profile ───────────── */
alter table public.volume_baselines add column if not exists profile jsonb;                    -- { "cum": [25 numbers], "sessions": n }; null = flat full-day fallback
alter table public.volume_baselines add column if not exists profile_sessions int not null default 0;
alter table public.volume_baselines drop constraint if exists volume_baselines_profile_shape;
alter table public.volume_baselines add constraint volume_baselines_profile_shape
  check (profile is null or (jsonb_typeof(profile -> 'cum') = 'array' and jsonb_array_length(profile -> 'cum') = 25));
