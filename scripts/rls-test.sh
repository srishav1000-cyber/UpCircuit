#!/usr/bin/env bash
# Applies docs/PERSISTENCE_SCHEMA.sql + docs/ENTERPRISE_SCHEMA.sql to a throw-away local PostgreSQL (Supabase-like roles + auth stub) and runs scripts/rls_test.sql.
# Needs the PostgreSQL server binaries (initdb, pg_ctl, psql). Runs as the `postgres` OS user when invoked as root.
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1 || true)
[ -n "$PGBIN" ] || { echo "PostgreSQL server binaries not found — skipping RLS tests"; exit 0; }
W=$(mktemp -d); chmod 755 "$W"; cp docs/PERSISTENCE_SCHEMA.sql docs/ENTERPRISE_SCHEMA.sql docs/ENTERPRISE_SCHEMA_P1.sql scripts/rls_test.sql "$W"/; chmod 644 "$W"/*.sql
cat > "$W/stub.sql" <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text, phone_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
grant usage on schema public, auth to anon, authenticated, service_role;
-- Supabase's defaults: every new table / function in public is open to the API roles (the schema must lock them down itself)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
SQL
chmod 644 "$W/stub.sql"
if [ "$(id -u)" = 0 ]; then RUN="su postgres -s /bin/bash -c"; else RUN="bash -c"; fi
D="$W/data"; mkdir -p "$D"; chown -R postgres "$W" 2>/dev/null || true; PORT=54329
$RUN "$PGBIN/initdb -D $D -A trust -U postgres >/dev/null"
$RUN "$PGBIN/pg_ctl -D $D -o '-p $PORT -k $W -c listen_addresses=' -l $W/pg.log -w start >/dev/null"
trap "$RUN \"$PGBIN/pg_ctl -D $D -m immediate stop >/dev/null 2>&1\" || true; rm -rf $W" EXIT
PSQL="$PGBIN/psql -h $W -p $PORT -U postgres -d postgres -X -q -v ON_ERROR_STOP=1"
for f in stub PERSISTENCE_SCHEMA ENTERPRISE_SCHEMA ENTERPRISE_SCHEMA_P1; do $RUN "$PSQL -f $W/$f.sql >/dev/null"; done
echo "· schemas applied; applying twice to prove they are re-runnable"
for f in PERSISTENCE_SCHEMA ENTERPRISE_SCHEMA ENTERPRISE_SCHEMA_P1; do $RUN "$PSQL -f $W/$f.sql >/dev/null"; done
$RUN "$PSQL -t -A -f $W/rls_test.sql" | tail -3
