/// <reference path="../deno-types.d.ts" />
// process-stale-jobs/index.ts
//
// POST /process-stale-jobs
//
// Fallback scheduler for the server-owned snapshot lifecycle.
//
// Two responsibilities:
//   A. Runnable-job sweeper. Find jobs with next_run_at <= now and dispatch
//      them to snapshot-worker. This is the safety net when a worker's
//      self-trigger fetch was dropped (cold-start, network hiccup, etc.).
//   B. Stale-heartbeat recovery. Find running jobs whose heartbeat is older
//      than STALE_THRESHOLD_MS and dispatch them too â€” covers jobs created
//      before the server-owned model was deployed (migration tail) and any
//      worker that crashed without releasing its lock or setting next_run_at.
//
// Both paths simply POST to snapshot-worker with the job id; the worker
// handles locking, progress, notifications, and continuation. This function
// stays small and never runs chunks itself.
//
// Security: requires the service-role Bearer token (pg_cron uses pg_net with
// the service role key).

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";

const MAX_JOBS_PER_RUN   = 10;
const STALE_THRESHOLD_MS = 120_000; // 120s without a heartbeat

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  // â”€â”€ Service-role only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!serviceKey || token !== serviceKey) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const db   = adminClient();
  const now  = new Date();
  const nowIso = now.toISOString();
  const staleCutoff = new Date(now.getTime() - STALE_THRESHOLD_MS).toISOString();

  // â”€â”€ A. Runnable jobs (next_run_at <= now) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { data: runnable } = await db
    .from("snapshot_jobs")
    .select("id")
    .in("status", ["running", "queued"])
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(MAX_JOBS_PER_RUN);

  // â”€â”€ B. Stale heartbeat recovery (covers legacy + crashed workers) â”€â”€
  const { data: stale } = await db
    .from("snapshot_jobs")
    .select("id")
    .eq("status", "running")
    .or(`last_heartbeat_at.lt.${staleCutoff},and(last_heartbeat_at.is.null,updated_at.lt.${staleCutoff})`)
    .order("updated_at", { ascending: true })
    .limit(MAX_JOBS_PER_RUN);

  // Deduplicate by id.
  const ids = new Set<string>();
  for (const r of runnable ?? []) ids.add(r.id);
  for (const r of stale    ?? []) ids.add(r.id);

  if (ids.size === 0) {
    return jsonResponse({ message: "No runnable jobs.", dispatched: 0 });
  }

  console.log(`[process-stale-jobs] Dispatching ${ids.size} job(s) to snapshot-worker.`);

  // â”€â”€ Dispatch each to snapshot-worker (fire-and-forget, with await for logging) â”€â”€
  const workerUrl = (Deno.env.get("SUPABASE_URL") ?? "") + "/functions/v1/snapshot-worker";
  const dispatched: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  await Promise.all([...ids].map(async (id) => {
    try {
      const res = await fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ job_id: id }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        errors.push({ id, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` });
      } else {
        dispatched.push(id);
      }
    } catch (err) {
      errors.push({ id, error: (err as Error).message });
    }
  }));

  return jsonResponse({
    message:    `Dispatched ${dispatched.length} job(s).`,
    dispatched: dispatched.length,
    errors:     errors.length,
    jobIds:     dispatched,
    errorDetails: errors,
  });
});

