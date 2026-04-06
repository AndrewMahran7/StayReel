-- 024_snapshot_job_lifecycle.sql
-- Adds failure_code for typed error classification on failed snapshot jobs,
-- and an index for efficiently finding stale running jobs for the server-side
-- background processor (process-stale-jobs).

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Machine-readable failure code stored alongside human-readable error message
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.snapshot_jobs
  ADD COLUMN IF NOT EXISTS failure_code TEXT;

COMMENT ON COLUMN public.snapshot_jobs.failure_code IS
  'Machine-readable failure code (e.g. SESSION_EXPIRED, IG_RATE_LIMITED). Set alongside error message when job fails.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Index for efficient stale-job lookup (process-stale-jobs edge function)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS snapshot_jobs_running_updated
  ON public.snapshot_jobs (updated_at ASC)
  WHERE status = 'running';

COMMENT ON INDEX public.snapshot_jobs_running_updated IS
  'Used by process-stale-jobs to find running jobs with no active client polling (updated_at older than threshold).';
