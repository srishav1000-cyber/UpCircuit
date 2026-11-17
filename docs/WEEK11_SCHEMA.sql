-- Week 11: cross-device UI preferences + labelled push devices. Re-runnable. Apply after PERSISTENCE_SCHEMA / WEEK10_SCHEMA.

-- chart timeframe + indicator toggles ({ tf, ind:{ema20,ema50,vwap,rsi}, updatedAt }) follow the account
alter table public.preferences add column if not exists ui jsonb;
alter table public.preferences drop constraint if exists preferences_ui_shape;
alter table public.preferences add constraint preferences_ui_shape check (ui is null or (jsonb_typeof(ui) = 'object' and pg_column_size(ui) < 2000));

-- one row per registered browser/phone; the label ("Android · Chrome", "iPhone · Home Screen PWA") is shown in Settings → Alert Channels
alter table public.push_subscriptions add column if not exists label text check (label is null or char_length(label) <= 80);
alter table public.push_subscriptions add column if not exists platform text check (platform is null or char_length(platform) <= 24);
alter table public.push_subscriptions add column if not exists last_seen timestamptz not null default now();
alter table public.push_subscriptions add column if not exists created_at timestamptz not null default now();
