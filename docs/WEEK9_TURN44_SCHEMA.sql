-- UpCircuit Week 9 / Turn 44 — Quiet Hours + heuristic depth flags.
-- Run AFTER docs/ENTERPRISE_SCHEMA.sql, docs/WEEK9_SCHEMA.sql and docs/WEEK9_TURN43_SCHEMA.sql. Safe to re-run.
--   1. user_quiet_hours : one row per user — daily window in minutes since local midnight + IANA time zone (the daemon holds routine alerts inside it)
--   2. depth_flags      : heuristic order-depth flags written by the daemon (walls, rapid add/cancel). Screening hints only — never proof of manipulation.

/* ───────────── 1. quiet hours ───────────── */
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

/* ───────────── 2. heuristic depth flags ───────────── */
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
create index if not exists depth_flags_symbol_time on public.depth_flags (symbol, flagged_at desc);
create index if not exists depth_flags_time on public.depth_flags (flagged_at desc);
alter table public.depth_flags enable row level security;
drop policy if exists "flags readable by signed-in users" on public.depth_flags;
create policy "flags readable by signed-in users" on public.depth_flags for select to authenticated using (true);   -- public market-structure observation, no personal data
revoke all on public.depth_flags from anon;
revoke insert, update, delete on public.depth_flags from authenticated;
grant select on public.depth_flags to authenticated;
grant select, insert, delete on public.depth_flags to service_role;
