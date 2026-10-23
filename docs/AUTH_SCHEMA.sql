-- NOTE: superseded by docs/PERSISTENCE_SCHEMA.sql (adds portfolios, per-symbol watchlists, alert_history, push_subscriptions, Google/phone profile fields). Run that file instead; it migrates this schema in place.
-- UpCircuit — Supabase schema. Run in the Supabase SQL editor.
-- The browser (anon key) may read its own profile and change ONLY `role`; `plan` is written by billing (service-role key / webhook).

create table if not exists public.profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  email     text,
  role      text not null default 'retail' check (role in ('day','retail','institutional','executive')),
  plan      text not null default 'retail' check (plan in ('day','retail','full')),
  created_at timestamptz not null default now()
);

create table if not exists public.watchlists (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users(id) on delete cascade,
  name     text not null check (char_length(name) between 1 and 40),
  symbols  text[] not null default '{}',
  position int  not null default 0,
  unique (user_id, name)
);

-- the 5–6 tickers a Day Trader / Retail Investor personalises the dashboard around
create table if not exists public.preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  focus   text[] not null default '{}' check (cardinality(focus) <= 6),
  updated_at timestamptz not null default now()
);

alter table public.profiles    enable row level security;
alter table public.watchlists  enable row level security;
alter table public.preferences enable row level security;

create policy "own profile read"   on public.profiles for select using (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
-- column-level: the browser may only touch `role`
revoke update on public.profiles from anon, authenticated;
grant  update (role) on public.profiles to authenticated;

create policy "own watchlists" on public.watchlists  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own prefs"      on public.preferences for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Sign-up trigger: builds the profile from the metadata the app sends. The metadata is user-controlled, so a client could
-- ask for plan='full'. For real billing, change the default below to 'retail' and ignore metadata.plan; grant paid plans from your webhook:
--   update public.profiles set plan = 'full' where id = '<uid>';
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare p text := coalesce(new.raw_user_meta_data->>'plan', 'retail');
        r text := coalesce(new.raw_user_meta_data->>'role', 'retail');
begin
  if p not in ('day','retail','full') then p := 'retail'; end if;
  if r not in ('day','retail','institutional','executive') then r := 'retail'; end if;
  insert into public.profiles(id, email, role, plan) values (new.id, new.email, r, p);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
