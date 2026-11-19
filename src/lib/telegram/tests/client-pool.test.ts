import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedClientPool, ClientPoolError } from '../client-pool';

test('client pool caps clients, queues one borrower, and reuses a released client', async () => {
  let created = 0;
  const pool = new BoundedClientPool(1, 1, 100, async id => `client-${id}-${++created}`, () => undefined);
  const first = await pool.acquire();
  const waiting = pool.acquire();
  assert.deepEqual(pool.snapshot(), { size: 1, active: 1, waiting: 1, closed: false });
  await assert.rejects(pool.acquire(), (error: unknown) => error instanceof ClientPoolError && error.kind === 'capacity');
  first.release();
  const second = await waiting;
  assert.equal(second.value, first.value);
  assert.equal(created, 1);
  second.release();
  await pool.close();
});

test('client pool cancellation and wait timeout remove queued borrowers', async () => {
  const pool = new BoundedClientPool(1, 2, 20, async id => id, () => undefined);
  const first = await pool.acquire();
  const controller = new AbortController();
  const cancelled = pool.acquire(controller.signal);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof ClientPoolError && error.kind === 'cancelled');
  await assert.rejects(pool.acquire(), (error: unknown) => error instanceof ClientPoolError && error.kind === 'timeout');
  assert.equal(pool.snapshot().waiting, 0);
  first.release();
  await pool.close();
});

test('aborting while a client is connecting destroys a late result and does not leave a cached rejected slot', async () => {
  let resolveClient!: (value: string) => void;
  let observedSignal: AbortSignal | undefined;
  let createCount = 0;
  const destroyed: string[] = [];
  const pool = new BoundedClientPool<string>(1, 0, 100, (_id, signal) => {
    createCount++;
    observedSignal = signal;
    return createCount === 1 ? new Promise(resolve => { resolveClient = resolve; }) : Promise.resolve('replacement');
  }, value => { destroyed.push(value); });
  const controller = new AbortController();
  const acquiring = pool.acquire(controller.signal);
  controller.abort();
  resolveClient('late-client');
  await assert.rejects(acquiring, (error: unknown) => error instanceof ClientPoolError && error.kind === 'cancelled');
  assert.equal(observedSignal, controller.signal);
  assert.deepEqual(destroyed, ['late-client']);
  assert.equal(pool.snapshot().active, 0);
  const replacement = await pool.acquire();
  assert.equal(replacement.value, 'replacement');
  replacement.release();
});

test('invalidating one client destroys it and the next lease creates a replacement', async () => {
  let created = 0;
  const destroyed: string[] = [];
  const pool = new BoundedClientPool(1, 0, 20, async id => `client-${id}-${++created}`, value => { destroyed.push(value); });
  const first = await pool.acquire();
  await first.invalidate();
  first.release();
  const replacement = await pool.acquire();
  assert.notEqual(replacement.value, first.value);
  assert.deepEqual(destroyed, [first.value]);
  replacement.release();
  await pool.close();
});

test('failed client creation does not leave capacity occupied', async () => {
  let fail = true;
  const pool = new BoundedClientPool(1, 0, 20, async () => {
    if (fail) { fail = false; throw new Error('connect failed'); }
    return 'connected';
  }, () => undefined);
  await assert.rejects(pool.acquire(), /connect failed/);
  const lease = await pool.acquire();
  assert.equal(lease.value, 'connected');
  lease.release();
  await pool.close();
});

test('pool shutdown rejects waiters and destroys existing clients', async () => {
  let destroyed = 0;
  const pool = new BoundedClientPool(1, 1, 1000, async id => id, () => { destroyed++; });
  const lease = await pool.acquire();
  const waiting = pool.acquire();
  await pool.close();
  await assert.rejects(waiting, (error: unknown) => error instanceof ClientPoolError && error.kind === 'closed');
  assert.equal(destroyed, 1);
  assert.deepEqual(pool.snapshot(), { size: 1, active: 0, waiting: 0, closed: true });
  lease.release();
});

test('pool shutdown also waits for and destroys a client that is still connecting', async () => {
  let finish!: (value: string) => void;
  let destroyed = 0;
  const pool = new BoundedClientPool(1, 0, 100, () => new Promise<string>(resolve => { finish = resolve; }), () => { destroyed++; });
  const connecting = pool.acquire();
  await Promise.resolve();
  const shutdown = pool.close();
  finish('late-client');
  await shutdown;
  await assert.rejects(connecting, (error: unknown) => error instanceof ClientPoolError && error.kind === 'closed');
  assert.equal(destroyed, 1);
  assert.deepEqual(pool.snapshot(), { size: 1, active: 0, waiting: 0, closed: true });
});

test('pool shutdown fences a waiter assigned in the same turn as release', async () => {
  let destroyed = 0;
  const pool = new BoundedClientPool(1, 1, 1000, async id => id, () => { destroyed++; });
  const first = await pool.acquire();
  const waiting = pool.acquire();
  first.release();
  const shutdown = pool.close();
  await shutdown;
  await assert.rejects(waiting, (error: unknown) => error instanceof ClientPoolError && error.kind === 'closed');
  assert.equal(destroyed, 1);
});
