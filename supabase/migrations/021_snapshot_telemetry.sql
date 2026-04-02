-- 021_snapshot_telemetry.sql
-- Timing telemetry for snapshot jobs.
--
-- Adds three lightweight columns to snapshot_jobs:
--   started_at       – set at job creation time in snapshot-start
--   completed_at     – set when job transitions to complete | failed
--   total_duration_ms – integer ms from started_at to completed_at
--
-- These enable:
--   • ETA estimation on the client (ms per page from actual elapsed time)
--   • Post-mortem tuning (query average duration by account size / is_first_snapshot)
--   • Alerting on jobs that take unexpectedly long
--
-- Per-invocation detail (pages fetched, edges seen, elapsed ms) is written
-- with structured console.log('[timing]') entries that appear in Supabase
-- Edge Function logs, keeping schema changes minimal.

ALTER TABLE public.snapshot_jobs
  ADD COLUMN IF NOT EXISTS started_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_duration_ms INTEGER;

COMMENT ON COLUMN public.snapshot_jobs.started_at        IS 'Wall-clock time when the job row was created and first chunk started.';
COMMENT ON COLUMN public.snapshot_jobs.completed_at      IS 'Wall-clock time when the job reached status complete or failed.';
COMMENT ON COLUMN public.snapshot_jobs.total_duration_ms IS 'completed_at - started_at in milliseconds. NULL until job terminates.';
