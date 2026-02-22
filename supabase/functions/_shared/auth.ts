// _shared/auth.ts
// Resolves the calling user from a Supabase Auth JWT.

import { adminClient, createUserClient } from "./supabase_client.ts";
import { Errors } from "./errors.ts";

export interface CallerContext {
  userId: string;
  authHeader: string; // forwarded to user-scoped DB client
}

// Extracts the Bearer token, verifies it with Supabase Auth using the
// service-role client (which can validate any user's JWT), and returns
// a normalised CallerContext. Throws AppError on failure.
export async function requireAuth(req: Request): Promise<CallerContext> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) throw Errors.unauthorized();

  const token = authHeader.slice(7); // strip "Bearer "
  // Use adminClient so the service-role key is the API key — this is
  // the correct way to verify a user JWT server-side in Supabase.
  const { data, error } = await adminClient().auth.getUser(token);

  if (error || !data?.user?.id) throw Errors.unauthorized();

  return { userId: data.user.id, authHeader };
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
