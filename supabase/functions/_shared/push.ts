/// <reference path="../deno-types.d.ts" />
// _shared/push.ts
//
// Sends push notifications via the Expo Push API.
// https://docs.expo.dev/push-notifications/sending-notifications/
//
// Never throws — callers can fire-and-forget.

// ── Types ──────────────────────────────────────────────────────

export interface PushMessage {
  to:        string;                     // ExponentPushToken[…]
  title:     string;
  body:      string;
  data?:     Record<string, unknown>;
  sound?:    "default" | null;
  badge?:    number;
  channelId?: string;
}

export interface PushTicket {
  ok:     boolean;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK_SIZE    = 100;   // Expo recommends ≤ 100 per request

// ── Public API ─────────────────────────────────────────────────

/**
 * Send one or more push notifications via the Expo Push API.
 * Automatically chunks large batches. Never throws.
 */
export async function sendPushNotifications(
  messages: PushMessage[],
): Promise<PushTicket[]> {
  if (messages.length === 0) return [];

  const tickets: PushTicket[] = [];

  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          Accept:           "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(chunk),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[push] Expo API ${res.status}: ${body}`);
        chunk.forEach(() => tickets.push({ ok: false, error: `HTTP ${res.status}` }));
        continue;
      }

      const json = (await res.json()) as {
        data: Array<{ status: string; message?: string }>;
      };

      for (const t of json.data) {
        tickets.push({
          ok:    t.status === "ok",
          error: t.status !== "ok" ? t.message : undefined,
        });
      }
    } catch (err) {
      console.error("[push] Fetch error:", (err as Error).message);
      chunk.forEach(() =>
        tickets.push({ ok: false, error: (err as Error).message }),
      );
    }
  }

  return tickets;
}

/**
 * Convenience wrapper: send a single push notification. Never throws.
 */
export async function sendPushNotification(
  token: string,
  title: string,
  body:  string,
  data?: Record<string, unknown>,
): Promise<PushTicket> {
  const [ticket] = await sendPushNotifications([
    {
      to:        token,
      title,
      body,
      data,
      sound:     "default",
      channelId: "default",
    },
  ]);
  return ticket ?? { ok: false, error: "No ticket returned" };
}
