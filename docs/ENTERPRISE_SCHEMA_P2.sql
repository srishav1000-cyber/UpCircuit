-- UpCircuit Week 8 · P2 — run AFTER the P0 + P1 schemas. Re-runnable.
--  • append-only EVENT LOG with consumer-group offsets, replay and an exactly-once consumer (Kafka semantics on PostgreSQL; docs/SCALE_OUT.md maps it to Kafka)
--  • saved layouts column

/* ───────── event log ───────── */
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

/* ───────── a materialised view built by a consumer (demo: circuit events per trading day and direction) ───────── */
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

revoke execute on function public.event_publish(text, text, jsonb), public.circuit_events_publish(), public.event_poll(text, text, int), public.event_commit(text, text, bigint), public.event_reset(text, text, bigint), public.event_lag(text, text), public.consume_circuit_stats(text, int), public.replay_circuit_stats(text) from public, anon, authenticated;
grant execute on function public.event_publish(text, text, jsonb), public.event_poll(text, text, int), public.event_commit(text, text, bigint), public.event_reset(text, text, bigint), public.event_lag(text, text), public.consume_circuit_stats(text, int), public.replay_circuit_stats(text) to service_role;

/* ───────── saved layouts ───────── */
alter table public.preferences add column if not exists layouts jsonb;
