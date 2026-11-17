export class TelegramOperationError extends Error {
  constructor(readonly kind: 'timeout' | 'cancelled', readonly operation: string) {
    super(`Telegram ${operation} ${kind}`);
    this.name = 'TelegramOperationError';
  }
}

export function withTelegramDeadline<T>(
  operation: string,
  timeoutMs: number,
  work: () => Promise<T>,
  options: { signal?: AbortSignal; onInterrupt?: () => void } = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(new RangeError('Telegram deadline must be positive'));
  if (options.signal?.aborted) return Promise.reject(new TelegramOperationError('cancelled', operation));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const interrupt = (error: TelegramOperationError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { options.onInterrupt?.(); } catch { /* Preserve the timeout/cancellation as the useful failure. */ }
      reject(error);
    };
    const onAbort = () => interrupt(new TelegramOperationError('cancelled', operation));
    const timer = setTimeout(() => interrupt(new TelegramOperationError('timeout', operation)), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    Promise.resolve().then(() => {
      if (settled) throw new TelegramOperationError('cancelled', operation);
      return work();
    }).then(value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}
