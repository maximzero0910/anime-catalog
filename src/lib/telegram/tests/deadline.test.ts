import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramOperationError, withTelegramDeadline } from '../deadline';

test('Telegram operation deadline settles stalled work and interrupts its transport once', async () => {
  let interrupted = 0;
  await assert.rejects(
    withTelegramDeadline('page fetch', 10, () => new Promise<never>(() => undefined), { onInterrupt: () => { interrupted++; } }),
    (error: unknown) => error instanceof TelegramOperationError && error.kind === 'timeout' && error.operation === 'page fetch',
  );
  assert.equal(interrupted, 1);
});

test('Telegram operation cancellation interrupts stalled work promptly', async () => {
  const controller = new AbortController();
  let interrupted = 0;
  const pending = withTelegramDeadline('sync', 1000, () => new Promise<never>(() => undefined), {
    signal: controller.signal,
    onInterrupt: () => { interrupted++; },
  });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof TelegramOperationError && error.kind === 'cancelled');
  assert.equal(interrupted, 1);
});

test('Telegram operation deadline preserves successful results and ordinary failures', async () => {
  assert.equal(await withTelegramDeadline('lookup', 100, async () => 42), 42);
  await assert.rejects(withTelegramDeadline('lookup', 100, async () => { throw new Error('RPC rejected'); }), /RPC rejected/);
});
