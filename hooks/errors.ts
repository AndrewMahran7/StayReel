// _shared/errors.ts
// Typed error classes and standardised error response helper.

import { jsonResponse } from "./cors.ts";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ── Predefined errors ─────────────────────────────────────────

export const Errors = {
  unauthorized: () =>
    new AppError("UNAUTHORIZED", "Missing or invalid auth token", 401),

  forbidden: () =>
    new AppError("FORBIDDEN", "You do not own this resource", 403),

  notFound: (resource: string) =>
    new AppError("NOT_FOUND", `${resource} not found`, 404),

  rateLimited: (detail?: string) =>
    new AppError(
      "RATE_LIMITED",
      detail ?? "Too many requests. Try again later.",
      429,
    ),

  igChallenge: () =>
    new AppError(
      "IG_CHALLENGE_REQUIRED",
      "Instagram requires a security challenge. Please re-authenticate in the app.",
      503,
    ),

  igSessionInvalid: () =>
    new AppError(
      "IG_SESSION_INVALID",
      "Instagram session is invalid or expired.",
      401,
    ),

  igRateLimit: () =>
    new AppError(
      "IG_RATE_LIMITED",
      "Instagram rate-limited this request. Back-off applied.",
      503,
    ),

  badRequest: (msg: string, detail?: unknown) =>
    new AppError("BAD_REQUEST", msg, 400, detail),

  snapshotLimit: (nextAllowedAt: string, message?: string) =>
    new AppError(
      "SNAPSHOT_LIMIT",
      message ?? "Snapshot already taken recently. You can take one snapshot per hour.",
      429,
      { next_allowed_at: nextAllowedAt },
    ),

  internal: (msg = "Internal server error") =>
    new AppError("INTERNAL_ERROR", msg, 500),
} as const;

// ── Response helper ────────────────────────────────────────────

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return jsonResponse(
      { error: err.code, message: err.message, detail: err.detail ?? null },
      err.httpStatus,
    );
  }

  console.error("[unhandled]", err);
  return jsonResponse(
    { error: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    500,
  );
}
