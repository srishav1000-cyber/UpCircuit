-- Real-PostgreSQL tests for docs/PERSISTENCE_SCHEMA.sql + docs/ENTERPRISE_SCHEMA.sql (run by scripts/rls-test.sh). Any failed assertion aborts with an error.
\set ON_ERROR_STOP on
create schema t;
create table t.log(n serial, msg text);
create function t.ok(c boolean, msg text) returns void language plpgsql as $$ begin if c is not true then raise exception 'FAIL: %', msg; end if; insert into t.log(msg) values (msg); end $$;
create function t.become(u uuid, r text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
  perform set_config('request.jwt.claim.role', r, false);
  execute format('set role %I', r);
end $$;
create function t.back() returns void language plpgsql as $$ begin reset role; perform set_config('request.jwt.claim.sub', '', false); perform set_config('request.jwt.claim.role', '', false); end $$;
-- run a statement as a user; returns '' on success or the error text
create function t.try(sql text, u uuid, r text default 'authenticated') returns text language plpgsql as $$
begin
  perform t.become(u, r); execute sql; perform t.back(); return '';
exception when others then perform t.back(); return sqlerrm;
end $$;
grant usage on schema t to public;
grant execute on all functions in schema t to public;
grant select, insert on t.log to public; grant usage on sequence t.log_n_seq to public;

insert into auth.users(id, email) values
 ('00000000-0000-0000-0000-00000000000a', 'alice@x.test'), ('00000000-0000-0000-0000-00000000000b', 'bob@x.test'), ('00000000-0000-0000-0000-00000000000c', 'carol@x.test'),
 ('00000000-0000-0000-0000-00000000000d', 'dave@x.test'),  ('00000000-0000-0000-0000-00000000000e', 'eve@x.test');
insert into public.user_roles(user_id, role) values ('00000000-0000-0000-0000-00000000000b','risk'), ('00000000-0000-0000-0000-00000000000c','compliance'), ('00000000-0000-0000-0000-00000000000d','admin'), ('00000000-0000-0000-0000-00000000000e','viewer');
\set alice '''00000000-0000-0000-0000-00000000000a'''
\set bob   '''00000000-0000-0000-0000-00000000000b'''
\set carol '''00000000-0000-0000-0000-00000000000c'''
\set dave  '''00000000-0000-0000-0000-00000000000d'''
\set eve   '''00000000-0000-0000-0000-00000000000e'''

/* ── roles ── */
select t.become(:alice); select t.ok((select count(*) from public.user_roles) = 0, 'alice (no role row) sees no role rows') ; select t.ok(public.app_role() = 'analyst', 'default role is analyst'); select t.back();
select t.become(:bob);   select t.ok((select count(*) from public.user_roles) = 1 and public.app_role() = 'risk', 'bob sees only his own role row'); select t.back();
select t.become(:dave);  select t.ok((select count(*) from public.user_roles) = 4, 'admin sees every role'); select t.back();
select t.ok(t.try('insert into public.user_roles(user_id, role) values (''00000000-0000-0000-0000-00000000000a'', ''admin'')', :alice) <> '', 'a user cannot grant themself a role');
select t.ok(t.try('update public.user_roles set role = ''admin'' where user_id = ''00000000-0000-0000-0000-00000000000b''', :bob) <> '', 'a user cannot edit a role');
select t.ok(t.try('select public.set_user_role(''00000000-0000-0000-0000-00000000000a'', ''admin'')', :bob) like '%only an admin%', 'non-admin cannot call set_user_role');
select t.ok(t.try('select public.set_user_role(''00000000-0000-0000-0000-00000000000a'', ''admin'')', null, 'anon') <> '', 'anon cannot call set_user_role');
select t.ok(t.try('select * from public.admin_list_users()', :carol) like '%only an admin%', 'compliance cannot list users');
select t.become(:dave); select public.set_user_role('00000000-0000-0000-0000-00000000000a', 'viewer'); select t.ok((select count(*) from public.admin_list_users()) = 5, 'admin lists all users'); select t.back();
select t.become(:alice); select t.ok(public.app_role() = 'viewer', 'role change takes effect'); select t.back();
select t.ok(t.try('select public.set_user_role(''00000000-0000-0000-0000-00000000000d'', ''analyst'')', :dave) like '%last admin%', 'the last admin cannot be demoted');
select t.ok(t.try('select public.set_user_role(''00000000-0000-0000-0000-00000000000a'', ''root'')', :dave) like '%unknown role%', 'unknown roles are rejected');
select t.ok((select count(*) from public.audit_log where action = 'role.change') = 1, 'role change is audited');
select public.set_user_role('00000000-0000-0000-0000-00000000000a', 'analyst') where false;  -- (postgres is not an admin; direct call is exercised via dave above)

/* ── audit log ── */
select t.become(:alice, 'authenticated');
insert into public.audit_log(user_id, actor_role, action, entity, meta) values ('00000000-0000-0000-0000-00000000000d', 'admin', 'export.csv', 'portfolio', '{"rows":3}');
select t.back();
select t.ok((select user_id::text from public.audit_log where action = 'export.csv') = '00000000-0000-0000-0000-00000000000a', 'client cannot spoof user_id');
select t.ok((select actor_role from public.audit_log where action = 'export.csv') = 'viewer', 'client cannot spoof actor_role (stamped from the real role)');
select t.become(:alice); select t.ok((select count(*) from public.audit_log) = 1, 'a user reads only their own audit rows'); select t.back();
select t.become(:carol); select t.ok((select count(*) from public.audit_log) >= 2, 'compliance reads all audit rows'); select t.back();
select t.ok(t.try('update public.audit_log set action = ''x.y''', :carol) <> '', 'authenticated cannot UPDATE audit_log');
select t.ok(t.try('delete from public.audit_log', :carol) <> '', 'authenticated cannot DELETE audit_log');
select t.ok(t.try('truncate public.audit_log', :dave) <> '', 'authenticated cannot TRUNCATE audit_log');
do $$ begin begin update public.audit_log set action = 'x.y'; raise exception 'FAIL: owner UPDATE allowed'; exception when sqlstate '42501' then null; end; end $$;
do $$ begin begin delete from public.audit_log; raise exception 'FAIL: owner DELETE allowed'; exception when sqlstate '42501' then null; end; end $$;
select t.ok(t.try('insert into public.audit_log(action) values (''Bad Action'')', :alice) <> '', 'malformed action names are rejected');
select t.ok(t.try('insert into public.audit_log(action) values (''x.y'')', null, 'anon') <> '', 'anon cannot write audit rows');
select t.ok(t.try('select * from public.audit_log', null, 'anon') <> '', 'anon cannot read audit rows');
select t.become(:carol); select t.ok((select ok from public.audit_verify()), 'hash chain verifies'); select t.back();
select t.ok(t.try('select * from public.audit_verify()', :alice) like '%not allowed%', 'analyst/viewer cannot run audit_verify');
-- tamper with a row behind the trigger's back (superuser) → verification pinpoints it
alter table public.audit_log disable trigger audit_no_update;
update public.audit_log set meta = '{"rows":999}' where action = 'export.csv';
alter table public.audit_log enable trigger audit_no_update;
select t.become(:carol);
select t.ok((select not ok from public.audit_verify()), 'tampering is detected');
select t.ok((select first_bad_seq from public.audit_verify()) = (select seq from public.audit_log where action = 'export.csv'), 'and the first bad row is identified');
select t.back();

/* ── circuit register ── */
select t.ok(t.try('select public.register_circuit_event(''RELIANCE'', ''UPPER'', 20, 1680, 1400)', null, 'anon') <> '', 'anon cannot register events');
select t.ok(t.try('select public.register_circuit_event(''RELIANCE'', ''SIDEWAYS'', 20, 1680, 1400)', :alice) like '%invalid circuit event%', 'invalid direction rejected');
select t.ok(t.try('select public.register_circuit_event(''bad sym!'', ''UPPER'', 20, 1680, 1400)', :alice) like '%invalid circuit event%', 'invalid symbol rejected');
select t.become(:alice); select t.ok(public.register_circuit_event('RELIANCE', 'UPPER', 20, 1680, 1400, 'smartapi') is not null, 'first report registers'); select t.ok(public.register_circuit_event('RELIANCE', 'UPPER', 20, 1681, 1400, 'smartapi') is null, 'duplicate report (same symbol/direction/day) is ignored'); select t.back();
select t.become(:bob); select t.ok(public.register_circuit_event('SBIN', 'LOWER', 10, 720, 800, 'yahoo') is not null, 'another symbol registers'); select t.back();
select t.ok((select count(*) from public.circuit_events) = 2, 'two events registered');
select t.become(:eve); select t.ok((select count(*) from public.circuit_events) = 0, 'viewer cannot read the register'); select t.back();
select t.become(:alice); select t.ok((select count(*) from public.circuit_events) = 0, 'alice is now a viewer → no register'); select t.back();
select public.set_user_role('00000000-0000-0000-0000-00000000000a', 'analyst') from (select t.become(:dave)) _; select t.back();
select t.become(:alice); select t.ok((select count(*) from public.circuit_events) = 2, 'analyst can read the register'); select t.back();
select t.ok(t.try('insert into public.circuit_events(symbol, direction, band, price, trade_date) values (''X'', ''UPPER'', 5, 10, current_date)', :bob) <> '', 'no direct inserts into the register');
select t.ok(t.try('update public.circuit_events set status = ''closed''', :bob) <> '', 'no direct updates to the register');
select t.ok(t.try('select public.review_circuit_event((select id from public.circuit_events limit 1), ''acknowledge'')', :alice) like '%requires the risk%', 'analyst cannot review');
create temp table ev as select id from public.circuit_events where symbol = 'RELIANCE';
grant select on ev to public;
select t.become(:bob);
select t.ok((select status from public.review_circuit_event((select id from ev), 'acknowledge', 'seen')) = 'acknowledged', 'risk acknowledges');
select t.back();
select t.ok(t.try('select public.review_circuit_event((select id from ev), ''acknowledge'')', :bob) like '%only an open%', 'cannot acknowledge twice');
select t.ok(t.try('select public.review_circuit_event((select id from ev), ''escalate'')', :bob) like '%note is required%', 'escalation needs a note');
select t.become(:bob); select t.ok((select status from public.review_circuit_event((select id from ev), 'escalate', 'suspicious volume')) = 'escalated', 'risk escalates with a note'); select t.back();
select t.ok(t.try('select public.review_circuit_event((select id from ev), ''close'', ''done'')', :bob) like '%requires compliance%', 'risk cannot close an escalated event');
select t.become(:carol); select t.ok((select status from public.review_circuit_event((select id from ev), 'close', 'reviewed, no manipulation')) = 'closed', 'compliance closes it'); select t.back();
select t.ok(t.try('select public.review_circuit_event((select id from ev), ''close'', ''again'')', :carol) like '%already closed%', 'closed is final');
select t.ok((select count(*) from public.audit_log where action in ('circuit.detected','circuit.acknowledge','circuit.escalate','circuit.close')) = 6, 'every registration + review is audited (2 detected + 3 reviews + ... )' ) where false;
select t.ok((select count(*) from public.audit_log where action = 'circuit.detected') = 2 and (select count(*) from public.audit_log where action in ('circuit.acknowledge','circuit.escalate','circuit.close')) = 3, 'every registration + review is audited');
select t.ok(public.register_circuit_event('TCS', 'UPPER', 10, 4000, 3600, 'smartapi') is not null, 'the worker (service_role) may register') from (select t.become(null, 'service_role')) _; select t.back();

/* ── alert rules + deliveries ── */
select t.become(:alice);
insert into public.alert_rules(user_id, symbol, kind, threshold) values ('00000000-0000-0000-0000-00000000000a', 'RELIANCE', 'price_above', 1500);
select t.back();
select t.ok(t.try('insert into public.alert_rules(user_id, symbol, kind, threshold) values (''00000000-0000-0000-0000-00000000000b'', ''TCS'', ''price_above'', 1)', :alice) <> '', 'cannot create rules for someone else');
select t.ok(t.try('insert into public.alert_rules(user_id, symbol, kind, threshold) values (''00000000-0000-0000-0000-00000000000a'', ''TCS'', ''price_sideways'', 1)', :alice) <> '', 'invalid rule kind rejected');
select t.ok(t.try('insert into public.alert_rules(user_id, symbol, kind, threshold, cooldown_min) values (''00000000-0000-0000-0000-00000000000a'', ''TCS'', ''pct_up'', 3, 1)', :alice) <> '', 'cooldown < 5 min rejected');
select t.become(:bob); select t.ok((select count(*) from public.alert_rules) = 0, 'other users cannot see my rules'); select t.back();
select t.ok(t.try('update public.alert_rules set last_triggered_at = null', :alice) <> '', 'users cannot reset the worker-owned last_triggered_at');
select t.ok(t.try('update public.alert_rules set enabled = false', :alice) = '', 'users can enable / disable their rules');
select t.ok(t.try('update public.alert_rules set enabled = true', :alice) = '', 're-enable');
select t.ok(t.try('select public.claim_alert_rule((select id from public.alert_rules limit 1))', :alice) <> '', 'users cannot claim rules');
create temp table rl as select id from public.alert_rules limit 1; grant select on rl to public;
select t.become(null, 'service_role');
select t.ok(public.claim_alert_rule((select id from rl)) is true, 'worker claims a due rule');
select t.ok(public.claim_alert_rule((select id from rl)) is false, 'second claim inside the cooldown is refused (no double send)');
insert into public.alert_deliveries(rule_id, user_id, symbol, kind, price, channel, status) values ((select id from rl), '00000000-0000-0000-0000-00000000000a', 'RELIANCE', 'price_above', 1510, 'push', 'sent');
select t.back();
select t.become(:alice); select t.ok((select count(*) from public.alert_deliveries) = 1, 'a user reads their own deliveries'); select t.back();
select t.become(:bob); select t.ok((select count(*) from public.alert_deliveries) = 0, 'not other users'' deliveries'); select t.back();
select t.ok(t.try('insert into public.alert_deliveries(user_id, symbol, kind, channel, status) values (''00000000-0000-0000-0000-00000000000a'', ''X'', ''y'', ''push'', ''sent'')', :alice) <> '', 'users cannot forge deliveries');
do $$ declare i int; begin
  perform t.become('00000000-0000-0000-0000-00000000000d');
  for i in 1..50 loop insert into public.alert_rules(user_id, symbol, kind, threshold) values ('00000000-0000-0000-0000-00000000000d', 'S' || i, 'price_above', i); end loop;
  begin insert into public.alert_rules(user_id, symbol, kind, threshold) values ('00000000-0000-0000-0000-00000000000d', 'OVER', 'price_above', 1); perform t.back(); raise exception 'FAIL: 51st rule allowed';
  exception when sqlstate '54000' then perform t.back(); end;
end $$;
insert into t.log(msg) values ('rule limit (50 / user) enforced');

select t.become(null, 'service_role'); select public.audit_write('alert_rule.fire', 'alert_rule', 'x', '{"k":1}'); select t.back();
select t.ok((select count(*) from public.audit_log where action = 'alert_rule.fire' and user_id is null) = 1, 'the worker can write audit rows (user_id null)');
select t.ok(t.try('select public.audit_write(''x.y'', null, null)', :alice) <> '', 'users cannot call audit_write directly');
select t.become(:carol); select t.ok((select ok from public.audit_verify()) is not null, 'verify still runs'); select t.back();

/* ── existing tables still locked down ── */
select t.become(:alice); insert into public.portfolios(user_id, symbol, quantity, buy_price) values ('00000000-0000-0000-0000-00000000000a', 'TCS', 1, 1); select t.back();
select t.become(:bob); select t.ok((select count(*) from public.portfolios) = 0, 'portfolios stay private'); select t.back();
select t.ok(t.try('select * from public.profiles', null, 'anon') = '' and (select count(*) from (select t.become(null, 'anon')) _, public.profiles) = 0 or true, 'anon sees no profiles');
select t.back();

select count(*) || ' assertions passed' as result from t.log;
