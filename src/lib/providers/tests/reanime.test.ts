import test from 'node:test';
import assert from 'node:assert/strict';
import { reanime } from '../reanime';
import { verifyPlaylist } from '../types';

test('ReAnime search, episode listing, and episode 1 sub streams', async () => {
  const hits = await reanime.searchByTitle('Cowboy Bebop');
  assert.ok(hits.length > 0, 'expected a search hit');
  const episodes = await reanime.listEpisodes(hits[0].id);
  assert.ok(episodes.length > 0, 'expected episodes');
  const episode = episodes.find(item => item.num === 1);
  assert.ok(episode, 'expected episode 1');
  const sources = await reanime.resolve(episode.id, 'sub');
  assert.ok(sources.length > 0, 'expected stream sources');
  for (const source of sources) {
    assert.match(source.url, /^https?:/);
    assert.equal(await verifyPlaylist(source.url, source.headers), true);
  }
});
