const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` with exponential backoff when `isRetryable` returns true for
 * the thrown error. Non-retryable errors propagate immediately.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{
 *   isRetryable: (error: unknown) => boolean,
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   onRetry?: (attempt: number, error: unknown, delayMs: number) => void,
 * }} options
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !options.isRetryable(error)) {
        throw error;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop always returns or throws.
  throw new Error("withRetry exhausted attempts without returning or throwing");
}
