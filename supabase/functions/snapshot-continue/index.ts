/// <reference path="../deno-types.d.ts" />
// snapshot-continue/index.ts
//
// DISABLED — superseded by the server-owned snapshot-worker (migration 030).
//
// The polling-era client used to call this endpoint every ~1 s to drive the
// next chunk. The new architecture has the backend own continuation:
//   • snapshot-start enqueues + triggers snapshot-worker.
//   • snapshot-worker self-triggers until terminal.
//   • process-stale-jobs is the fallback scheduler.
//
// We keep this stub returning HTTP 410 so any old client build still in the
// wild fails fast and surfaces a clear error rather than silently driving
// a parallel chunk path that would fight the worker for the job lock.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  return jsonResponse(
    {
      error: "ENDPOINT_REMOVED",
      message:
        "snapshot-continue has been removed. The backend now owns snapshot continuation. " +
        "Update the client to the latest build (server-owned lifecycle).",
    },
    410,
  );
});
