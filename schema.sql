-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- UpCircuit — consolidated production schema (Supabase / PostgreSQL 15+)
--
-- ONE idempotent file: run it once in the Supabase SQL editor on a fresh project, or re-run it at any time on an existing one (it also migrates
-- databases created by the older per-week files). It replaces, in this order:
--   docs/AUTH_SCHEMA.sql (superseded) · docs/PERSISTENCE_SCHEMA.sql · docs/ENTERPRISE_SCHEMA.sql · ENTERPRISE_SCHEMA_P1.sql · ENTERPRISE_SCHEMA_P2.sql
--   docs/MARKET_TICKS.sql · docs/WEEK9_SCHEMA.sql · WEEK9_TURN43_SCHEMA.sql · WEEK9_TURN44_SCHEMA.sql · WEEK10_SCHEMA.sql · WEEK11_SCHEMA.sql
-- (The three ENTERPRISE files are included because the Week 9–11 objects depend on them: alert_rules, alert_deliveries, user_roles, audit_write(),
--  has_role(). Without them the alert / surveillance tables cannot be created.)
--
-- Contents
--   1  Accounts & user data      profiles · portfolios · watchlists · alert_history · push_subscriptions · preferences · sign-up + phone triggers
--   2  RBAC & audit              user_roles · audit_log (append-only, hash-chained) · set_user_role · admin_list_users · audit_verify
--   3  Circuit surveillance      circuit_events register · register_circuit_event · review_circuit_event · event_log / consumer offsets · circuit_daily_stats
--   4  Alert pipeline            alert_rules (8 kinds, per-kind bounds, plan limits) · alert_deliveries (+latency stamps) · alert_claims · claim_alert_rule
--   5  Alert daemon operations   daemon_heartbeat · daemon_leases (leader election, fencing epoch) · volume_baselines (+15-min profile) · user_quiet_hours · depth_flags
--   6  Market data               market_ticks (service role only)
--   7  Governance & DPDP         ai_signoffs · sign_off_ai_output · export_my_data · delete_my_data
--   8  Function privileges       one allow-list for every function (Supabase grants EXECUTE to API roles by default; everything is revoked, then granted)
--   9  Realtime                  alert_rules → supabase_realtime
--
-- Security model: every table has Row Level Security. Users reach only their own rows (user_id = auth.uid()); operational tables have NO user policy and are
-- reached only through SECURITY DEFINER functions or the service role (SUPABASE_SERVICE_ROLE_KEY, server-side only). This file contains no secrets.
-- Bootstrap the first admin once from the SQL editor:  insert into public.user_roles(user_id, role) values ('<your auth.users id>', 'admin');
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

/* ════════════════════════ 1. ACCOUNTS & USER DATA ════════════════════════ */

-- ── profiles (billing owns `plan`; the browser may update only the granted columns) ──
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text,
  full_name      text,
  avatar_url     text,
  primary_role   text not null default 'retail' check (primary_role in ('day','retail','institutional','executive')),
  plan           text not null default 'retail' check (plan in ('day','retail','full')),
  phone          text,
  phone_verified boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- migrate the oldest shape (role → primary_role) and add columns missing on older installs
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='role')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='primary_role') then
    alter table public.profiles rename column role to primary_role;
  end if;
end $$;
alter table public.profiles add column if not exists email          text;
alter table public.profiles add column if not exists full_name      text;
alter table public.profiles add column if not exists avatar_url     text;
alter table public.profiles add column if not exists phone          text;
alter table public.profiles add column if not exists phone_verified boolean not null default false;
alter table public.profiles add column if not exists updated_at     timestamptz not null default now();

-- ── portfolios (holdings) ──
create table if not exists public.portfolios (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  symbol     text not null check (char_length(symbol) between 1 and 24),
  quantity   numeric not null check (quantity > 0),
  buy_price  numeric not null check (buy_price > 0),
  sector     text,
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);

-- ── watchlists: one row per (user, list, symbol); list order / names / active tab live in preferences.watchlist_meta ──
do $$ begin   -- the first version stored named lists as (name, symbols[]) rows: keep that data under another name
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='watchlists' and column_name='symbols') then
    alter table public.watchlists rename to watchlists_legacy;
  end if;
end $$;
create table if not exists public.watchlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  list_id    text not null default 'main' check (char_length(list_id) between 1 and 40),
  symbol     text not null check (char_length(symbol) between 1 and 24),
  position   int  not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, list_id, symbol)
);

-- ── alert_history (circuit hits seen by the user's browser) ──
create table if not exists public.alert_history (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  symbol       text not null,
  direction    text not null check (direction in ('UPPER','LOWER')),
  band         numeric not null,
  price        numeric not null,
  triggered_at timestamptz not null default now()
);
create index if not exists alert_history_user_time on public.alert_history (user_id, triggered_at desc);

-- ── push_subscriptions: one row per registered browser / phone (Web Push). label e.g. "Android · Chrome", "iPhone · Home Screen PWA" ──
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null,
  keys       jsonb not null,                                    -- { p256dh, auth }
  label      text check (label is null or char_length(label) <= 80),
  platform   text check (platform is null or char_length(platform) <= 24),
  last_seen  timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);
alter table public.push_subscriptions add column if not exists label     text check (label is null or char_length(label) <= 80);
alter table public.push_subscriptions add column if not exists platform  text check (platform is null or char_length(platform) <= 24);
alter table public.push_subscriptions add column if not exists last_seen timestamptz not null default now();
alter table public.push_subscriptions add column if not exists created_at timestamptz not null default now();

-- ── preferences: focus basket, watchlist tabs, notification toggles, risk limits, saved layouts, synced chart timeframe + indicators ──
create table if not exists public.preferences (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  focus          text[] not null default '{}' check (cardinality(focus) <= 6),   -- MY FOCUS (≤ 6 symbols)
  watchlist_meta jsonb,                                                          -- { lists: [{ id, name }], active }
  notify         jsonb,                                                          -- { push, email, audio }
  risk_limits    jsonb,
  risk_report    boolean not null default false,
  layouts        jsonb,
  ui             jsonb,                                                          -- { tf, ind:{ema20,ema50,vwap,rsi}, updatedAt }
  updated_at     timestamptz not null default now()
);
alter table public.preferences add column if not exists watchlist_meta jsonb;
alter table public.preferences add column if not exists notify         jsonb;
alter table public.preferences add column if not exists risk_limits    jsonb;
alter table public.preferences add column if not exists risk_report    boolean not null default false;
alter table public.preferences add column if not exists layouts        jsonb;
alter table public.preferences add column if not exists ui             jsonb;
alter table public.preferences add column if not exists updated_at     timestamptz not null default now();
alter table public.preferences drop constraint if exists preferences_ui_shape;
alter table public.preferences add constraint preferences_ui_shape check (ui is null or (jsonb_typeof(ui) = 'object' and pg_column_size(ui) < 2000));

-- ── Row Level Security ──
alter table public.profiles            enable row level security;
alter table public.portfolios          enable row level security;
alter table public.watchlists          enable row level security;
alter table public.alert_history       enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.preferences         enable row level security;

drop policy if exists "own profile read"   on public.profiles;
drop policy if exists "own profile update" on public.profiles;
create policy "own profile read"   on public.profiles for select using (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
-- column-level: the browser may change ONLY these columns. plan / email belong to billing / auth; phone + phone_verified are mirrored from auth.users by a trigger,
-- so a user cannot claim a number they never confirmed.
revoke update on public.profiles from anon, authenticated;
grant  update (primary_role, full_name, avatar_url, updated_at) on public.profiles to authenticated;

drop policy if exists "Users access own data" on public.portfolios;
drop policy if exists "Users access own data" on public.watchlists;
drop policy if exists "Users access own data" on public.alert_history;
drop policy if exists "Users access own data" on public.push_subscriptions;
drop policy if exists "Users access own data" on public.preferences;
create policy "Users access own data" on public.portfolios         for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users access own data" on public.watchlists         for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users access own data" on public.alert_history      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users access own data" on public.push_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users access own data" on public.preferences        for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── sign-up trigger (email, Google, phone OTP): builds the profile from auth metadata ──
-- plan: the metadata is user-controlled — for real billing, force 'retail' here and grant paid plans from your payment webhook:
--   update public.profiles set plan = 'full' where id = '<uid>';
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare p text := coalesce(new.raw_user_meta_data->>'plan', 'retail');
        r text := coalesce(new.raw_user_meta_data->>'role', 'retail');
begin
  if p not in ('day','retail','full') then p := 'retail'; end if;
  if r not in ('day','retail','institutional','executive') then r := 'retail'; end if;
  insert into public.profiles(id, email, full_name, avatar_url, primary_role, plan, phone, phone_verified)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
          coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
          r, p, nullif(new.phone, ''), new.phone_confirmed_at is not null)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ── phone binding: mirror auth.users.phone / phone_confirmed_at into profiles when GoTrue confirms a number ──
create or replace function public.sync_profile_phone() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set phone = nullif(new.phone, ''),
         phone_verified = (nullif(new.phone, '') is not null and new.phone_confirmed_at is not null),
         updated_at = now()
   where id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_phone_changed on auth.users;
create trigger on_auth_user_phone_changed after update of phone, phone_confirmed_at on auth.users
  for each row when (old.phone is distinct from new.phone or old.phone_confirmed_at is distinct from new.phone_confirmed_at)
  execute function public.sync_profile_phone();

-- back-fill profiles for accounts created before the triggers existed, and re-sync phone fields
insert into public.profiles(id, email, phone)
select u.id, u.email, nullif(u.phone, '') from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);
update public.profiles p set phone = nullif(u.phone, ''), phone_verified = (nullif(u.phone, '') is not null and u.phone_confirmed_at is not null)
from auth.users u where u.id = p.id and (p.phone is distinct from nullif(u.phone, '') or p.phone_verified is distinct from (nullif(u.phone, '') is not null and u.phone_confirmed_at is not null));

/* ════════════════════════ 2. RBAC & AUDIT ════════════════════════ */

/* ── roles: viewer < analyst < risk < compliance < admin. Users read their own role; only an admin (set_user_role) can change one. ── */
create table if not exists public.user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'analyst' check (role in ('viewer','analyst','risk','compliance','admin')),
  granted_by uuid,
  updated_at timestamptz not null default now()
);

create or replace function public.app_role() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.user_roles where user_id = auth.uid()), 'analyst')
$$;
create or replace function public.has_role(variadic roles text[]) returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.app_role() = any(roles)
$$;

alter table public.user_roles enable row level security;
drop policy if exists "read own role or admin" on public.user_roles;
create policy "read own role or admin" on public.user_roles for select using (user_id = auth.uid() or public.has_role('admin'));
revoke insert, update, delete, truncate on public.user_roles from anon, authenticated;
grant select on public.user_roles to authenticated;

/* ── audit log: append-only, hash-chained (UPDATE / DELETE / TRUNCATE raise; audit_verify() proves integrity) ── */
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  seq        bigint unique,
  at         timestamptz not null default now(),
  user_id    uuid,                                  -- no FK on purpose: erasing an account must not rewrite history (the id is a pseudonym)
  actor_role text,
  action     text not null check (action ~ '^[a-z_]+(\.[a-z_]+)*$' and char_length(action) <= 48),
  entity     text check (char_length(entity) <= 48),
  entity_id  text check (char_length(entity_id) <= 80),
  meta       jsonb not null default '{}'::jsonb check (pg_column_size(meta) <= 4096),
  prev_hash  text,
  hash       text
);
create index if not exists audit_log_user_at on public.audit_log (user_id, at desc);
create index if not exists audit_log_action_at on public.audit_log (action, at desc);

create or replace function public.audit_hash(p_seq bigint, p_at timestamptz, p_user uuid, p_role text, p_action text, p_entity text, p_entity_id text, p_meta jsonb, p_prev text)
returns text language sql immutable set search_path = public, extensions as $$
  select encode(digest(concat_ws('|', p_seq, to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), coalesce(p_user::text,''), coalesce(p_role,''), p_action, coalesce(p_entity,''), coalesce(p_entity_id,''), p_meta::text, coalesce(p_prev,'')), 'sha256'), 'hex')
$$;

create or replace function public.audit_before_insert() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare last_row public.audit_log%rowtype;
begin
  perform pg_advisory_xact_lock(7770001);           -- one writer at a time → the chain order is the commit order
  if auth.uid() is not null then                     -- a signed-in caller can never choose who they are
    new.user_id := auth.uid();
    new.actor_role := public.app_role();
  end if;
  new.actor_role := coalesce(new.actor_role, 'system');
  new.at := clock_timestamp();
  select * into last_row from public.audit_log order by seq desc limit 1;
  new.seq := coalesce(last_row.seq, 0) + 1;
  new.prev_hash := last_row.hash;
  new.hash := public.audit_hash(new.seq, new.at, new.user_id, new.actor_role, new.action, new.entity, new.entity_id, new.meta, new.prev_hash);
  return new;
end $$;
drop trigger if exists audit_before_insert on public.audit_log;
create trigger audit_before_insert before insert on public.audit_log for each row execute function public.audit_before_insert();

create or replace function public.audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only' using errcode = '42501'; end $$;
drop trigger if exists audit_no_update on public.audit_log;
create trigger audit_no_update before update or delete on public.audit_log for each row execute function public.audit_immutable();
drop trigger if exists audit_no_truncate on public.audit_log;
create trigger audit_no_truncate before truncate on public.audit_log for each statement execute function public.audit_immutable();

alter table public.audit_log enable row level security;
drop policy if exists "append own audit rows" on public.audit_log;
drop policy if exists "read own or compliance audit" on public.audit_log;
create policy "append own audit rows" on public.audit_log for insert with check (auth.uid() is not null);
create policy "read own or compliance audit" on public.audit_log for select using (user_id = auth.uid() or public.has_role('compliance','admin'));
revoke all on public.audit_log from anon, authenticated;
grant select, insert on public.audit_log to authenticated;

/** internal helper for the RPCs below (runs in the caller's auth context, so the trigger stamps the right user + role) */
create or replace function public.audit_write(p_action text, p_entity text, p_entity_id text, p_meta jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log(action, entity, entity_id, meta) values (p_action, p_entity, p_entity_id, coalesce(p_meta, '{}'::jsonb))
$$;
revoke execute on function public.audit_write(text, text, text, jsonb) from public, anon, authenticated;

/** compliance / admin: re-computes the whole chain; returns the first broken sequence number (null = intact) */
create or replace function public.audit_verify() returns table(ok boolean, checked bigint, first_bad_seq bigint)
language plpgsql security definer set search_path = public as $$
declare r public.audit_log%rowtype; prev text := null; n bigint := 0; bad bigint := null; expect bigint := 1;
begin
  if not public.has_role('compliance', 'admin') then raise exception 'not allowed' using errcode = '42501'; end if;
  for r in select * from public.audit_log order by seq loop
    n := n + 1;
    if r.seq <> expect or r.prev_hash is distinct from prev
       or r.hash is distinct from public.audit_hash(r.seq, r.at, r.user_id, r.actor_role, r.action, r.entity, r.entity_id, r.meta, r.prev_hash) then
      bad := r.seq; exit;
    end if;
    prev := r.hash; expect := r.seq + 1;
  end loop;
  return query select bad is null, n, bad;
end $$;

/* ── role administration ── */
create or replace function public.set_user_role(target uuid, new_role text) returns void
language plpgsql security definer set search_path = public as $$
declare old_role text;
begin
  if not public.has_role('admin') then raise exception 'only an admin can change roles' using errcode = '42501'; end if;
  if new_role not in ('viewer','analyst','risk','compliance','admin') then raise exception 'unknown role' using errcode = '22023'; end if;
  select coalesce((select role from public.user_roles where user_id = target), 'analyst') into old_role;
  if old_role = 'admin' and new_role <> 'admin' and (select count(*) from public.user_roles where role = 'admin') <= 1 then
    raise exception 'cannot demote the last admin' using errcode = '22023';
  end if;
  insert into public.user_roles(user_id, role, granted_by, updated_at) values (target, new_role, auth.uid(), now())
  on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by, updated_at = now();
  perform public.audit_write('role.change', 'user', target::text, jsonb_build_object('from', old_role, 'to', new_role));
end $$;

create or replace function public.admin_list_users() returns table(id uuid, email text, full_name text, role text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'only an admin can list users' using errcode = '42501'; end if;
  return query select p.id, p.email, p.full_name, coalesce(r.role, 'analyst'), p.created_at from public.profiles p left join public.user_roles r on r.user_id = p.id order by p.created_at;
end $$;

/* ════════════════════════ 3. CIRCUIT SURVEILLANCE ════════════════════════ */

/* ── circuit register: ONE row per (symbol, direction, IST trade date), reviewed by risk / compliance (acknowledge → escalate → close) ── */
create table if not exists public.circuit_events (
  id          uuid primary key default gen_random_uuid(),
  symbol      text not null check (char_length(symbol) between 1 and 24),
  direction   text not null check (direction in ('UPPER','LOWER')),
  band        numeric not null check (band > 0),
  price       numeric not null check (price > 0),
  prev_close  numeric check (prev_close is null or prev_close > 0),
  trade_date  date not null,
  detected_at timestamptz not null default now(),
  source      text not null default 'smartapi' check (source in ('smartapi','yahoo','session')),
  detected_by uuid,
  status      text not null default 'open' check (status in ('open','acknowledged','escalated','closed')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  note        text check (note is null or char_length(note) <= 500),
  unique (symbol, direction, trade_date)
);
create index if not exists circuit_events_time on public.circuit_events (detected_at desc);
alter table public.circuit_events enable row level security;
drop policy if exists "register readable by analysts and above" on public.circuit_events;
create policy "register readable by analysts and above" on public.circuit_events for select using (public.has_role('analyst','risk','compliance','admin'));
revoke all on public.circuit_events from anon, authenticated;
grant select on public.circuit_events to authenticated;

/** any signed-in client (or the worker) reports a breach; the unique key de-duplicates the many clients that see the same event */
create or replace function public.register_circuit_event(p_symbol text, p_direction text, p_band numeric, p_price numeric, p_prev_close numeric default null, p_source text default 'smartapi')
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; d date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then raise exception 'sign in required' using errcode = '42501'; end if;
  if p_symbol !~ '^[A-Za-z0-9&._-]{1,24}$' or p_direction not in ('UPPER','LOWER') or p_band <= 0 or p_price <= 0 or p_source not in ('smartapi','yahoo','session') then
    raise exception 'invalid circuit event' using errcode = '22023';
  end if;
  insert into public.circuit_events(symbol, direction, band, price, prev_close, trade_date, source, detected_by)
  values (upper(p_symbol), p_direction, p_band, p_price, p_prev_close, d, p_source, auth.uid())
  on conflict (symbol, direction, trade_date) do nothing returning id into rid;
  if rid is not null then perform public.audit_write('circuit.detected', 'circuit_event', rid::text, jsonb_build_object('symbol', upper(p_symbol), 'direction', p_direction, 'band', p_band, 'price', p_price, 'source', p_source)); end if;
  return rid;   -- null = already registered today
end $$;

create or replace function public.review_circuit_event(p_id uuid, p_action text, p_note text default null) returns public.circuit_events
language plpgsql security definer set search_path = public as $$
declare ev public.circuit_events; nxt text;
begin
  if not public.has_role('risk','compliance','admin') then raise exception 'reviewing requires the risk, compliance or admin role' using errcode = '42501'; end if;
  select * into ev from public.circuit_events where id = p_id for update;
  if not found then raise exception 'event not found' using errcode = 'P0002'; end if;
  nxt := case p_action when 'acknowledge' then 'acknowledged' when 'escalate' then 'escalated' when 'close' then 'closed' else null end;
  if nxt is null then raise exception 'unknown action' using errcode = '22023'; end if;
  if ev.status = 'closed' then raise exception 'event is already closed' using errcode = '22023'; end if;
  if nxt = 'acknowledged' and ev.status <> 'open' then raise exception 'only an open event can be acknowledged' using errcode = '22023'; end if;
  if nxt = 'escalated' and ev.status = 'escalated' then raise exception 'already escalated' using errcode = '22023'; end if;
  if nxt = 'closed' and ev.status = 'escalated' and not public.has_role('compliance','admin') then raise exception 'closing an escalated event requires compliance or admin' using errcode = '42501'; end if;
  if nxt in ('escalated','closed') and coalesce(btrim(p_note), '') = '' then raise exception 'a note is required to escalate or close' using errcode = '22023'; end if;
  update public.circuit_events set status = nxt, reviewed_by = auth.uid(), reviewed_at = now(), note = coalesce(nullif(btrim(p_note), ''), note) where id = p_id returning * into ev;
  perform public.audit_write('circuit.' || p_action, 'circuit_event', p_id::text, jsonb_build_object('symbol', ev.symbol, 'status', nxt, 'note', left(coalesce(p_note, ''), 200)));
  return ev;
end $$;

/* ── append-only event log with consumer-group offsets, replay and an exactly-once consumer (Kafka semantics on PostgreSQL; docs/SCALE_OUT.md) ── */
create table if not exists public.event_log (
  "offset"    bigint generated always as identity primary key,
  topic       text not null check (topic ~ '^[a-z_]+(\.[a-z_]+)*$' and char_length(topic) <= 48),
  key         text,
  payload     jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 8192),
  produced_at timestamptz not null default now()
);
create index if not exists event_log_topic_offset on public.event_log (topic, "offset");
create table if not exists public.consumer_offsets (
  consumer   text not null,
  topic      text not null,
  committed  bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (consumer, topic)
);
alter table public.event_log enable row level security;
alter table public.consumer_offsets enable row level security;
revoke all on public.event_log, public.consumer_offsets from anon, authenticated;
grant all on public.event_log, public.consumer_offsets to service_role;

create or replace function public.event_publish(p_topic text, p_key text, p_payload jsonb) returns bigint
language sql security definer set search_path = public as $$
  insert into public.event_log(topic, key, payload) values (p_topic, p_key, coalesce(p_payload, '{}'::jsonb)) returning "offset"
$$;

/** producer: every row that reaches the circuit register is also published (the register stays the source of truth; the log is the stream) */
create or replace function public.circuit_events_publish() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.event_publish('circuit.detected', new.symbol, jsonb_build_object('id', new.id, 'symbol', new.symbol, 'direction', new.direction, 'band', new.band, 'price', new.price, 'trade_date', new.trade_date, 'source', new.source));
  return new;
end $$;
drop trigger if exists circuit_events_publish on public.circuit_events;
create trigger circuit_events_publish after insert on public.circuit_events for each row execute function public.circuit_events_publish();

/** consumer API: poll the next batch after the committed offset, commit explicitly, reset to replay */
create or replace function public.event_poll(p_consumer text, p_topic text, p_max int default 100) returns setof public.event_log
language sql stable security definer set search_path = public as $$
  select e.* from public.event_log e
  where e.topic = p_topic and e."offset" > coalesce((select committed from public.consumer_offsets where consumer = p_consumer and topic = p_topic), 0)
  order by e."offset" limit greatest(1, least(p_max, 1000))
$$;
create or replace function public.event_commit(p_consumer text, p_topic text, p_offset bigint) returns void
language sql security definer set search_path = public as $$
  insert into public.consumer_offsets(consumer, topic, committed) values (p_consumer, p_topic, p_offset)
  on conflict (consumer, topic) do update set committed = greatest(public.consumer_offsets.committed, excluded.committed), updated_at = now()
$$;
create or replace function public.event_reset(p_consumer text, p_topic text, p_to bigint default 0) returns void
language sql security definer set search_path = public as $$
  insert into public.consumer_offsets(consumer, topic, committed) values (p_consumer, p_topic, p_to)
  on conflict (consumer, topic) do update set committed = p_to, updated_at = now()
$$;
create or replace function public.event_lag(p_consumer text, p_topic text) returns bigint
language sql stable security definer set search_path = public as $$
  select count(*) from public.event_log e where e.topic = p_topic and e."offset" > coalesce((select committed from public.consumer_offsets where consumer = p_consumer and topic = p_topic), 0)
$$;

/* ── materialised view built by a consumer: circuit events per trading day and direction ── */
create table if not exists public.circuit_daily_stats (
  trade_date date not null, direction text not null, events int not null default 0, symbols text[] not null default '{}',
  primary key (trade_date, direction)
);
alter table public.circuit_daily_stats enable row level security;
drop policy if exists circuit_stats_read on public.circuit_daily_stats;
create policy circuit_stats_read on public.circuit_daily_stats for select to authenticated using (public.has_role('analyst', 'risk', 'compliance', 'admin'));
revoke all on public.circuit_daily_stats from anon, authenticated;
grant select on public.circuit_daily_stats to authenticated;
grant all on public.circuit_daily_stats to service_role;

/** one atomic step: read a batch, fold it into the stats, advance the offset — all in ONE transaction, so a crash re-runs the batch with no double count (exactly-once effect). Returns events consumed. */
create or replace function public.consume_circuit_stats(p_consumer text default 'circuit-stats', p_batch int default 500) returns int
language plpgsql security definer set search_path = public as $$
declare e public.event_log; n int := 0; last_off bigint;
begin
  for e in select * from public.event_poll(p_consumer, 'circuit.detected', p_batch) loop
    insert into public.circuit_daily_stats(trade_date, direction, events, symbols)
    values ((e.payload->>'trade_date')::date, e.payload->>'direction', 1, array[e.key])
    on conflict (trade_date, direction) do update set events = public.circuit_daily_stats.events + 1, symbols = array(select distinct unnest(public.circuit_daily_stats.symbols || excluded.symbols));
    n := n + 1; last_off := e."offset";
  end loop;
  if n > 0 then perform public.event_commit(p_consumer, 'circuit.detected', last_off); end if;
  return n;
end $$;
/** replay: wipe the derived table and rewind the consumer — rebuilding gives the same numbers (the log is the source of truth) */
create or replace function public.replay_circuit_stats(p_consumer text default 'circuit-stats') returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.circuit_daily_stats where true;
  perform public.event_reset(p_consumer, 'circuit.detected', 0);
end $$;


/* ═════════════════════════════════════════════════════════════════════════
   4 · ALERT PIPELINE   alert_rules · alert_deliveries · alert_claims · claim_alert_rule
   ═════════════════════════════════════════════════════════════════════════ */
create table if not exists public.alert_rules (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  symbol            text not null check (symbol ~ '^[A-Za-z0-9&._-]{1,24}$'),
  kind              text not null,
  threshold         numeric not null check (threshold > 0 and threshold < 10000000),
  cooldown_min      int not null default 60 check (cooldown_min between 5 and 1440),
  channels          jsonb not null default '{"push": true, "email": false}'::jsonb,
  enabled           boolean not null default true,
  last_triggered_at timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists alert_rules_enabled on public.alert_rules (enabled, symbol);

-- rule kinds (mirrors lib/alertTypes.ts) and per-kind threshold bounds
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid = 'public.alert_rules'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%price_above%' and conname <> 'alert_rules_kind_check'
  loop execute format('alter table public.alert_rules drop constraint %I', c.conname); end loop;   -- the unnamed inline CHECK of an older install
end $$;
alter table public.alert_rules drop constraint if exists alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in ('price_above','price_below','pct_up','pct_down','circuit_proximity','volume_surge','order_imbalance_above','order_imbalance_below'));
alter table public.alert_rules drop constraint if exists alert_rules_threshold_by_kind;
alter table public.alert_rules add constraint alert_rules_threshold_by_kind check (
  case kind
    when 'volume_surge'           then threshold between 0.5 and 50      -- × typical volume
    when 'order_imbalance_above'  then threshold between 0.1 and 1       -- fires at +threshold
    when 'order_imbalance_below'  then threshold between 0.1 and 1       -- fires at −threshold
    else true                                                            -- price / pct kinds keep the generic 0 < threshold < 10 000 000 check
  end
);

-- plan-aware rule cap: day 5 · retail 15 · full 50
create or replace function public.alert_rules_limit() returns trigger language plpgsql as $$
declare plan_id text; cap int;
begin
  select plan into plan_id from public.profiles where id = new.user_id;
  cap := case coalesce(plan_id, 'retail') when 'day' then 5 when 'full' then 50 else 15 end;
  if (select count(*) from public.alert_rules where user_id = new.user_id) >= cap then
    raise exception 'your plan allows at most % alert rules', cap using errcode = '54000';
  end if;
  return new;
end $$;
drop trigger if exists alert_rules_limit on public.alert_rules;
create trigger alert_rules_limit before insert on public.alert_rules for each row execute function public.alert_rules_limit();

create table if not exists public.alert_deliveries (
  id                 uuid primary key default gen_random_uuid(),
  rule_id            uuid references public.alert_rules(id) on delete set null,
  user_id            uuid not null references auth.users(id) on delete cascade,
  fired_at           timestamptz not null default now(),
  symbol             text not null,
  kind               text not null,
  price              numeric,
  channel            text not null check (channel in ('push','email','inapp')),
  status             text not null check (status in ('sent','failed','skipped')),
  detail             text
);
-- latency trail: tick → daemon match → push accepted → service-worker ack → displayed
alter table public.alert_deliveries
  add column if not exists tick_time          timestamptz,   -- exchange timestamp of the tick that crossed the rule (feed clock)
  add column if not exists daemon_matched_at  timestamptz,   -- daemon clock: rule matched
  add column if not exists push_sent_at       timestamptz,   -- daemon clock: first device accepted by its push service
  add column if not exists sw_ack_at          timestamptz,   -- server clock: service-worker ACK received by /api/alerts/ack
  add column if not exists displayed_at       timestamptz;   -- DEVICE clock: notification shown (may be skewed vs the server)
create index if not exists alert_deliveries_user_time   on public.alert_deliveries (user_id, fired_at desc);
create index if not exists alert_deliveries_push_recent on public.alert_deliveries (fired_at desc) where channel = 'push';

alter table public.alert_rules      enable row level security;
alter table public.alert_deliveries enable row level security;
drop policy if exists "Users access own data" on public.alert_rules;
drop policy if exists "read own deliveries"   on public.alert_deliveries;
create policy "Users access own data" on public.alert_rules      for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "read own deliveries"   on public.alert_deliveries for select using (auth.uid() = user_id);
revoke all on public.alert_rules, public.alert_deliveries from anon, authenticated;
grant select, insert, update, delete on public.alert_rules to authenticated;
revoke update on public.alert_rules from authenticated;
grant update (symbol, kind, threshold, cooldown_min, channels, enabled) on public.alert_rules to authenticated;   -- last_triggered_at belongs to the worker / daemon
grant select on public.alert_deliveries to authenticated;                                                         -- only the service role writes deliveries

create table if not exists public.alert_claims (
  rule_id    uuid not null references public.alert_rules(id) on delete cascade,
  window_key text not null check (length(window_key) between 1 and 200),
  claimed_at timestamptz not null default now(),
  primary key (rule_id, window_key)
);
create index if not exists alert_claims_age on public.alert_claims (claimed_at);
alter table public.alert_claims enable row level security;      -- no policies: only the SECURITY DEFINER function (and the service role) touch it
revoke all on public.alert_claims from anon, authenticated;

/** cron-worker backstop (/api/worker/alerts): claims a rule once per cooldown → two overlapping runs can never double-send */
create or replace function public.claim_alert_rule(p_rule uuid) returns boolean language plpgsql security definer set search_path = public as $$
declare hit int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'worker only' using errcode = '42501'; end if;
  update public.alert_rules set last_triggered_at = now()
   where id = p_rule and enabled and (last_triggered_at is null or last_triggered_at <= now() - make_interval(mins => cooldown_min));
  get diagnostics hit = row_count;
  return hit = 1;
end $$;

/** daemon (and cron): TRUE for exactly ONE caller per (rule, window). Serialises on a per-rule advisory lock, enforces cooldown + enabled,
    stamps last_triggered_at, and records the window key so a retried / duplicated dispatch is idempotent. */
create or replace function public.claim_alert_rule(p_rule uuid, p_window_key text) returns boolean language plpgsql security definer set search_path = public as $$
declare last_t timestamptz; cd int; ins int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'worker only' using errcode = '42501'; end if;
  if p_window_key is null or length(p_window_key) not between 1 and 200 then raise exception 'bad window key' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_rule::text, 0));
  select last_triggered_at, cooldown_min into last_t, cd from public.alert_rules where id = p_rule and enabled for update;
  if not found then return false; end if;                                                   -- unknown or disabled rule
  if last_t is not null and last_t > now() - make_interval(mins => cd) then return false; end if;   -- still cooling down
  insert into public.alert_claims (rule_id, window_key) values (p_rule, p_window_key) on conflict do nothing;
  get diagnostics ins = row_count;
  if ins = 0 then return false; end if;                                                     -- this exact window was already claimed
  update public.alert_rules set last_triggered_at = now() where id = p_rule;
  if random() < 0.01 then delete from public.alert_claims where claimed_at < now() - interval '7 days'; end if;
  return true;
end $$;

/* ═════════════════════════════════════════════════════════════════════════
   5 · DAEMON OPERATIONS   heartbeat · HA lease · volume baselines · quiet hours · depth flags
   ═════════════════════════════════════════════════════════════════════════ */
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

/** daemon only: upsert the heartbeat; beat_at is the DATABASE clock */
create or replace function public.daemon_beat(p_id text, p_feed_status text, p_last_tick_age_ms int, p_ticks bigint, p_reconnects int, p_rules int, p_symbols int, p_started_at timestamptz, p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'daemon only' using errcode = '42501'; end if;
  insert into public.daemon_heartbeat as h (id, beat_at, feed_status, last_tick_age_ms, ticks, reconnects, rules, symbols, started_at, version)
  values (p_id, now(), left(coalesce(p_feed_status, 'idle'), 20), p_last_tick_age_ms, coalesce(p_ticks, 0), coalesce(p_reconnects, 0), coalesce(p_rules, 0), coalesce(p_symbols, 0), p_started_at, left(p_version, 40))
  on conflict (id) do update set beat_at = now(), feed_status = excluded.feed_status, last_tick_age_ms = excluded.last_tick_age_ms, ticks = excluded.ticks,
    reconnects = excluded.reconnects, rules = excluded.rules, symbols = excluded.symbols, started_at = excluded.started_at, version = excluded.version;
end $$;

-- leader lease (HA): one active daemon, the others stand by; every comparison uses the DATABASE clock
create table if not exists public.daemon_leases (
  lease_name  text primary key check (lease_name ~ '^[a-z0-9-]{1,40}$'),
  holder_id   text,                                                 -- null / expired = nobody holds it
  expires_at  timestamptz not null default now(),
  epoch       bigint not null default 0,                            -- fencing token: +1 on every change of leader (not on renewals)
  renewed_at  timestamptz not null default now()
);
alter table public.daemon_leases enable row level security;          -- no policies: reachable only through the SECURITY DEFINER functions
revoke all on public.daemon_leases from anon, authenticated;

/** any signed-in user: is the alert daemon alive? Aggregate operational fields only. Week 11 adds the leader-lease fencing epoch and its remaining life (DB clock). */
drop function if exists public.daemon_health();
create function public.daemon_health()
returns table (id text, age_ms bigint, last_tick_age_ms int, feed_status text, reconnects int, started_at timestamptz, version text, lease_epoch bigint, lease_ttl_ms bigint)
language sql stable security definer set search_path = public as $$
  select h.id, (extract(epoch from (now() - h.beat_at)) * 1000)::bigint, h.last_tick_age_ms, h.feed_status, h.reconnects, h.started_at, h.version,
         l.epoch, (extract(epoch from (l.expires_at - now())) * 1000)::bigint
    from public.daemon_heartbeat h left join public.daemon_leases l on l.lease_name = 'alert-daemon'
   where auth.uid() is not null order by h.id
$$;


/** acquired = true → caller is leader until expires_at (renew before then); false → someone else holds an unexpired lease */
create or replace function public.acquire_daemon_lease(p_lease_name text, p_holder_id text, p_ttl_seconds int)
returns table (acquired boolean, holder_id text, expires_at timestamptz, epoch bigint)
language plpgsql security definer set search_path = public as $$
declare r public.daemon_leases;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'daemon only' using errcode = '42501'; end if;
  if p_lease_name is null or p_lease_name !~ '^[a-z0-9-]{1,40}$' then raise exception 'bad lease name' using errcode = '22023'; end if;
  if p_holder_id is null or length(p_holder_id) not between 1 and 100 then raise exception 'bad holder id' using errcode = '22023'; end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 5 and 300 then raise exception 'ttl must be 5-300 seconds' using errcode = '22023'; end if;

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

/** graceful shutdown: expire the caller's own lease so a standby takes over on its next poll */
create or replace function public.release_daemon_lease(p_lease_name text, p_holder_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'daemon only' using errcode = '42501'; end if;
  update public.daemon_leases set expires_at = now() where lease_name = p_lease_name and holder_id = p_holder_id and expires_at > now();
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- volume baselines (what the daemon computed; the UI shows "N/A — 4 sessions of history" instead of a rule that silently never fires)
create table if not exists public.volume_baselines (
  symbol        text primary key check (symbol ~ '^[A-Za-z0-9&._-]{1,24}$'),
  median_volume numeric check (median_volume is null or median_volume > 0),
  sessions      int not null default 0 check (sessions between 0 and 400),
  status        text not null check (status in ('ok','insufficient','unavailable')),
  computed_at   timestamptz not null default now()
);
alter table public.volume_baselines add column if not exists profile jsonb;                    -- { "cum": [25 numbers], "sessions": n }; null = flat full-day fallback
alter table public.volume_baselines add column if not exists profile_sessions int not null default 0;
alter table public.volume_baselines drop constraint if exists volume_baselines_profile_shape;
alter table public.volume_baselines add constraint volume_baselines_profile_shape
  check (profile is null or (jsonb_typeof(profile -> 'cum') = 'array' and jsonb_array_length(profile -> 'cum') = 25));
alter table public.volume_baselines enable row level security;
drop policy if exists "baselines readable by signed-in users" on public.volume_baselines;
create policy "baselines readable by signed-in users" on public.volume_baselines for select to authenticated using (true);   -- public market statistic
revoke all on public.volume_baselines from anon;
revoke insert, update, delete on public.volume_baselines from authenticated;
grant select on public.volume_baselines to authenticated;
grant select, insert, update on public.volume_baselines to service_role;

-- quiet hours: one row per user; the daemon holds routine alerts inside the window
create table if not exists public.user_quiet_hours (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  enabled    boolean not null default false,
  start_min  int not null default 1320 check (start_min between 0 and 1439),   -- 22:00
  end_min    int not null default 420  check (end_min   between 0 and 1439),   -- 07:00 (end < start wraps past midnight)
  tz         text not null default 'Asia/Kolkata' check (length(tz) between 1 and 64),
  updated_at timestamptz not null default now(),
  constraint quiet_window_not_24h check (not enabled or start_min <> end_min)
);
alter table public.user_quiet_hours enable row level security;
drop policy if exists "quiet hours: own row" on public.user_quiet_hours;
create policy "quiet hours: own row" on public.user_quiet_hours for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.user_quiet_hours from anon;
grant select, insert, update, delete on public.user_quiet_hours to authenticated;
grant select on public.user_quiet_hours to service_role;                                -- the daemon reads it

/** the zone must be one Postgres knows, so the daemon's Intl lookup and any SQL report agree */
create or replace function public.quiet_hours_check() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.tz) then raise exception 'unknown time zone: %', new.tz using errcode = '23514'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_quiet_hours_check on public.user_quiet_hours;
create trigger trg_quiet_hours_check before insert or update on public.user_quiet_hours for each row execute function public.quiet_hours_check();

-- heuristic order-depth flags (walls, rapid add/cancel). Screening hints only — never proof of manipulation.
create table if not exists public.depth_flags (
  id         bigint generated always as identity primary key,
  symbol     text not null check (symbol ~ '^[A-Z0-9&._-]{1,24}$'),
  kind       text not null check (kind in ('wall','add_cancel')),
  side       text not null check (side in ('bid','ask')),
  severity   text not null check (severity in ('watch','elevated')),
  price      numeric,                     -- wall price (null for add_cancel)
  qty        numeric,                     -- wall quantity, or the number of add→cancel cycles
  detail     text not null check (length(detail) <= 600),
  label      text not null default 'Heuristic Flag / Possible Manipulation Pattern' check (label = 'Heuristic Flag / Possible Manipulation Pattern'),
  flagged_at timestamptz not null default now()
);
-- which signals corroborated the flag (obi / volume / spread); NULL = single-rule baseline flag. Written when the daemon runs with DEPTH_CONFIRM=1
alter table public.depth_flags add column if not exists confirmed_by text[]
  check (confirmed_by is null or confirmed_by <@ array['obi','volume','spread']::text[]);
create index if not exists depth_flags_symbol_time on public.depth_flags (symbol, flagged_at desc);
create index if not exists depth_flags_time        on public.depth_flags (flagged_at desc);
alter table public.depth_flags enable row level security;
drop policy if exists "flags readable by signed-in users" on public.depth_flags;
create policy "flags readable by signed-in users" on public.depth_flags for select to authenticated using (true);   -- public market-structure observation, no personal data
revoke all on public.depth_flags from anon;
revoke insert, update, delete on public.depth_flags from authenticated;
grant select on public.depth_flags to authenticated;
grant select, insert, delete on public.depth_flags to service_role;

/* ═════════════════════════════════════════════════════════════════════════
   6 · MARKET TICKS   written only by the Next.js server (service role); RLS on with NO policies
   ═════════════════════════════════════════════════════════════════════════ */
create table if not exists public.market_ticks (
  id            bigint generated always as identity primary key,
  symbol        text           not null,
  ltp           numeric(14,2)  not null check (ltp > 0),
  high          numeric(14,2)  not null check (high > 0),
  low           numeric(14,2)  not null check (low > 0),
  volume        bigint         not null default 0,
  ts            timestamptz    not null,            -- exchange timestamp (09:15–15:30 IST only; enforced by the API)
  trading_date  date           not null,            -- IST calendar day
  unique (symbol, ts)                               -- many browsers log the same ticks; duplicates are ignored
);
create index if not exists market_ticks_day_symbol_ts on public.market_ticks (trading_date, symbol, ts);
alter table public.market_ticks enable row level security;
-- retention (optional): delete from public.market_ticks where trading_date < (now() at time zone 'Asia/Kolkata')::date - 14;

/* ═════════════════════════════════════════════════════════════════════════
   7 · GOVERNANCE & DPDP   AI sign-off trail · data export · erasure
   ═════════════════════════════════════════════════════════════════════════ */
create table if not exists public.ai_signoffs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  kind           text not null check (kind in ('postmortem','copilot','report')),
  symbol         text check (symbol is null or symbol ~ '^[A-Za-z0-9&._-]{1,24}$'),
  model          text not null check (char_length(model) between 1 and 80),
  prompt_version text not null check (char_length(prompt_version) between 1 and 40),
  data_used      jsonb not null default '[]'::jsonb check (pg_column_size(data_used) <= 4096),
  output_hash    text not null check (output_hash ~ '^[0-9a-f]{64}$'),
  decision       text not null check (decision in ('approved','rejected')),
  note           text check (note is null or char_length(note) <= 500),
  signer_role    text not null,
  signed_at      timestamptz not null default now()
);
create index if not exists ai_signoffs_user_time on public.ai_signoffs (user_id, signed_at desc);
alter table public.ai_signoffs enable row level security;
drop policy if exists ai_signoffs_select on public.ai_signoffs;
create policy ai_signoffs_select on public.ai_signoffs for select to authenticated using (user_id = auth.uid() or public.has_role('compliance', 'admin'));
revoke all on public.ai_signoffs from anon, authenticated;
grant select on public.ai_signoffs to authenticated;
grant all on public.ai_signoffs to service_role;

/** a human accepts / rejects an AI-generated output; the record (model, prompt version, data used, hash of the exact text) also goes to the audit trail */
create or replace function public.sign_off_ai_output(p_kind text, p_symbol text, p_model text, p_prompt_version text, p_data_used jsonb, p_output_hash text, p_decision text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid; r text := public.app_role();
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if r = 'viewer' then raise exception 'viewers cannot sign off AI output' using errcode = '42501'; end if;
  if p_decision = 'rejected' and coalesce(btrim(p_note), '') = '' then raise exception 'a note is required when rejecting' using errcode = '22023'; end if;
  insert into public.ai_signoffs(user_id, kind, symbol, model, prompt_version, data_used, output_hash, decision, note, signer_role)
  values (auth.uid(), p_kind, nullif(p_symbol, ''), p_model, p_prompt_version, coalesce(p_data_used, '[]'::jsonb), p_output_hash, p_decision, p_note, r) returning id into rid;
  perform public.audit_write('ai.signoff', p_kind, rid::text, jsonb_build_object('decision', p_decision, 'model', p_model, 'prompt', p_prompt_version, 'symbol', coalesce(p_symbol, '')));
  return rid;
end $$;

/** DPDP Act 2023 — right of access / portability */
create or replace function public.export_my_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); out jsonb;
begin
  if me is null then raise exception 'sign in required' using errcode = '42501'; end if;
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = me),
    'role', public.app_role(),
    'portfolio', coalesce((select jsonb_agg(to_jsonb(x)) from public.portfolios x where x.user_id = me), '[]'),
    'watchlists', coalesce((select jsonb_agg(to_jsonb(x)) from public.watchlists x where x.user_id = me), '[]'),
    'preferences', (select to_jsonb(x) from public.preferences x where x.user_id = me),
    'alert_history', coalesce((select jsonb_agg(to_jsonb(x)) from public.alert_history x where x.user_id = me), '[]'),
    'alert_rules', coalesce((select jsonb_agg(to_jsonb(x)) from public.alert_rules x where x.user_id = me), '[]'),
    'alert_deliveries', coalesce((select jsonb_agg(to_jsonb(x)) from public.alert_deliveries x where x.user_id = me), '[]'),
    'push_devices', (select count(*) from public.push_subscriptions x where x.user_id = me),
    'ai_signoffs', coalesce((select jsonb_agg(to_jsonb(x)) from public.ai_signoffs x where x.user_id = me), '[]'),
    'audit_entries', coalesce((select jsonb_agg(jsonb_build_object('seq', a.seq, 'at', a.at, 'action', a.action, 'entity', a.entity, 'entity_id', a.entity_id, 'meta', a.meta) order by a.seq) from public.audit_log a where a.user_id = me), '[]')
  ) into out;
  perform public.audit_write('account.export', 'user', me::text, '{}'::jsonb);
  return out;
end $$;

/** DPDP Act 2023 — erasure. Audit entries are kept (legal-obligation / security exception) but are no longer linked to a person once the auth user is removed.
    The auth user itself is removed by the server route (needs the service key). */
create or replace function public.delete_my_data() returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if public.app_role() = 'admin' and (select count(*) from public.user_roles where role = 'admin') <= 1 then raise exception 'you are the last admin — promote someone else first' using errcode = '23514'; end if;
  perform public.audit_write('account.delete', 'user', me::text, '{}'::jsonb);
  delete from public.portfolios where user_id = me;
  delete from public.watchlists where user_id = me;
  delete from public.alert_history where user_id = me;
  delete from public.alert_deliveries where user_id = me;
  delete from public.alert_rules where user_id = me;
  delete from public.push_subscriptions where user_id = me;
  delete from public.preferences where user_id = me;
  delete from public.ai_signoffs where user_id = me;
  delete from public.user_roles where user_id = me;
  delete from public.profiles where id = me;
end $$;

/* ═════════════════════════════════════════════════════════════════════════
   8 · FUNCTION PRIVILEGES   one allow-list (kept LAST so nothing above can undo it)
   Supabase grants EXECUTE on new functions to anon/authenticated by default → revoke everything, then grant explicitly.
   ═════════════════════════════════════════════════════════════════════════ */
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.app_role(), public.has_role(text[]) to anon, authenticated, service_role;
grant execute on function public.audit_verify(), public.set_user_role(uuid, text), public.admin_list_users(),
  public.register_circuit_event(text, text, numeric, numeric, numeric, text), public.review_circuit_event(uuid, text, text) to authenticated, service_role;
grant execute on function public.sign_off_ai_output(text, text, text, text, jsonb, text, text, text), public.export_my_data(), public.delete_my_data() to authenticated, service_role;
grant execute on function public.daemon_health() to authenticated, service_role;
grant execute on function public.claim_alert_rule(uuid), public.claim_alert_rule(uuid, text), public.audit_write(text, text, text, jsonb),
  public.daemon_beat(text, text, int, bigint, int, int, int, timestamptz, text),
  public.acquire_daemon_lease(text, text, int), public.release_daemon_lease(text, text),
  public.event_publish(text, text, jsonb), public.event_poll(text, text, int), public.event_commit(text, text, bigint), public.event_reset(text, text, bigint), public.event_lag(text, text),
  public.consume_circuit_stats(text, int), public.replay_circuit_stats(text) to service_role;

/* ═════════════════════════════════════════════════════════════════════════
   9 · REALTIME   the daemon syncs its in-memory rule index from alert_rules changes
   ═════════════════════════════════════════════════════════════════════════ */
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alert_rules') then
      alter publication supabase_realtime add table public.alert_rules;
    end if;
  else
    raise notice 'publication supabase_realtime not found — enable Realtime for alert_rules in the Supabase dashboard (Database → Replication)';
  end if;
end $$;
