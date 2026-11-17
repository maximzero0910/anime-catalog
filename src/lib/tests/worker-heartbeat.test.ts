import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createWorkerHeartbeatStore } from '../worker-heartbeat';

test('worker heartbeat reports a fresh process and marks a crash stale without deleting state', () => {
  const database = new Database(':memory:');
  try {
    const store = createWorkerHeartbeatStore(database);
    store.beat('subtitle-worker', 100_000, 41);
    assert.deepEqual(store.list(110_000, 30_000).map(row => ({ worker: row.worker, healthy: row.healthy, pid: row.pid })), [
      { worker: 'subtitle-worker', healthy: true, pid: 41 },
    ]);
    assert.equal(store.list(140_001, 30_000)[0]?.healthy, false);
    assert.equal(store.list(140_001, 30_000)[0]?.state, 'running');
    store.beat('subtitle-worker', 150_000, 42);
    assert.equal(store.list(150_001, 30_000)[0]?.healthy, true);
    store.stopped('subtitle-worker', 151_000, 42);
    assert.equal(store.list(151_001, 30_000)[0]?.healthy, false);
    assert.equal(store.list(151_001, 30_000)[0]?.state, 'stopped');
  } finally { database.close(); }
});

test('worker heartbeat validates names before writing persistent rows', () => {
  const database = new Database(':memory:');
  try {
    const store = createWorkerHeartbeatStore(database);
    assert.throws(() => store.beat('../secret', 100_000, 1), /invalid worker name/);
    assert.deepEqual(store.list(), []);
  } finally { database.close(); }
});
