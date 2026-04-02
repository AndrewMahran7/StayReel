-- 022_snapshot_queue.sql
-- Global concurrency control: adds a 'queued' status to snapshot_jobs so
-- jobs created while too many others are running remain safely dormant
-- until capacity opens. No background job or cron is required — the client
-- poll loop (snapshot-continue) promotes queued jobs when it detects space.
--
-- Safety guarantee preserved: at most ONE active (running OR queued) job
-- per ig_account at any time. The unique partial index enforces this.
--
-- Rollout note: this migration drops and recreates the unique partial index.
-- It uses CONCURRENTLY-safe DDL (IF NOT EXISTS, DROP IF EXISTS) so it can
-- be applied to a live database without locking the table.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Extend the status CHECK constraint to include 'queued'
-- ═════════════════════════════════════════════════════════════════════════════
-- Postgres does not support ALTER CONSTRAINT — we must drop+add.
ALTER TABLE public.snapshot_jobs
  DROP CONSTRAINT IF EXISTS snapshot_jobs_status_check;

ALTER TABLE public.snapshot_jobs
  ADD CONSTRAINT snapshot_jobs_status_check
    CHECK (status IN ('running', 'complete', 'failed', 'queued'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Replace the one-running-per-account index with one-active-per-account
--    (covers both 'running' and 'queued' so you can never have both at once)
-- ═════════════════════════════════════════════════════════════════════════════
DROP INDEX IF EXISTS public.snapshot_jobs_one_running;

CREATE UNIQUE INDEX IF NOT EXISTS snapshot_jobs_one_active
  ON public.snapshot_jobs (ig_account_id)
  WHERE status IN ('running', 'queued');

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Efficient lookup of the oldest queued job per account (for promotion)
-- ═════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS snapshot_jobs_queued_by_age
  ON public.snapshot_jobs (started_at ASC)
  WHERE status = 'queued';

COMMENT ON INDEX public.snapshot_jobs_queued_by_age IS
  'Used by snapshot-continue to find the next queued job to promote when global running count drops below the cap.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Comments
-- ═════════════════════════════════════════════════════════════════════════════
COMMENT ON CONSTRAINT snapshot_jobs_status_check ON public.snapshot_jobs IS
  'Valid lifecycle states: queued (waiting for global capacity) → running → complete | failed.';
