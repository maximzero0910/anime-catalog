export class ResourceLimitError extends Error {
  constructor(readonly status: 429 | 503, message: string) { super(message); this.name = 'ResourceLimitError'; }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

export class BoundedGate {
  private active = 0;
  private waiters: Waiter[] = [];

  constructor(readonly name: string, readonly maxActive: number, readonly maxWaiting: number, readonly waitMs = 3000) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || !Number.isSafeInteger(maxWaiting) || maxWaiting < 0) throw new Error('invalid resource gate limits');
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try { return await operation(); }
    finally { release(); }
  }

  snapshot(): { name: string; active: number; waiting: number; maxActive: number; maxWaiting: number } {
    return { name: this.name, active: this.active, waiting: this.waiters.length, maxActive: this.maxActive, maxWaiting: this.maxWaiting };
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ResourceLimitError(503, `${this.name}: request cancelled`));
    if (this.active < this.maxActive) { this.active++; return Promise.resolve(this.releaseHandle()); }
    if (this.waiters.length >= this.maxWaiting) return Promise.reject(new ResourceLimitError(503, `${this.name}: capacity exhausted`));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const remove = (error: Error) => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        this.cleanup(waiter);
        reject(error);
      };
      waiter.abort = () => remove(new ResourceLimitError(503, `${this.name}: request cancelled`));
      waiter.timer = setTimeout(() => remove(new ResourceLimitError(503, `${this.name}: wait queue timed out`)), this.waitMs);
      waiter.timer.unref?.();
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      while (this.waiters.length) {
        const waiter = this.waiters.shift()!;
        this.cleanup(waiter);
        if (waiter.signal?.aborted) {
          waiter.reject(new ResourceLimitError(503, `${this.name}: request cancelled`));
          continue;
        }
        this.active++;
        waiter.resolve(this.releaseHandle());
        break;
      }
    };
  }

  private cleanup(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
  }
}

const gates = new Map<string, BoundedGate>();
export type ResourceGateName = 'provider-search' | 'provider-resolution' | 'metadata' | 'catalog-filter';
export interface ResourceGateLimits { active: number; waiting: number; waitMs: number }
export type ResourceGateConfiguration = Record<ResourceGateName, ResourceGateLimits>;

function boundedInteger(environment: Record<string, string | undefined>, name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(environment[name]);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function resourceGateConfiguration(environment: Record<string, string | undefined>): ResourceGateConfiguration {
  const waitMs = boundedInteger(environment, 'RESOURCE_GATE_WAIT_MS', 3000, 50, 30_000);
  const limits = (name: string, active: number, waiting: number): ResourceGateLimits => ({
    active: boundedInteger(environment, `RESOURCE_${name}_ACTIVE`, active, 1, 64),
    waiting: boundedInteger(environment, `RESOURCE_${name}_WAITING`, waiting, 0, 256),
    waitMs,
  });
  return {
    'provider-search': limits('PROVIDER_SEARCH', 8, 8),
    'provider-resolution': limits('PROVIDER_RESOLUTION', 4, 8),
    metadata: limits('METADATA', 4, 8),
    'catalog-filter': limits('CATALOG_FILTER', 2, 4),
  };
}

const definitions = resourceGateConfiguration(process.env);

export function withResourceLimit<T>(name: ResourceGateName, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let gate = gates.get(name);
  if (!gate) {
    const limits = definitions[name];
    gate = new BoundedGate(name, limits.active, limits.waiting, limits.waitMs);
    gates.set(name, gate);
  }
  return gate.run(operation, signal);
}

export function resourceLimitSnapshot(): Array<ReturnType<BoundedGate['snapshot']>> {
  return [...gates.values()].map(gate => gate.snapshot());
}
