import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAcrossProviders } from '../search';
import type { SearchHit } from '../types';

test('search aggregates working providers while retaining provider-specific series IDs', async () => {
  const result = await searchAcrossProviders('Tougen Anki', [
    { id: 'anikoto', searchByTitle: async () => [{ id: 'tougen-anki', title: 'Tougen Anki' }] },
    { id: '9anime', searchByTitle: async () => [{ id: 'https://9anime.or.at/anime/tougen-anki', title: 'Tougen Anki', alt: ['Tougen Anki Season 1'] }] },
    { id: 'allanime', searchByTitle: async (): Promise<SearchHit[]> => { throw new Error('upstream failed'); } },
  ]);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map(hit => hit.providerId), ['anikoto', '9anime']);
  assert.equal(result.results[1]?.id, 'https://9anime.or.at/anime/tougen-anki');
  assert.deepEqual(result.providers, [
    { providerId: 'anikoto', count: 1 },
    { providerId: '9anime', count: 1 },
    { providerId: 'allanime', count: 0, error: 'upstream failed' },
  ]);
});

test('search bounds slow providers and returns partial results', async () => {
  const result = await searchAcrossProviders('Frieren', [
    { id: 'fast', searchByTitle: async () => [{ id: 'frieren', title: 'Frieren' }] },
    { id: 'slow', searchByTitle: () => new Promise<SearchHit[]>(resolve => setTimeout(() => resolve([]), 50)) },
  ], 5);
  assert.equal(result.results.length, 1);
  assert.match(result.providers[1]!.error ?? '', /timed out/);
});
