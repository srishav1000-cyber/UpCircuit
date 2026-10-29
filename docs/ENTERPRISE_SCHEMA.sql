-- UpCircuit — Week 8 enterprise schema (Supabase / PostgreSQL). Run AFTER docs/PERSISTENCE_SCHEMA.sql. Re-runnable.
--
--  • user_roles        RBAC: viewer < analyst < risk < compliance < admin. Users can READ their own role; only an admin (via set_user_role) can change one.
--                      Bootstrap the first admin once, from the SQL editor:  insert into public.user_roles(user_id, role) values ('<your auth.users id>', 'admin');
--  • audit_log         append-only, hash-chained (each row hashes the previous one) — UPDATE / DELETE / TRUNCATE raise, audit_verify() proves integrity.
--  • circuit_events    the surveillance register: ONE row per (symbol, direction, IST trade date), reviewed by risk / compliance (acknowledge → escalate → close).
--  • alert_rules       user-defined server-side alert rules (evaluated by /api/worker/alerts even when no browser tab is open) + alert_deliveries log.
--
-- Everything is Row Level Security protected. Tested against a real PostgreSQL by scripts/rls-test.sh.

create extension if not exists pgcrypto;

/* ───────────────────────── roles ───────────────────────── */
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

/* ───────────────────────── audit log (append-only + hash chain) ───────────────────────── */
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

/* ───────────────────────── role administration ───────────────────────── */
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

/* ───────────────────────── circuit surveillance register ───────────────────────── */
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

/* ───────────────────────── server-side alert rules ───────────────────────── */
create table if not exists public.alert_rules (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  symbol            text not null check (symbol ~ '^[A-Za-z0-9&._-]{1,24}$'),
  kind              text not null check (kind in ('price_above','price_below','pct_up','pct_down','circuit_proximity')),
  threshold         numeric not null check (threshold > 0 and threshold < 10000000),
  cooldown_min      int not null default 60 check (cooldown_min between 5 and 1440),
  channels          jsonb not null default '{"push": true, "email": false}'::jsonb,
  enabled           boolean not null default true,
  last_triggered_at timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists alert_rules_enabled on public.alert_rules (enabled, symbol);
create or replace function public.alert_rules_limit() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.alert_rules where user_id = new.user_id) >= 50 then raise exception 'at most 50 alert rules per user' using errcode = '54000'; end if;
  return new;
end $$;
drop trigger if exists alert_rules_limit on public.alert_rules;
create trigger alert_rules_limit before insert on public.alert_rules for each row execute function public.alert_rules_limit();

create table if not exists public.alert_deliveries (
  id       uuid primary key default gen_random_uuid(),
  rule_id  uuid references public.alert_rules(id) on delete set null,
  user_id  uuid not null references auth.users(id) on delete cascade,
  fired_at timestamptz not null default now(),
  symbol   text not null,
  kind     text not null,
  price    numeric,
  channel  text not null check (channel in ('push','email','inapp')),
  status   text not null check (status in ('sent','failed','skipped')),
  detail   text
);
create index if not exists alert_deliveries_user_time on public.alert_deliveries (user_id, fired_at desc);

alter table public.alert_rules      enable row level security;
alter table public.alert_deliveries enable row level security;
drop policy if exists "Users access own data" on public.alert_rules;
drop policy if exists "read own deliveries" on public.alert_deliveries;
create policy "Users access own data" on public.alert_rules for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "read own deliveries" on public.alert_deliveries for select using (auth.uid() = user_id);
revoke all on public.alert_rules, public.alert_deliveries from anon, authenticated;
grant select, insert, update, delete on public.alert_rules to authenticated;
revoke update on public.alert_rules from authenticated;
grant update (symbol, kind, threshold, cooldown_min, channels, enabled) on public.alert_rules to authenticated;   -- last_triggered_at belongs to the worker
grant select on public.alert_deliveries to authenticated;

/** worker only (service role): atomically claims a rule once per cooldown → two overlapping worker runs can never double-send */
create or replace function public.claim_alert_rule(p_rule uuid) returns boolean language plpgsql security definer set search_path = public as $$
declare hit int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'worker only' using errcode = '42501'; end if;
  update public.alert_rules set last_triggered_at = now()
   where id = p_rule and enabled and (last_triggered_at is null or last_triggered_at <= now() - make_interval(mins => cooldown_min));
  get diagnostics hit = row_count;
  return hit = 1;
end $$;

/* ───────────────────────── function privileges ───────────────────────── */
revoke execute on all functions in schema public from public, anon, authenticated;   -- Supabase grants EXECUTE to anon / authenticated by default; allow-list below
grant execute on function public.app_role(), public.has_role(text[]) to anon, authenticated, service_role;
grant execute on function public.audit_verify(), public.set_user_role(uuid, text), public.admin_list_users(),
  public.register_circuit_event(text, text, numeric, numeric, numeric, text), public.review_circuit_event(uuid, text, text) to authenticated, service_role;
grant execute on function public.claim_alert_rule(uuid) to service_role;
grant execute on function public.audit_write(text, text, text, jsonb) to service_role;
