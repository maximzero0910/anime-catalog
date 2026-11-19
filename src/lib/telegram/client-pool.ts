export class ClientPoolError extends Error {
  constructor(readonly kind: 'capacity' | 'timeout' | 'cancelled' | 'closed') {
    super(`Telegram client pool ${kind}`);
    this.name = 'ClientPoolError';
  }
}

interface ClientSlot<T> {
  id: number;
  busy: boolean;
  value?: T;
  creating?: Promise<T>;
}

interface ClientWaiter<T> {
  resolve: (slot: ClientSlot<T>) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

export interface ClientLease<T> {
  id: number;
  value: T;
  release(): void;
  invalidate(): Promise<void>;
}

export class BoundedClientPool<T> {
  private readonly slots: ClientSlot<T>[] = [];
  private readonly waiters: ClientWaiter<T>[] = [];
  private closed = false;
  private nextSlotId = 1;

  constructor(
    readonly size: number,
    readonly maxWaiting: number,
    readonly waitMs: number,
    private readonly create: (id: number, signal?: AbortSignal) => Promise<T>,
    private readonly destroy: (value: T) => Promise<void> | void,
  ) {
    if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(maxWaiting) || maxWaiting < 0 || !Number.isFinite(waitMs) || waitMs < 1) {
      throw new RangeError('Invalid Telegram client pool limits');
    }
  }

  async acquire(signal?: AbortSignal): Promise<ClientLease<T>> {
    if (this.closed) throw new ClientPoolError('closed');
    if (signal?.aborted) throw new ClientPoolError('cancelled');
    let slot = this.slots.find(candidate => !candidate.busy);
    if (slot) {
      slot.busy = true;
      try { return await this.makeLease(slot, signal); }
      catch (error) { this.releaseSlot(slot); throw error; }
    }
    if (this.slots.length < this.size) {
      slot = { id: this.nextSlotId++, busy: true };
      this.slots.push(slot);
      try { return await this.makeLease(slot, signal); }
      catch (error) { this.removeSlot(slot); throw error; }
    }
    const assigned = await this.waitForSlot(signal);
    try { return await this.makeLease(assigned, signal); }
    catch (error) { this.releaseSlot(assigned); throw error; }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter);
      waiter.reject(new ClientPoolError('closed'));
    }
    const values = this.slots.flatMap(slot => slot.value ? [slot.value] : []);
    const creating = this.slots.flatMap(slot => slot.creating ? [slot.creating.catch(() => undefined)] : []);
    this.slots.length = 0;
    await Promise.allSettled([
      ...values.map(value => Promise.resolve(this.destroy(value))),
      ...creating,
    ]);
  }

  snapshot(): { size: number; active: number; waiting: number; closed: boolean } {
    return { size: this.size, active: this.slots.filter(slot => slot.busy).length, waiting: this.waiters.length, closed: this.closed };
  }

  private async value(slot: ClientSlot<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed || !this.slots.includes(slot)) throw new ClientPoolError('closed');
    if (signal?.aborted) throw new ClientPoolError('cancelled');
    if (slot.value) return slot.value;
    if (!slot.creating) {
      let creating: Promise<T>;
      creating = this.create(slot.id, signal).then(async value => {
        if (signal?.aborted) {
          await Promise.resolve(this.destroy(value)).catch(() => undefined);
          throw new ClientPoolError('cancelled');
        }
        if (this.closed || !this.slots.includes(slot)) {
          await Promise.resolve(this.destroy(value)).catch(() => undefined);
          throw new ClientPoolError('closed');
        }
        slot.value = value;
        slot.creating = undefined;
        return value;
      }).catch(error => {
        if (slot.creating === creating) slot.creating = undefined;
        throw error;
      });
      slot.creating = creating;
    }
    return slot.creating;
  }

  private async makeLease(slot: ClientSlot<T>, signal?: AbortSignal): Promise<ClientLease<T>> {
    const value = await this.value(slot, signal);
    if (signal?.aborted) throw new ClientPoolError('cancelled');
    if (this.closed || !this.slots.includes(slot)) throw new ClientPoolError('closed');
    return this.lease(slot, value);
  }

  private lease(slot: ClientSlot<T>, value: T): ClientLease<T> {
    let released = false;
    let invalidated = false;
    let destruction: Promise<void> | undefined;
    return {
      id: slot.id,
      value,
      invalidate: () => {
        if (invalidated) return destruction ?? Promise.resolve();
        invalidated = true;
        if (slot.value === value) delete slot.value;
        destruction = Promise.resolve(this.destroy(value)).catch(() => undefined);
        return destruction;
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseSlot(slot);
      },
    };
  }

  private waitForSlot(signal?: AbortSignal): Promise<ClientSlot<T>> {
    if (this.waiters.length >= this.maxWaiting) return Promise.reject(new ClientPoolError('capacity'));
    return new Promise((resolve, reject) => {
      const waiter: ClientWaiter<T> = { resolve, reject, signal };
      const remove = (error: Error) => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        this.cleanup(waiter);
        reject(error);
      };
      waiter.abort = () => remove(new ClientPoolError('cancelled'));
      waiter.timer = setTimeout(() => remove(new ClientPoolError('timeout')), this.waitMs);
      waiter.timer.unref?.();
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      if (signal?.aborted) waiter.abort();
    });
  }

  private releaseSlot(slot: ClientSlot<T>): void {
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!;
      this.cleanup(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(new ClientPoolError('cancelled'));
        continue;
      }
      slot.busy = true;
      waiter.resolve(slot);
      return;
    }
    slot.busy = false;
  }

  private removeSlot(slot: ClientSlot<T>): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
  }

  private cleanup(waiter: ClientWaiter<T>): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
  }
}
