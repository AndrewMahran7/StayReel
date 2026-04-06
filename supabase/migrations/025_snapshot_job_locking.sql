-- 025_snapshot_job_locking.sql
-- Adds locking and heartbeat columns for mutual-exclusion between the
-- client poll loop (snapshot-continue) and the server-side background
-- processor (process-stale-jobs).
--
-- locked_by:         Identifies the current processor ('client' or 'worker:<invocation>')
-- lock_acquired_at:  When the lock was taken — used for lease expiry
-- last_heartbeat_at: Updated every poll / chunk to prove the processor is alive

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Locking columns
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.snapshot_jobs
  ADD COLUMN IF NOT EXISTS locked_by         TEXT,
  ADD COLUMN IF NOT EXISTS lock_acquired_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

COMMENT ON COLUMN public.snapshot_jobs.locked_by IS
  'Identifies the current processor holding the lock (e.g. "client" or "worker:<id>"). NULL = unlocked.';

COMMENT ON COLUMN public.snapshot_jobs.lock_acquired_at IS
  'Timestamp when locked_by was set. Used with a lease duration to detect abandoned locks.';

COMMENT ON COLUMN public.snapshot_jobs.last_heartbeat_at IS
  'Updated on every client poll and during server chunk processing. Used by process-stale-jobs to detect truly abandoned jobs (no heartbeat > threshold).';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Index for stale heartbeat lookup (replaces reliance on updated_at)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS snapshot_jobs_running_heartbeat
  ON public.snapshot_jobs (last_heartbeat_at ASC)
  WHERE status = 'running';

COMMENT ON INDEX public.snapshot_jobs_running_heartbeat IS
  'Used by process-stale-jobs to efficiently find running jobs whose heartbeat has expired.';
