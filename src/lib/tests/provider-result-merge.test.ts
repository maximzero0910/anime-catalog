import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProviderResults, type FilterableAnime } from '../catalog-filters';

test('duplicate provider hits merge to one card while retaining provider-specific IDs', () => {
  const items: FilterableAnime[] = [
    { id: '154587', title: 'Frieren: Beyond Journey’s End', providerId: 'telegram', anilistId: 154587 },
    { id: 'frieren-beyond-journey-s-end-c6fbj', title: "Frieren: Beyond Journey's End", providerId: 'anikoto', anilistId: 154587 },
    { id: 'https://9anime.or.at/anime/frieren/', title: 'Frieren: Beyond Journey’s End', providerId: '9anime', anilistId: 154587 },
  ];
  const [merged] = mergeProviderResults(items);
  assert.equal(mergeProviderResults(items).length, 1);
  assert.equal(merged?.providerId, 'anikoto');
  assert.deepEqual(merged?.providerChoices, [
    { providerId: 'telegram', id: '154587' },
    { providerId: 'anikoto', id: 'frieren-beyond-journey-s-end-c6fbj' },
    { providerId: '9anime', id: 'https://9anime.or.at/anime/frieren/' },
  ]);
});

test('different AniList seasons remain separate cards', () => {
  const items: FilterableAnime[] = [
    { id: 'a', title: 'Frieren: Beyond Journey’s End', providerId: 'telegram', anilistId: 154587 },
    { id: 'b', title: 'Frieren: Beyond Journey’s End Season 2', providerId: 'telegram', anilistId: 182255 },
  ];
  assert.equal(mergeProviderResults(items).length, 2);
});
