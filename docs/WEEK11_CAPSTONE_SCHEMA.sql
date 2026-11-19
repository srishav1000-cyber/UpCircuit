-- Week 11 capstone — multi-signal flag confirmation. Idempotent. Already included in the root schema.sql; run this only on an existing database.
-- Which signals (obi / volume / spread) corroborated a heuristic depth flag. NULL = single-rule baseline flag (or written before this column existed).
alter table public.depth_flags add column if not exists confirmed_by text[]
  check (confirmed_by is null or confirmed_by <@ array['obi','volume','spread']::text[]);

-- daemon_health() now also reports the leader-lease fencing epoch and its remaining life, so the audit dossier can show the HA state.
drop function if exists public.daemon_health();
create function public.daemon_health()
returns table (id text, age_ms bigint, last_tick_age_ms int, feed_status text, reconnects int, started_at timestamptz, version text, lease_epoch bigint, lease_ttl_ms bigint)
language sql stable security definer set search_path = public as $$
  select h.id, (extract(epoch from (now() - h.beat_at)) * 1000)::bigint, h.last_tick_age_ms, h.feed_status, h.reconnects, h.started_at, h.version,
         l.epoch, (extract(epoch from (l.expires_at - now())) * 1000)::bigint
    from public.daemon_heartbeat h left join public.daemon_leases l on l.lease_name = 'alert-daemon'
   where auth.uid() is not null order by h.id
$$;
revoke execute on function public.daemon_health() from public, anon;
grant execute on function public.daemon_health() to authenticated, service_role;
