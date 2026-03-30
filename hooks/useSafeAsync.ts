// hooks/useSafeAsync.ts
// Reusable hook that wraps any async function with loading, error, timeout,
// and double-execution protection.  Guarantees loading is always reset.
//
// Usage:
//   const { run, loading, error, reset } = useSafeAsync(myAsyncFn, { timeoutMs: 15_000 });
//   <Button onPress={() => run(arg1, arg2)} disabled={loading} />

import { useState, useRef, useCallback, useEffect } from 'react';

interface UseSafeAsyncOptions {
  /** Auto-timeout in ms. Default 20 000 (20 s). Set 0 to disable. */
  timeoutMs?: number;
}

interface UseSafeAsyncReturn<T> {
  /** Invoke the wrapped function. No-ops if already running. */
  run: (...args: any[]) => Promise<T | undefined>;
  /** True while the async call is in flight. */
  loading: boolean;
  /** The most recent error, or null. Cleared on every new run. */
  error: Error | null;
  /** Manually clear the error state. */
  reset: () => void;
}

/**
 * Wraps an arbitrary async function with production-safe guardrails:
 *
 * 1. **Loading state** — set true on start, guaranteed false on finish.
 * 2. **Error capture** — caught and surfaced; never swallowed.
 * 3. **Timeout** — auto-rejects after `timeoutMs` (default 20 s).
 * 4. **Double-exec guard** — concurrent calls are silently ignored.
 * 5. **Unmount safety** — skips state updates after unmount.
 */
export function useSafeAsync<T>(
  fn: (...args: any[]) => Promise<T>,
  options?: UseSafeAsyncOptions,
): UseSafeAsyncReturn<T> {
  const { timeoutMs = 20_000 } = options ?? {};

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<Error | null>(null);

  const mountedRef  = useRef(true);
  const runningRef  = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const run = useCallback(
    async (...args: any[]): Promise<T | undefined> => {
      // Block double execution
      if (runningRef.current) {
        if (__DEV__) console.log('[useSafeAsync] blocked duplicate call');
        return undefined;
      }

      runningRef.current = true;
      if (mountedRef.current) {
        setLoading(true);
        setError(null);
      }

      if (__DEV__) console.log('[useSafeAsync] started');

      try {
        let result: T;

        if (timeoutMs > 0) {
          // Race the real work against a timeout
          result = await Promise.race([
            fn(...args),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('Operation timed out. Please try again.')),
                timeoutMs,
              ),
            ),
          ]);
        } else {
          result = await fn(...args);
        }

        if (__DEV__) console.log('[useSafeAsync] succeeded');
        return result;
      } catch (err: any) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (__DEV__) console.warn('[useSafeAsync] failed:', e.message);
        if (mountedRef.current) setError(e);
        throw e; // re-throw so callers can optionally handle it
      } finally {
        runningRef.current = false;
        if (mountedRef.current) setLoading(false);
        if (__DEV__) console.log('[useSafeAsync] finished');
      }
    },
    [fn, timeoutMs],
  );

  const reset = useCallback(() => {
    setError(null);
  }, []);

  return { run, loading, error, reset };
}
