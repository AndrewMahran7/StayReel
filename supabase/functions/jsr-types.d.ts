// Type shim for JSR imports used in Deno unit tests and Edge Functions.
// The real implementations come from the Deno runtime's JSR registry;
// these declarations let the TS language service resolve the modules.

// ── Supabase JS (JSR distribution) ───────────────────────────────────────────
// Forward to the npm package — identical public API, different distribution.
declare module "jsr:@supabase/supabase-js@2" {
  export * from "@supabase/supabase-js";
}

// ── Deno standard library ─────────────────────────────────────────────────────
declare module "jsr:@std/assert@1" {
  export function assert(expr: unknown, msg?: string): asserts expr;
  export function assertEquals<T>(actual: T, expected: T, msg?: string): void;
  export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void;
  export function assertStrictEquals<T>(
    actual: unknown,
    expected: T,
    msg?: string,
  ): asserts actual is T;
  export function assertArrayIncludes<T>(
    actual: ArrayLike<T>,
    expected: ArrayLike<T>,
    msg?: string,
  ): void;
  export function assertThrows(fn: () => unknown, msg?: string): void;
  export function assertThrows<E extends Error>(
    fn: () => unknown,
    ErrorClass: new (...args: unknown[]) => E,
    msgIncludes?: string,
    msg?: string,
  ): E;
  export function assertRejects(
    fn: () => Promise<unknown>,
    msg?: string,
  ): Promise<Error>;
  export function fail(msg?: string): never;
}
