import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedGate, resourceGateConfiguration } from '../resource-limits';

test('resource gate settings use conservative defaults and clamp configured values', () => {
  assert.deepEqual(resourceGateConfiguration({})['provider-resolution'], { active: 4, waiting: 8, waitMs: 3000 });
  const configured = resourceGateConfiguration({ RESOURCE_PROVIDER_SEARCH_ACTIVE: '1000', RESOURCE_PROVIDER_SEARCH_WAITING: '-2', RESOURCE_GATE_WAIT_MS: '1' });
  assert.deepEqual(configured['provider-search'], { active: 64, waiting: 0, waitMs: 50 });
  assert.deepEqual(resourceGateConfiguration({ RESOURCE_METADATA_ACTIVE: 'NaN' }).metadata, { active: 4, waiting: 8, waitMs: 3000 });
});

test('bounded gate rejects excess work and admits queued work when a slot frees', async () => {
  const gate = new BoundedGate('test', 1, 1, 1000);
  let completeFirst!: () => void;
  const first = gate.run(() => new Promise<void>(resolve => { completeFirst = resolve; }));
  await Promise.resolve();
  let secondStarted = false;
  const second = gate.run(async () => { secondStarted = true; });
  assert.deepEqual(gate.snapshot(), { name: 'test', active: 1, waiting: 1, maxActive: 1, maxWaiting: 1 });
  await assert.rejects(gate.run(async () => undefined), /capacity exhausted/);
  completeFirst();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
  assert.deepEqual(gate.snapshot(), { name: 'test', active: 0, waiting: 0, maxActive: 1, maxWaiting: 1 });
});

test('bounded gate removes an aborted waiter without consuming capacity', async () => {
  const gate = new BoundedGate('test', 1, 1, 1000);
  let completeFirst!: () => void;
  const first = gate.run(() => new Promise<void>(resolve => { completeFirst = resolve; }));
  await Promise.resolve();
  const controller = new AbortController();
  const second = gate.run(async () => undefined, controller.signal);
  controller.abort();
  await assert.rejects(second, /request cancelled/);
  assert.equal(gate.snapshot().waiting, 0);
  completeFirst();
  await first;
  assert.equal(gate.snapshot().active, 0);
});
test('bounded gate expires a queued request instead of allowing an unbounded wait', async () => {
  const gate = new BoundedGate('test', 1, 1, 5);
  let completeFirst!: () => void;
  const first = gate.run(() => new Promise<void>(resolve => { completeFirst = resolve; }));
  await Promise.resolve();
  await assert.rejects(gate.run(async () => undefined), /wait queue timed out/);
  completeFirst();
  await first;
});
