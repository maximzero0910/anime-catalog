import test from 'node:test';
import assert from 'node:assert/strict';
import { isExactProviderTitle, resolveExactTitleFallback } from '../fallback';
import type { Provider, SearchHit, StreamSource } from '../types';

const source: StreamSource = { url: 'https://media.example.test/video.m3u8', quality: 'auto', type: 'hls', headers: {}, subtitles: [], audio: 'sub', provider: 'other' };

function provider(hit: SearchHit): Provider {
  return {
    id: 'other', weight: 1, score: 1,
    async searchByTitle() { return [hit]; },
    async listEpisodes() { return [{ num: 1, id: 'episode-1' }]; },
    async resolve() { return [source]; },
    async health() { return true; },
  };
}

test('fallback only associates an exact title and same episode number', async () => {
  assert.equal(isExactProviderTitle({ id: 'x', title: 'Tokyo Revengers: Tenjiku-hen' }, 'Tokyo Revengers'), false);
  const wrongTitle = provider({ id: 'wrong', title: 'Tokyo Revengers: Tenjiku-hen' });
  assert.equal(await resolveExactTitleFallback('Tokyo Revengers', 1, [wrongTitle], '9anime', 'sub', async () => true), undefined);
  const exactTitle = provider({ id: 'same', title: 'Tokyo Revengers' });
  assert.equal(await resolveExactTitleFallback('Tokyo Revengers', 1, [exactTitle], '9anime', 'sub', async () => true), source);
});

test('fallback rejects unplayable exact-title sources', async () => {
  const exactTitle = provider({ id: 'same', title: 'Tokyo Revengers' });
  assert.equal(await resolveExactTitleFallback('Tokyo Revengers', 1, [exactTitle], '9anime', 'sub', async () => false), undefined);
});
