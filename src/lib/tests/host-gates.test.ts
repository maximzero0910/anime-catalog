import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostGateRegistry } from '../host-gates';

test('per-host gates cap active work, queue depth, and host registry size', async () => {
  const registry = createHostGateRegistry({ caps: { 'slow.test': 1 }, defaultActive: 1, maxHosts: 1, waitersPerSlot: 1, waitMs: 500 });
  let release!: () => void;
  const active = registry.run('https://slow.test/a', () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const queued = registry.run('https://slow.test/b', async () => undefined);
  await assert.rejects(registry.run('https://slow.test/c', async () => undefined), /capacity exhausted/);
  assert.throws(() => registry.run('https://other.test/a', async () => undefined), /host capacity exhausted/);
  release();
  await Promise.all([active, queued]);
  await registry.run('https://other.test/a', async () => undefined);
  assert.equal(registry.snapshot().length, 1);
});

test('invalid provider host URLs are rejected without allocating a gate', async () => {
  const registry = createHostGateRegistry();
  await assert.rejects(registry.run('not-a-url', async () => undefined), /invalid provider host URL/);
  assert.deepEqual(registry.snapshot(), []);
});
