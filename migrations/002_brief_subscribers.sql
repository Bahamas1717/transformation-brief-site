-- Migration: Brief subscribers
-- Run this in the Supabase SQL Editor of the same project that backs bvf-app.
-- Idempotent, safe to re-run.

-- 1. Table

create table if not exists public.brief_subscribers (
  id              uuid          primary key default gen_random_uuid(),
  email           text          not null,
  source          text,
  anon_token      text,
  user_agent      text,
  created_at      timestamptz   not null default now(),
  unsubscribed_at timestamptz,

  constraint brief_subscribers_email_shape
    check (position('@' in email) > 1 and length(email) between 5 and 254)
);

-- 2. One active row per email. Re-subscribe after unsubscribe is allowed.

create unique index if not exists brief_subscribers_email_active_unique
  on public.brief_subscribers (lower(email))
  where unsubscribed_at is null;

-- 3. Index for source rollup.

create index if not exists brief_subscribers_source_idx
  on public.brief_subscribers (source, created_at desc);

-- 4. RLS, anon cannot read or write. The /api/subscribe serverless function
-- writes via the service role key, which bypasses RLS.

alter table public.brief_subscribers enable row level security;

-- 5. Convenience view for export / counts.

create or replace view public.brief_subscribers_active as
select
  id,
  lower(email)         as email,
  source,
  created_at
from public.brief_subscribers
where unsubscribed_at is null;
