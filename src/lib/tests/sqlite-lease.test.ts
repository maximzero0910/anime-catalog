import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteLease } from '../sqlite-lease';

test('SQLite lease prevents overlap, expires after crash, and fences the former owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anineko-lease-test-'));
  const path = join(root, 'catalog.db');
  const firstDb = new Database(path);
  const secondDb = new Database(path);
  try {
    const first = createSqliteLease(firstDb, 'telegram-sync');
    const second = createSqliteLease(secondDb, 'telegram-sync');
    assert.equal(first.acquire('worker-a', 1000, 5000), true);
    assert.equal(second.isActive(2000), true);
    assert.equal(second.acquire('worker-b', 2000, 5000), false);
    assert.equal(second.renew('worker-b', 2000), false);
    assert.equal(second.acquire('worker-b', 6000, 5000), true);
    assert.equal(first.isActive(6000), true);
    assert.equal(first.renew('worker-a', 6001), false);
    assert.equal(first.release('worker-a'), false);
    assert.equal(second.renew('worker-b', 7000), true);
    assert.equal(first.acquire('worker-a', 8000, 5000), false);
    assert.equal(second.release('worker-b'), true);
    assert.equal(first.acquire('worker-a', 8001, 5000), true);
  } finally { firstDb.close(); secondDb.close(); await rm(root, { recursive: true, force: true }); }
});
