/// <reference path="../deno-types.d.ts" />
// send-notification/index.ts
//
// Service-role–only endpoint for sending a push notification to a specific user.
// Useful for admin tooling, testing, and future transactional notifications.
//
// POST /send-notification
// Auth: service-role key
// Body: {
//   "user_id":  "<uuid>",            // required
//   "title":    "Notification Title", // required
//   "body":     "Notification body",  // required
//   "data":     { "screen": "dashboard" }  // optional
// }

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";
import { sendPushNotification }                from "../_shared/push.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();

  // Service-role only
  const authHeader = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = authHeader.replace("Bearer ", "");

  if (token !== serviceKey) {
    return jsonResponse({ error: "Unauthorized — service role required" }, 401);
  }

  const { user_id, title, body, data } = await req.json();

  if (!user_id || !title || !body) {
    return jsonResponse({ error: "Missing user_id, title, or body" }, 400);
  }

  const db = adminClient();

  // Look up the user's push token
  const { data: profile, error: profileErr } = await db
    .from("profiles")
    .select("push_token")
    .eq("id", user_id)
    .maybeSingle();

  if (profileErr) {
    return jsonResponse({ error: profileErr.message }, 500);
  }

  if (!profile?.push_token) {
    return jsonResponse({ error: "User has no push token registered" }, 404);
  }

  const ticket = await sendPushNotification(
    profile.push_token,
    title,
    body,
    data ?? { screen: "dashboard" },
  );

  return jsonResponse({
    sent: ticket.ok,
    error: ticket.error ?? null,
    push_token_prefix: profile.push_token.slice(0, 30) + "…",
  });
});
