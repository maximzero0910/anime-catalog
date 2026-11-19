/** Cache optional host probes, including unavailable results, and coalesce callers. */
export function createCachedProbe<T>(
  probe: () => Promise<T | null>,
  options: { ttlMs?: number; now?: () => number } = {},
): () => Promise<T | null> {
  const ttlMs = Math.max(0, options.ttlMs ?? 60_000);
  const now = options.now ?? Date.now;
  let value: T | null = null;
  let expiresAt = 0;
  let initialized = false;
  let pending: Promise<T | null> | null = null;

  return async () => {
    const current = now();
    if (initialized && current < expiresAt) return value;
    if (pending) return pending;

    pending = Promise.resolve()
      .then(probe)
      .catch(() => null)
      .then((result) => {
        value = result;
        initialized = true;
        expiresAt = now() + ttlMs;
        return value;
      })
      .finally(() => { pending = null; });
    return pending;
  };
}
