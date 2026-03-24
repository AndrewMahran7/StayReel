// _shared/auth.ts
// Resolves the calling user from a Supabase Auth JWT.
//
// Since gateway-level verify_jwt is disabled (to work around the ES256 JWKS
// issue), we verify the JWT signature ourselves using the project's JWKS
// endpoint before trusting any payload claims.

import { createUserClient } from "./supabase_client.ts";
import { Errors } from "./errors.ts";

export interface CallerContext {
  userId: string;
  authHeader: string; // forwarded to user-scoped DB client
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// Cache the JWKS keys for the lifetime of the isolate to avoid a fetch on
// every request. Keys rarely rotate — safe to cache indefinitely per isolate.
let _cachedKeys: CryptoKey[] | null = null;

async function getJwks(): Promise<CryptoKey[]> {
  if (_cachedKeys) return _cachedKeys;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);

  const { keys } = await res.json() as { keys: JsonWebKey[] };
  _cachedKeys = await Promise.all(
    keys.map((jwk) =>
      crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      )
    ),
  );
  return _cachedKeys;
}

function base64urlToBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}

export async function requireAuth(req: Request): Promise<CallerContext> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) throw Errors.unauthorized();

  const token = authHeader.slice(7);

  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed JWT");

    // Decode payload (base64url → JSON)
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlToBuffer(parts[1]))
    );

    // Expiry check
    if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) {
      console.error("[requireAuth] JWT expired or missing exp");
      throw Errors.unauthorized();
    }

    // Role check
    if (payload.role !== "authenticated" || !payload.sub) {
      console.error("[requireAuth] JWT role/sub invalid:", { role: payload.role, sub: payload.sub });
      throw Errors.unauthorized();
    }

    // Signature verification against JWKS
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature    = base64urlToBuffer(parts[2]);
    const keys         = await getJwks();

    const valid = await Promise.any(
      keys.map((key) =>
        crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signingInput)
          .then((ok) => { if (!ok) throw new Error("sig mismatch"); return true; })
      )
    ).catch(() => false);

    if (!valid) {
      console.error("[requireAuth] JWT signature verification failed");
      throw Errors.unauthorized();
    }

    return { userId: payload.sub as string, authHeader };
  } catch (e) {
    if ((e as any)?.code === "UNAUTHORIZED") throw e;
    console.error("[requireAuth] JWT error:", (e as Error).message);
    throw Errors.unauthorized();
  }
}

// Verifies the caller owns the given ig_account_id by checking
// the ig_accounts table (RLS-enforced read).
export async function requireOwnsAccount(
  authHeader: string,
  igAccountId: string,
): Promise<void> {
  const client = createUserClient(authHeader);
  const { error } = await client
    .from("ig_accounts")
    .select("id")
    .eq("id", igAccountId)
    .is("deleted_at", null)
    .single();

  // If RLS denies or row doesn't exist, .single() returns an error.
  if (error) throw Errors.forbidden();
}
