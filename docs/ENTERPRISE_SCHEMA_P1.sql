-- UpCircuit Week 8 · P1 — run AFTER PERSISTENCE_SCHEMA.sql and ENTERPRISE_SCHEMA.sql. Re-runnable.
--  • plan-based alert-rule limits  • risk limits + scheduled report opt-in  • AI output governance (human sign-off)  • DPDP: export_my_data() / delete_my_data()

/* ───────── plan-aware alert-rule limit (day 5 · retail 15 · full 50) ───────── */
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

/* ───────── risk limits (per user) ───────── */
alter table public.preferences add column if not exists risk_limits jsonb;
alter table public.preferences add column if not exists risk_report boolean not null default false;

/* ───────── AI output governance ───────── */
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

/** a human accepts / rejects an AI-generated output; the record (model, prompt version, data used, hash of the exact text) goes to the audit trail too */
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

/* ───────── DPDP Act 2023: access / portability and erasure ───────── */
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

/** erases the caller's personal data. Audit entries are kept (legal-obligation / security exception) but are no longer linked to a person once the auth user is removed. The auth user itself is removed by the server route (needs the service key). */
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

revoke execute on function public.sign_off_ai_output(text, text, text, text, jsonb, text, text, text), public.export_my_data(), public.delete_my_data() from public, anon, authenticated;
grant execute on function public.sign_off_ai_output(text, text, text, text, jsonb, text, text, text), public.export_my_data(), public.delete_my_data() to authenticated, service_role;
