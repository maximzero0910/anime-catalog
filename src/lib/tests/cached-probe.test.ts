import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCachedProbe } from '../cached-probe';

test('cached probe coalesces concurrent reads and caches values until expiry', async () => {
  let time = 100;
  let calls = 0;
  const probe = createCachedProbe(async () => {
    calls++;
    await Promise.resolve();
    return { gpu: 'test' };
  }, { ttlMs: 50, now: () => time });

  const [first, concurrent] = await Promise.all([probe(), probe()]);
  assert.deepEqual(first, { gpu: 'test' });
  assert.deepEqual(concurrent, first);
  assert.equal(calls, 1);
  await probe();
  assert.equal(calls, 1);

  time += 50;
  await probe();
  assert.equal(calls, 2);
});

test('cached probe caches unavailable hardware and converts probe errors to null', async () => {
  let calls = 0;
  const probe = createCachedProbe(async () => {
    calls++;
    throw new Error('optional command unavailable');
  }, { ttlMs: 60_000 });

  assert.equal(await probe(), null);
  assert.equal(await probe(), null);
  assert.equal(calls, 1);
});
