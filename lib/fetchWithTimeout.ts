// lib/fetchWithTimeout.ts
// Shared fetch wrapper with AbortController-based timeout.
// Prevents any network call from hanging indefinitely.

const DEFAULT_TIMEOUT_MS = 20_000; // 20 seconds

/**
 * Drop-in replacement for `fetch()` that automatically aborts after
 * `timeoutMs` milliseconds. Throws an error with a clear message so
 * callers / react-query can surface it to the user.
 *
 * If the caller already provides an AbortSignal (e.g. from react-query),
 * the request will abort on whichever signal fires first.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init ?? {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // If the caller already set a signal, race both signals.
  if (fetchInit.signal) {
    fetchInit.signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const res = await fetch(input, { ...fetchInit, signal: controller.signal });
    return res;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
