/// <reference path="../deno-types.d.ts" />
// _shared/errors.ts
// Typed error helpers for Edge Functions.
//
// Usage:
//   throw Errors.unauthorized();
//   throw Errors.snapshotLimit(nextAllowedAt, "One snapshot per hour.");
//   throw new AppError("MY_CODE", "Something went wrong", 400, { extra: "data" });
//
// In the top-level catch block:
//   return errorResponse(err);

import { jsonResponse } from "./cors.ts";

// ── AppError ───────────────────────────────────────────────────────────────

/**
 * All intentional edge-function errors should be thrown as AppError.
 * `errorResponse()` converts them to well-shaped JSON HTTP responses.
 */
export class AppError extends Error {
  constructor(
    public readonly code:       string,
    message:                    string,
    public readonly httpStatus: number = 500,
    public readonly detail?:    Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ── Factory helpers ────────────────────────────────────────────────────────

export const Errors = {
  // ── Auth ──────────────────────────────────────────────────────────────
  unauthorized(message = "Unauthorized.") {
    return new AppError("UNAUTHORIZED", message, 401);
  },

  forbidden(message = "Forbidden.") {
    return new AppError("FORBIDDEN", message, 403);
  },

  // ── Request validation ────────────────────────────────────────────────
  badRequest(message = "Bad request.") {
    return new AppError("BAD_REQUEST", message, 400);
  },

  notFound(resource = "Resource") {
    return new AppError("NOT_FOUND", `${resource} not found.`, 404);
  },

  // ── Server ────────────────────────────────────────────────────────────
  internal(message = "An internal error occurred.") {
    return new AppError("INTERNAL_ERROR", message, 500);
  },

  // ── Rate limiting ─────────────────────────────────────────────────────
  /**
   * Thrown when the hourly or daily snapshot cap is hit.
   * `nextAllowedAt` is an ISO timestamp; surfaced to the client via `detail`.
   */
  snapshotLimit(nextAllowedAt: string, message: string) {
    return new AppError("SNAPSHOT_LIMIT", message, 429, { next_allowed_at: nextAllowedAt });
  },

  // ── Instagram session errors ──────────────────────────────────────────
  igSessionInvalid(message = "Instagram session expired. Please reconnect your account.") {
    return new AppError("IG_SESSION_INVALID", message, 401);
  },

  igChallenge(message = "Instagram requires a security challenge. Please open Instagram and complete it, then try again.") {
    return new AppError("IG_CHALLENGE_REQUIRED", message, 403);
  },

  igRateLimit(message = "Instagram is rate-limiting this account. Please try again later.") {
    return new AppError("IG_RATE_LIMITED", message, 429);
  },
} as const;

// ── errorResponse ──────────────────────────────────────────────────────────

/**
 * Converts any thrown value into a CORS-safe JSON HTTP response.
 * Pass the raw caught value — no need to check instanceof first.
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = {
      error:   err.code,
      message: err.message,
    };
    if (err.detail) body.detail = err.detail;
    return jsonResponse(body, err.httpStatus);
  }

  // Unexpected error — log it and return a generic 500
  console.error("[errorResponse] Unhandled error:", err);
  return jsonResponse(
    { error: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    500,
  );
}
