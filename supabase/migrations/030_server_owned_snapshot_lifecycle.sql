-- 030_server_owned_snapshot_lifecycle.sql
--
-- Server-owned snapshot lifecycle.
--
-- After this migration the backend fully owns:
--   • job execution (snapshot-worker)
--   • continuation scheduling (next_run_at)
--   • progress calculation (progress_percent / progress_stage)
--   • milestone notification delivery (notification_mask)
--
-- The client only initiates the job and reacts to push notifications.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. New columns on snapshot_jobs
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.snapshot_jobs
  ADD COLUMN IF NOT EXISTS next_run_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS progress_percent         SMALLINT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_stage           TEXT         NOT NULL DEFAULT 'started',
  ADD COLUMN IF NOT EXISTS progress_mode            TEXT         NOT NULL DEFAULT 'staged',
  ADD COLUMN IF NOT EXISTS completed_work_units     INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_work_units         INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS followers_target_count   INTEGER,
  ADD COLUMN IF NOT EXISTS following_target_count   INTEGER,
  ADD COLUMN IF NOT EXISTS following_cached         BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notification_mask        INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_notified_percent    SMALLINT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_chunk_started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_chunk_completed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_attempt_count     INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_retry_count  INTEGER      NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.snapshot_jobs.next_run_at IS
  'When the snapshot-worker should next process this job. Used by the fallback scheduler.';
COMMENT ON COLUMN public.snapshot_jobs.progress_percent IS
  '0–100 progress. Never decreases. Capped at 99 until status=complete.';
COMMENT ON COLUMN public.snapshot_jobs.progress_stage IS
  'started | followers | following | finalize | complete | failed | reconnect_required';
COMMENT ON COLUMN public.snapshot_jobs.progress_mode IS
  'exact = derived from completed_work_units / total_work_units. staged = phase-bucket fallback.';
COMMENT ON COLUMN public.snapshot_jobs.notification_mask IS
  'Bitmask of milestones already delivered. Bits: 1=started 2=p25 4=p50 8=p75 16=almost 32=complete 64=failed 128=reconnect.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Constraints (added defensively — DO blocks because Postgres lacks
--    "ADD CONSTRAINT IF NOT EXISTS" prior to PG15+ universally.)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'snapshot_jobs_progress_percent_chk'
  ) THEN
    ALTER TABLE public.snapshot_jobs
      ADD CONSTRAINT snapshot_jobs_progress_percent_chk
      CHECK (progress_percent BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'snapshot_jobs_progress_stage_chk'
  ) THEN
    ALTER TABLE public.snapshot_jobs
      ADD CONSTRAINT snapshot_jobs_progress_stage_chk
      CHECK (progress_stage IN (
        'started','followers','following','finalize','complete','failed','reconnect_required'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'snapshot_jobs_progress_mode_chk'
  ) THEN
    ALTER TABLE public.snapshot_jobs
      ADD CONSTRAINT snapshot_jobs_progress_mode_chk
      CHECK (progress_mode IN ('exact','staged'));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Indexes
-- ═══════════════════════════════════════════════════════════════════════════
-- Scheduler lookup: jobs that are runnable now.
CREATE INDEX IF NOT EXISTS snapshot_jobs_runnable_idx
  ON public.snapshot_jobs (next_run_at ASC)
  WHERE status IN ('running','queued') AND next_run_at IS NOT NULL;

COMMENT ON INDEX public.snapshot_jobs_runnable_idx IS
  'Fallback scheduler scans this index for jobs whose next_run_at has elapsed.';
