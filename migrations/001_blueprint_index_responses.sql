-- Migration: Blueprint Index poll responses
-- Run this in the Supabase SQL Editor of the same project that backs bvf-app.
-- Idempotent, safe to re-run.

-- 1. Table

create table if not exists public.blueprint_index_responses (
  id            uuid            primary key default gen_random_uuid(),
  driver        text            not null,
  question_id   text            not null,
  answer        text            not null,
  issue_number  int,
  anon_token    text,
  user_agent    text,
  created_at    timestamptz     not null default now(),

  -- Guardrails, the driver must be one of the six Blueprint drivers.
  -- If we later add a seventh driver we extend this check constraint.
  constraint blueprint_driver_check check (driver in (
    'strategic-alignment',
    'leadership-culture',
    'talent',
    'data-tech',
    'change-enablement',
    'governance-risk'
  ))
);

-- 2. Indexes for fast monthly rollups

create index if not exists blueprint_index_responses_question_idx
  on public.blueprint_index_responses (question_id);

create index if not exists blueprint_index_responses_driver_created_idx
  on public.blueprint_index_responses (driver, created_at desc);

-- 3. Row-level security
-- Nobody can read or write via the anon key. The serverless function writes
-- using the service role key, which bypasses RLS. The Friday skill reads the
-- same way. No browser-side access to this table at any time.

alter table public.blueprint_index_responses enable row level security;

-- 4. Helper view for the Friday rollup
-- Use this in the skill to compute the month's headline stat.

create or replace view public.blueprint_index_monthly as
select
  date_trunc('month', created_at)::date  as month,
  driver,
  question_id,
  answer,
  count(*)                               as response_count
from public.blueprint_index_responses
group by 1, 2, 3, 4
order by 1 desc, 2, 3, 4;

-- 5. Rate-limit safety net.
-- Optional, can be added later. For now we rely on the serverless function
-- to dedupe by anon_token within the same question_id window.
