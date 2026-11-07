-- UpCircuit Week 9 / Turn 42 — real-time closed-app alert pipeline.
-- Run AFTER docs/ENTERPRISE_SCHEMA.sql (needs alert_rules, alert_deliveries). Safe to re-run.
--   • latency columns on alert_deliveries (tick → daemon match → push accepted → service-worker ack → displayed)
--   • Supabase Realtime publication on alert_rules (the daemon syncs its in-memory rule index from it)
--   • claim_alert_rule(rule_id, window_key): atomic, idempotent once-per-window claim (two daemons / a daemon + the cron backstop can never both send)

/* ───────────── 1. latency columns ───────────── */
alter table public.alert_deliveries
  add column if not exists tick_time          timestamptz,   -- exchange timestamp of the tick that crossed the rule (feed clock, second resolution)
  add column if not exists daemon_matched_at  timestamptz,   -- daemon clock: rule matched
  add column if not exists push_sent_at       timestamptz,   -- daemon clock: first device accepted by its push service (HTTP 201)
  add column if not exists sw_ack_at          timestamptz,   -- server clock: service-worker ACK received by /api/alerts/ack
  add column if not exists displayed_at       timestamptz;   -- DEVICE clock: notification shown (may be skewed vs the server)
create index if not exists alert_deliveries_push_recent on public.alert_deliveries (fired_at desc) where channel = 'push';
-- the existing grants already cover these columns: users may SELECT their own rows; only the service role writes them.

/* ───────────── 2. Realtime on alert_rules ───────────── */
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alert_rules') then
      alter publication supabase_realtime add table public.alert_rules;
    end if;
  else
    raise notice 'publication supabase_realtime not found — enable Realtime for alert_rules in the Supabase dashboard (Database → Replication)';
  end if;
end $$;

/* ───────────── 3. claim_alert_rule(rule_id, window_key) ───────────── */
create table if not exists public.alert_claims (
  rule_id    uuid not null references public.alert_rules(id) on delete cascade,
  window_key text not null check (length(window_key) between 1 and 200),
  claimed_at timestamptz not null default now(),
  primary key (rule_id, window_key)
);
create index if not exists alert_claims_age on public.alert_claims (claimed_at);
alter table public.alert_claims enable row level security;      -- no policies: only the security-definer function (and the service role) touch it
revoke all on public.alert_claims from anon, authenticated;

/** worker/daemon only. TRUE for exactly ONE caller per (rule, window): serialises on a per-rule advisory lock, enforces the rule's cooldown
    and enabled flag, stamps last_triggered_at, and records the window key so a retried / duplicated dispatch is idempotent. */
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
  if ins = 0 then return false; end if;                                                     -- this exact window was already claimed (rule row untouched)
  update public.alert_rules set last_triggered_at = now() where id = p_rule;
  if random() < 0.01 then delete from public.alert_claims where claimed_at < now() - interval '7 days'; end if;
  return true;
end $$;
revoke execute on function public.claim_alert_rule(uuid, text) from public, anon, authenticated;   -- Supabase grants EXECUTE to API roles by default
grant  execute on function public.claim_alert_rule(uuid, text) to service_role;
-- the one-argument claim_alert_rule(uuid) from ENTERPRISE_SCHEMA.sql stays: the cron worker (/api/worker/alerts) still uses it as the backstop.
