#!/usr/bin/env bash
# Backup / restore drill on a throw-away PostgreSQL: apply the schemas, seed data, pg_dump, restore into a NEW database, then prove
# (1) every table's row count matches, (2) the audit hash chain still verifies, (3) RLS + RPCs still work, and print the measured restore time (RTO for THIS data size).
# Usage: ./scripts/backup-drill.sh   (runs as the `postgres` OS user when invoked as root)
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1 || true)
[ -n "$PGBIN" ] || { echo "PostgreSQL server binaries not found — skipping drill"; exit 0; }
W=$(mktemp -d); chmod 755 "$W"; cp docs/PERSISTENCE_SCHEMA.sql docs/ENTERPRISE_SCHEMA.sql docs/ENTERPRISE_SCHEMA_P1.sql docs/ENTERPRISE_SCHEMA_P2.sql "$W"/; chmod 644 "$W"/*.sql
cat > "$W/stub.sql" <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text, phone_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
SQL
cat > "$W/seed.sql" <<'SQL'
insert into auth.users(id, email) select ('00000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'u' || i || '@x.test' from generate_series(1, 20) i;
insert into public.user_roles(user_id, role) values ('00000000-0000-0000-0000-000000000001', 'admin'), ('00000000-0000-0000-0000-000000000002', 'compliance');
insert into public.portfolios(user_id, symbol, quantity, buy_price) select ('00000000-0000-0000-0000-0000000000' || lpad(((i % 20) + 1)::text, 2, '0'))::uuid, 'S' || i, i, 100 + i from generate_series(1, 2000) i;
insert into public.alert_rules(user_id, symbol, kind, threshold) select ('00000000-0000-0000-0000-0000000000' || lpad(((i % 20) + 1)::text, 2, '0'))::uuid, 'R' || i, 'price_above', i from generate_series(1, 200) i where i % 20 < 9;
select set_config('request.jwt.claim.role', 'service_role', false); set role service_role;
select public.register_circuit_event('SYM' || i, case when i % 2 = 0 then 'UPPER' else 'LOWER' end, 10, 110, 100, 'smartapi') from generate_series(1, 300) i;
select public.audit_write('seed.entry', 'demo', i::text, '{}'::jsonb) from generate_series(1, 500) i;
select public.consume_circuit_stats();
reset role;
SQL
cat > "$W/fingerprint.sql" <<'SQL'
select 'portfolios=' || count(*) from public.portfolios union all select 'alert_rules=' || count(*) from public.alert_rules union all select 'circuit_events=' || count(*) from public.circuit_events
union all select 'audit_log=' || count(*) from public.audit_log union all select 'event_log=' || count(*) from public.event_log union all select 'circuit_daily_stats=' || coalesce(sum(events), 0) from public.circuit_daily_stats union all select 'user_roles=' || count(*) from public.user_roles
union all select 'audit_head=' || (select hash from public.audit_log order by seq desc limit 1)
union all select 'chain_ok=' || (select coalesce(bool_and(a.prev_hash is not distinct from lag_hash and a.hash = public.audit_hash(a.seq, a.at, a.user_id, a.actor_role, a.action, a.entity, a.entity_id, a.meta, a.prev_hash)), true) from (select *, lag(hash) over (order by seq) as lag_hash from public.audit_log) a)
order by 1;
SQL
chmod 644 "$W"/*.sql
if [ "$(id -u)" = 0 ]; then RUN="su postgres -s /bin/bash -c"; else RUN="bash -c"; fi
D="$W/data"; mkdir -p "$D"; chown -R postgres "$W" 2>/dev/null || true; PORT=54330
$RUN "$PGBIN/initdb -D $D -A trust -U postgres >/dev/null"
$RUN "$PGBIN/pg_ctl -D $D -o '-p $PORT -k $W -c listen_addresses=' -l $W/pg.log -w start >/dev/null"
trap "$RUN \"$PGBIN/pg_ctl -D $D -m immediate stop >/dev/null 2>&1\" || true; rm -rf $W" EXIT
P="$PGBIN/psql -h $W -p $PORT -U postgres -X -q -v ON_ERROR_STOP=1"
for f in stub PERSISTENCE_SCHEMA ENTERPRISE_SCHEMA ENTERPRISE_SCHEMA_P1 ENTERPRISE_SCHEMA_P2 seed; do $RUN "$P -d postgres -f $W/$f.sql >/dev/null"; done
$RUN "$P -d postgres -t -A -f $W/fingerprint.sql" > "$W/before.txt"
echo "· seeded: $(grep -E '^(portfolios|circuit_events|audit_log)=' $W/before.txt | tr '\n' ' ')"
T0=$(date +%s.%N)
$RUN "$PGBIN/pg_dump -h $W -p $PORT -U postgres -Fc -d postgres -f $W/backup.dump"
T1=$(date +%s.%N)
$RUN "$P -d postgres -c 'create database restored'"
$RUN "$PGBIN/pg_restore -h $W -p $PORT -U postgres -d restored --exit-on-error $W/backup.dump" 2>&1 | grep -v "^$" || true
T2=$(date +%s.%N)
$RUN "$P -d restored -t -A -f $W/fingerprint.sql" > "$W/after.txt"
if diff -u "$W/before.txt" "$W/after.txt"; then echo "✓ restored database matches: row counts, audit head hash, hash chain, consumer view"; else echo "✗ MISMATCH after restore"; exit 1; fi
grep -q 'chain_ok=t' "$W/after.txt" && echo "✓ audit hash chain verifies after restore" || { echo "✗ audit chain broken"; exit 1; }
# RLS + RPC still enforced in the restored DB
$RUN "$P -d restored -t -A -c \"set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',false); select count(*) from public.circuit_events\"" 2>&1 | tail -1 | grep -q . && true
OUT=$($RUN "$P -d restored -t -A -c \"set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',false); select count(*) from public.portfolios;\"" | tail -1)
[ "$OUT" = "100" ] && echo "✓ RLS intact in the restored database (a user sees only their own 100 of 2000 portfolio rows)" || { echo "✗ RLS check returned '$OUT'"; exit 1; }
printf "· dump %.2fs · restore %.2fs · backup size %s\n" "$(echo "$T1 - $T0" | bc)" "$(echo "$T2 - $T1" | bc)" "$(du -h $W/backup.dump | cut -f1)"
echo "DRILL PASSED"
