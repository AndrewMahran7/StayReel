// _shared/audit.ts
// Writes a row to public.audit_events via the service-role client.
// Never throws — audit failures must not abort the main operation.

import { adminClient } from "./supabase_client.ts";

export type AuditEventType =
  | "account_connected"
  | "account_disconnected"
  | "account_deleted"
  | "snapshot_taken"
  | "snapshot_failed"
  | "token_refreshed"
  | "token_expired"
  | "rate_limit_hit"
  | "notification_sent"
  | "user_deleted";

export interface AuditEventParams {
  userId?: string | null;
  igAccountId?: string | null;
  eventType: AuditEventType;
  payload?: Record<string, unknown>;
  ipAddress?: string | null;
  source?: string;
}

export async function writeAuditEvent(params: AuditEventParams): Promise<void> {
  try {
    const { error } = await adminClient()
      .from("audit_events")
      .insert({
        user_id: params.userId ?? null,
        ig_account_id: params.igAccountId ?? null,
        event_type: params.eventType,
        payload: params.payload ?? {},
        ip_address: params.ipAddress ?? null,
        source: params.source ?? "edge_function",
      });

    if (error) {
      // Log but swallow — audit must never block the calling function.
      console.error("[audit] write failed:", error.message);
    }
  } catch (err) {
    console.error("[audit] unexpected error:", err);
  }
}

// Convenience: extract a best-effort IP from request headers
// (Supabase Edge Functions expose the client IP via CF-Connecting-IP).
export function extractIp(req: Request): string | null {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    null
  );
}
