-- UpCircuit · persisted SmartAPI ticks (run once in the Supabase SQL editor)
-- Written ONLY by the Next.js server with SUPABASE_SERVICE_ROLE_KEY (/api/market/ticks); read ONLY by /api/market/replay and /export-csv.
-- RLS is enabled with NO policies → the browser's anon / user keys can neither read nor write this table.

create table if not exists public.market_ticks (
  id            bigint generated always as identity primary key,
  symbol        text           not null,
  ltp           numeric(14,2)  not null check (ltp > 0),
  high          numeric(14,2)  not null check (high > 0),
  low           numeric(14,2)  not null check (low > 0),
  volume        bigint         not null default 0,
  ts            timestamptz    not null,            -- exchange timestamp (09:15–15:30 IST only; enforced by the API)
  trading_date  date           not null,            -- IST calendar day
  unique (symbol, ts)                               -- many browsers log the same ticks; duplicates are ignored
);

create index if not exists market_ticks_day_symbol_ts on public.market_ticks (trading_date, symbol, ts);

alter table public.market_ticks enable row level security;
-- (intentionally no policies)

-- Storage: ~1 row / symbol / 15 s ≈ 1 500 rows per symbol per session. Keep two weeks:
-- delete from public.market_ticks where trading_date < (now() at time zone 'Asia/Kolkata')::date - 14;
