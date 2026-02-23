-- 013_snapshot_jobs.sql
-- Resumable snapshot job system.
-- Each "job" tracks the state of a chunked follower/following fetch so
-- that large accounts (2 000–5 000 followers) can be captured across
-- multiple Edge Function invocations without hitting the 150 s timeout.
--
-- Lifecycle: running → (followers chunk*) → (following chunk*) → finalize → complete
--                   └────────────────────────────────────────────────────────→ failed

-- ── Table ──────────────────────────────────────────────────────────────────
create table public.snapshot_jobs (
  id                  uuid        primary key  default gen_random_uuid(),
  user_id             uuid        not null     references auth.users(id)       on delete cascade,
  ig_account_id       uuid        not null     references public.ig_accounts(id) on delete cascade,
  source              text        not null     default 'manual',

  -- State machine
  status              text        not null     default 'running'
                                               check (status in ('running','complete','failed')),
  phase               text        not null     default 'followers'
                                               check (phase in ('followers','following','finalize')),

  -- Pagination cursors (next_max_id from Instagram's API)
  followers_cursor    text        null,
  following_cursor    text        null,

  -- Accumulated edge lists (updated each chunk, used at finalization)
  followers_json      jsonb       not null     default '[]'::jsonb,
  following_json      jsonb       not null     default '[]'::jsonb,

  -- Profile API counts (set on first invocation, used for accurate totals)
  follower_count_api  int         not null     default 0,
  following_count_api int         not null     default 0,
  post_count_api      int         not null     default 0,

  -- Timestamp of first page fetch (used as snapshot captured_at)
  captured_at         timestamptz null,

  -- Progress counters
  pages_done          int         not null     default 0,

  -- Metadata
  started_at          timestamptz not null     default now(),
  updated_at          timestamptz not null     default now(),
  error               text        null
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create index snapshot_jobs_user_status  on public.snapshot_jobs (user_id, status);
create index snapshot_jobs_acct_status  on public.snapshot_jobs (ig_account_id, status);

-- Enforce at most one running job per IG account at a time.
create unique index snapshot_jobs_one_running
  on public.snapshot_jobs (ig_account_id)
  where status = 'running';

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.snapshot_jobs enable row level security;

-- Users can only read their own jobs (edge functions use service role to write)
create policy "owner_select"
  on public.snapshot_jobs for select
  using (auth.uid() = user_id);

-- Allow insert from client (snapshot-start creates the row via service role anyway,
-- but this is here for completeness)
create policy "owner_insert"
  on public.snapshot_jobs for insert
  with check (auth.uid() = user_id);
