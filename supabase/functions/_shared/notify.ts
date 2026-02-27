// _shared/notify.ts
//
// Sends an alert email to the StayReel owner when a snapshot job fails.
//
// Requires the RESEND_API_KEY environment variable (https://resend.com).
// If the key is not set the function logs to console only — it never throws.
//
// Codes in SILENT_CODES are expected user flows and are NOT emailed.

const OWNER_EMAIL  = "mahranandrew@gmail.com";
const FROM_EMAIL   = Deno.env.get("NOTIFY_FROM_EMAIL") ?? "noreply@stayreel.app";
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY") ?? "";

/** Error codes that are normal user-flow events — no email needed. */
const SILENT_CODES = new Set([
  "SNAPSHOT_LIMIT",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
]);

export interface ErrorContext {
  /** Name of the edge function, e.g. "snapshot-start" */
  source:       string;
  /** Supabase user ID, if available */
  userId?:      string | null;
  /** ig_accounts.id, if available */
  igAccountId?: string | null;
  /** snapshot_jobs.id, if available */
  jobId?:       string | null;
  /** Machine-readable error code, e.g. "IG_SESSION_INVALID" */
  code:         string;
  /** Human-readable message */
  message:      string;
  /** Full stack trace, if available */
  stack?:       string | null;
}

/**
 * Fire-and-forget owner alert.
 * Call this from every edge function catch block — it never throws.
 */
export async function notifyOwnerOfError(ctx: ErrorContext): Promise<void> {
  if (SILENT_CODES.has(ctx.code)) return;

  const ts = new Date().toISOString();

  // ── Console log (always) ──────────────────────────────────────────────────
  console.error(
    `[notify] ${ctx.source} error @ ${ts}`,
    `code=${ctx.code}`,
    `user=${ctx.userId ?? "?"}`,
    `ig=${ctx.igAccountId ?? "?"}`,
    `job=${ctx.jobId ?? "?"}`,
    ctx.message,
  );

  if (!RESEND_KEY) {
    console.warn("[notify] RESEND_API_KEY not set — email skipped.");
    return;
  }

  // ── Build email ───────────────────────────────────────────────────────────
  const subject = `⚠️ StayReel error: ${ctx.code} [${ctx.source}]`;

  const rows = [
    ["Time",       ts],
    ["Function",   ctx.source],
    ["Error code", ctx.code],
    ["Message",    ctx.message],
    ["User ID",    ctx.userId    ?? "—"],
    ["IG Acct ID", ctx.igAccountId ?? "—"],
    ["Job ID",     ctx.jobId     ?? "—"],
  ];

  const tableRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:6px 12px;font-size:13px;font-weight:600;color:#888;white-space:nowrap;border-bottom:1px solid #2a2a2a;">${label}</td>
      <td style="padding:6px 12px;font-size:13px;color:#eee;word-break:break-all;border-bottom:1px solid #2a2a2a;">${escHtml(String(value))}</td>
    </tr>`).join("");

  const stackSection = ctx.stack
    ? `<div style="margin-top:20px;">
         <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#888;">Stack trace</p>
         <pre style="margin:0;padding:14px;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;font-size:11px;color:#aaaaaa;overflow-x:auto;white-space:pre-wrap;word-break:break-word;">${escHtml(ctx.stack)}</pre>
       </div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:24px;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;">
    <div style="background:#141414;border:1px solid #2a2a2a;border-radius:16px;padding:28px;">

      <p style="margin:0 0 4px;font-size:13px;color:#555;">StayReel · Error Alert</p>
      <p style="margin:0 0 24px;font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.3px;">
        ⚠️ ${escHtml(ctx.code)}
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #2a2a2a;border-radius:10px;border-collapse:collapse;overflow:hidden;">
        ${tableRows}
      </table>

      ${stackSection}

    </div>
    <p style="margin:16px 0 0;font-size:11px;color:#444;text-align:center;">StayReel automated alert — ${ts}</p>
  </div>
</body>
</html>`;

  // ── Send via Resend ───────────────────────────────────────────────────────
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    FROM_EMAIL,
        to:      [OWNER_EMAIL],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[notify] Resend ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error("[notify] fetch failed:", err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
/**
 * Strips Instagram session cookies from any string before it reaches logs or email.
 * Guards against a cookie leaking into an error message or stack trace.
 */
function redactSensitive(str: string): string {
  return str
    .replace(/sessionid=[^;,\s"\\]+/gi,  "sessionid=[REDACTED]")
    .replace(/csrftoken=[^;,\s"\\]+/gi,  "csrftoken=[REDACTED]")
    .replace(/ds_user_id=[^;,\s"\\]+/gi, "ds_user_id=[REDACTED]")
    .replace(/rur=[^;,\s"\\]+/gi,        "rur=[REDACTED]");
}