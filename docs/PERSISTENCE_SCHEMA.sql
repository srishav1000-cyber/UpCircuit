-- UpCircuit — cloud persistence schema (Supabase / PostgreSQL). Run in the Supabase SQL editor.
-- Safe to run on a fresh project AND on top of docs/AUTH_SCHEMA.sql (it migrates that schema in place; re-runnable).
--
-- Design notes
--  • Every table has Row Level Security: a signed-in user can only touch rows where user_id = auth.uid().
--  • `profiles.plan` stays billing-owned: the browser (authenticated role) may update only the columns granted below.
--  • `watchlists` is one row per (user, list, symbol), as specified, plus list_id so the app's named tabs (Main, Today pick…) survive.
--    List order / names / the active tab live in `preferences.watchlist_meta` (an empty list has no symbol rows).
--  • `portfolios` and `watchlists` have unique keys so the app can UPSERT (merge-duplicates) before deleting removed symbols —
--    a failed save can never lose the previous data.

-- ───────────────────────── profiles ─────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  full_name    text,
  avatar_url   text,
  primary_role text not null default 'retail' check (primary_role in ('day','retail','institutional','executive')),
  plan         text not null default 'retail' check (plan in ('day','retail','full')),
  phone        text,
  phone_verified boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- migrate the older shape (role → primary_role, add the new columns)
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='role')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='primary_role') then
    alter table public.profiles rename column role to primary_role;
  end if;
end $$;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- ───────────────────────── portfolios ─────────────────────────
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

-- ───────────────────────── watchlists ─────────────────────────
-- the first version of this project stored named lists as (name, symbols[]) rows; keep that data under another name
do $$ begin
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

-- ───────────────────────── alert_history ─────────────────────────
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

-- ───────────────────────── push_subscriptions ─────────────────────────
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null,
  keys       jsonb not null,          -- { p256dh, auth }
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

-- ───────────────────────── preferences (focus basket, watchlist tabs, notification toggles) ─────────────────────────
create table if not exists public.preferences (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  focus          text[] not null default '{}' check (cardinality(focus) <= 6),
  watchlist_meta jsonb,               -- { lists: [{ id, name }], active }
  notify         jsonb,               -- { push, email, audio } booleans
  updated_at     timestamptz not null default now()
);
alter table public.preferences add column if not exists watchlist_meta jsonb;
alter table public.preferences add column if not exists notify jsonb;
alter table public.preferences add column if not exists updated_at timestamptz not null default now();

-- ───────────────────────── Row Level Security ─────────────────────────
alter table public.profiles           enable row level security;
alter table public.portfolios         enable row level security;
alter table public.watchlists         enable row level security;
alter table public.alert_history      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.preferences        enable row level security;

drop policy if exists "own profile read"   on public.profiles;
drop policy if exists "own profile update" on public.profiles;
create policy "own profile read"   on public.profiles for select using (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
-- column-level: the browser may change these columns only — `plan` / `email` belong to billing / auth
revoke update on public.profiles from anon, authenticated;
-- phone / phone_verified are NOT client-writable: they are mirrored from auth.users by the trigger below, so a user cannot claim a number they never confirmed
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

-- ───────────────────────── sign-up trigger (email, Google, phone OTP) ─────────────────────────
-- Builds the profile from auth metadata. Google supplies full_name / avatar_url; phone sign-ups carry auth.users.phone.
-- plan: the metadata is user-controlled — for real billing, force 'retail' here and grant paid plans from your payment webhook.
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

-- Back-fill profiles for accounts created before the trigger existed (e.g. the first Google / phone sign-ins)
insert into public.profiles(id, email, phone)
select u.id, u.email, nullif(u.phone, '') from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ───────────────────────── phone binding (Settings → Profile & Auth → Mobile number) ─────────────────────────
-- Columns for databases created before Round 30, then a trigger that mirrors auth.users.phone / phone_confirmed_at into profiles
-- whenever GoTrue confirms a number (sign-in by OTP, or the signed-in "link mobile" flow = phone_change). The client never writes these.
alter table public.profiles add column if not exists phone_verified boolean not null default false;
revoke update on public.profiles from anon, authenticated;
grant  update (primary_role, full_name, avatar_url, updated_at) on public.profiles to authenticated;

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

update public.profiles p set phone = nullif(u.phone, ''), phone_verified = (nullif(u.phone, '') is not null and u.phone_confirmed_at is not null)
from auth.users u where u.id = p.id and (p.phone is distinct from nullif(u.phone, '') or p.phone_verified is distinct from (nullif(u.phone, '') is not null and u.phone_confirmed_at is not null));
