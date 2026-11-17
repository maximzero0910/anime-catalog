import test from 'node:test';
import assert from 'node:assert/strict';
import { indexProviderCandidates } from '../index-runner';

test('only an authoritative empty provider response enters the negative cache', async () => {
  let misses = 0;
  assert.equal(await indexProviderCandidates({
    search: async () => [],
    recordDefinitiveMiss: () => { misses++; },
    index: async () => undefined,
  }), 0);
  assert.equal(misses, 1);

  await assert.rejects(indexProviderCandidates({
    search: async () => { throw new Error('temporary upstream timeout'); },
    recordDefinitiveMiss: () => { misses++; },
    index: async () => undefined,
  }), /temporary upstream timeout/);
  assert.equal(misses, 1, 'temporary search failures must remain eligible for retry');
});

test('candidate storage failures remain retryable and are never cached as provider misses', async () => {
  let misses = 0;
  await assert.rejects(indexProviderCandidates({
    search: async () => ['candidate'],
    recordDefinitiveMiss: () => { misses++; },
    index: async () => { throw new Error('asset storage temporarily unavailable'); },
  }), /asset storage temporarily unavailable/);
  assert.equal(misses, 0);
});

test('retry resumes after the last durably indexed provider candidate', async () => {
  const indexed = new Set(['already-stored']);
  const visited: string[] = [];
  const count = await indexProviderCandidates({
    search: async () => ['already-stored', 'needs-indexing'],
    recordDefinitiveMiss: () => assert.fail('non-empty provider results are not a miss'),
    isAlreadyIndexed: candidate => indexed.has(candidate),
    index: async candidate => { visited.push(candidate); indexed.add(candidate); },
  });
  assert.deepEqual(visited, ['needs-indexing']);
  assert.equal(count, 1);
});
