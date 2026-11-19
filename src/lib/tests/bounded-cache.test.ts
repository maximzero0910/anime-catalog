import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedTtlCache } from '../bounded-cache';

test('bounded TTL cache evicts least recently used entries and expires old values', () => {
  let now = 100;
  const cache = new BoundedTtlCache<string, string>(2, () => now);
  cache.set('a', 'A', 20);
  cache.set('b', 'B', 20);
  assert.equal(cache.get('a'), 'A');
  cache.set('c', 'C', 20);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), undefined);
  now = 121;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.size, 0);
});

test('bounded TTL cache conditional deletion does not remove a newer replacement', () => {
  const cache = new BoundedTtlCache<string, object>(1);
  const old = {};
  const fresh = {};
  cache.set('key', old, 1000);
  cache.set('key', fresh, 1000);
  assert.equal(cache.delete('key', old), false);
  assert.equal(cache.get('key'), fresh);
});
