import test from 'node:test';
import assert from 'node:assert/strict';
import { allanime } from '../allanime';
import { verifyPlaylist } from '../types';

test('AllAnime search, episode listing, and episode 1 sub streams', async () => {
  const hits = await allanime.searchByTitle('Cowboy Bebop');
  assert.ok(hits.length > 0, 'expected a search hit');
  const episodes = await allanime.listEpisodes(hits[0].id);
  assert.ok(episodes.length > 0, 'expected episodes');
  const episode = episodes.find(item => item.num === 1);
  assert.ok(episode, 'expected episode 1');
  const sources = await allanime.resolve(episode.id, 'sub');
  assert.ok(sources.length > 0, 'expected stream sources');
  const playable = sources.filter(source => source.type === 'hls');
  assert.ok(playable.length > 0, 'expected HLS stream sources');
  for (const source of playable) {
    assert.match(source.url, /^https?:/);
    assert.equal(await verifyPlaylist(source.url, source.headers), true);
  }
});
