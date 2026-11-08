-- UpCircuit Week 9 / Turn 43 — volume-surge + order-imbalance rules, daemon heartbeat, volume baselines.
-- Run AFTER docs/ENTERPRISE_SCHEMA.sql and docs/WEEK9_SCHEMA.sql. Safe to re-run.
--   1. alert_rules.kind CHECK extended: volume_surge, order_imbalance_above, order_imbalance_below
--   2. per-kind threshold bounds (mirrors lib/alertTypes.ts RULE_BOUNDS)
--   3. daemon_heartbeat + daemon_beat() / daemon_health()   (UI feed-health panel; ages are computed by the DATABASE clock, so browser clock skew cannot fake "stale")
--   4. volume_baselines  (what the daemon computed, so the UI can say "N/A — 4 sessions of history" instead of a rule that silently never fires)

/* ───────────── 1 + 2. alert_rules kinds and bounds ───────────── */
alter table public.alert_rules drop constraint if exists alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in ('price_above','price_below','pct_up','pct_down','circuit_proximity','volume_surge','order_imbalance_above','order_imbalance_below'));

alter table public.alert_rules drop constraint if exists alert_rules_threshold_by_kind;
alter table public.alert_rules add constraint alert_rules_threshold_by_kind check (
  case kind
    when 'volume_surge'           then threshold between 0.5 and 50      -- × typical full-day volume
    when 'order_imbalance_above'  then threshold between 0.1 and 1       -- fires at +threshold
    when 'order_imbalance_below'  then threshold between 0.1 and 1       -- fires at −threshold
    else true                                                            -- price / pct kinds keep the generic 0 < threshold < 10 000 000 check
  end
);

/* ───────────── 3. daemon heartbeat ───────────── */
create table if not exists public.daemon_heartbeat (
  id                text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  beat_at           timestamptz not null default now(),
  feed_status       text not null default 'idle',
  last_tick_age_ms  int,                 -- age of the newest tick AT beat time, measured on the daemon (skew-free)
  ticks             bigint not null default 0,
  reconnects        int not null default 0,
  rules             int not null default 0,
  symbols           int not null default 0,
  started_at        timestamptz,
  version           text
);
alter table public.daemon_heartbeat enable row level security;           -- no policies: read only through daemon_health(), write only through daemon_beat()
revoke all on public.daemon_heartbeat from anon, authenticated;

/** daemon only (service role): upsert the heartbeat; beat_at is the DATABASE clock */
create or replace function public.daemon_beat(p_id text, p_feed_status text, p_last_tick_age_ms int, p_ticks bigint, p_reconnects int, p_rules int, p_symbols int, p_started_at timestamptz, p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'daemon only' using errcode = '42501'; end if;
  insert into public.daemon_heartbeat as h (id, beat_at, feed_status, last_tick_age_ms, ticks, reconnects, rules, symbols, started_at, version)
  values (p_id, now(), left(coalesce(p_feed_status, 'idle'), 20), p_last_tick_age_ms, coalesce(p_ticks, 0), coalesce(p_reconnects, 0), coalesce(p_rules, 0), coalesce(p_symbols, 0), p_started_at, left(p_version, 40))
  on conflict (id) do update set beat_at = now(), feed_status = excluded.feed_status, last_tick_age_ms = excluded.last_tick_age_ms, ticks = excluded.ticks,
    reconnects = excluded.reconnects, rules = excluded.rules, symbols = excluded.symbols, started_at = excluded.started_at, version = excluded.version;
end $$;

/** any signed-in user: is the alert daemon alive? Aggregate operational fields only (no rule or symbol counts). */
create or replace function public.daemon_health()
returns table (id text, age_ms bigint, last_tick_age_ms int, feed_status text, reconnects int, started_at timestamptz, version text)
language sql stable security definer set search_path = public as $$
  select h.id, (extract(epoch from (now() - h.beat_at)) * 1000)::bigint, h.last_tick_age_ms, h.feed_status, h.reconnects, h.started_at, h.version
    from public.daemon_heartbeat h where auth.uid() is not null order by h.id
$$;
revoke execute on function public.daemon_beat(text, text, int, bigint, int, int, int, timestamptz, text) from public, anon, authenticated;
grant  execute on function public.daemon_beat(text, text, int, bigint, int, int, int, timestamptz, text) to service_role;
revoke execute on function public.daemon_health() from public, anon;
grant  execute on function public.daemon_health() to authenticated, service_role;

/* ───────────── 4. volume baselines ───────────── */
create table if not exists public.volume_baselines (
  symbol        text primary key check (symbol ~ '^[A-Za-z0-9&._-]{1,24}$'),
  median_volume numeric check (median_volume is null or median_volume > 0),
  sessions      int not null default 0 check (sessions between 0 and 400),
  status        text not null check (status in ('ok','insufficient','unavailable')),
  computed_at   timestamptz not null default now()
);
alter table public.volume_baselines enable row level security;
drop policy if exists "baselines readable by signed-in users" on public.volume_baselines;
create policy "baselines readable by signed-in users" on public.volume_baselines for select to authenticated using (true);   -- public market statistic
revoke all on public.volume_baselines from anon;
revoke insert, update, delete on public.volume_baselines from authenticated;
grant select on public.volume_baselines to authenticated;
grant select, insert, update on public.volume_baselines to service_role;
