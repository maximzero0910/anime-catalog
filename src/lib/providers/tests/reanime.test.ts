import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { reanime } from '../reanime';
import { verifyPlaylist } from '../types';

test('ReAnime search, episode listing, and episode 1 sub stream are extracted from mocked provider responses', async () => {
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const site = mockAgent.get('https://reanime.net');
  site.intercept({ path: '/search?q=Cowboy%20%26%20Bebop', method: 'GET', headers: { referer: 'https://reanime.net/' } })
    .reply(200, '<a href="/anime/cowboy-bebop">Cowboy <b>Bebop</b></a>');
  site.intercept({ path: '/anime/cowboy-bebop', method: 'GET', headers: { referer: 'https://reanime.net/' } })
    .reply(200, '<a href="/anime/cowboy-bebop/ep-1">Episode 1</a><a href="/anime/cowboy-bebop/2">Episode 2</a>');
  site.intercept({ path: '/anime/cowboy-bebop/ep-1', method: 'GET', headers: { referer: 'https://reanime.net/' } })
    .reply(200, '<iframe src="https://embed.reanime.example/player"></iframe>');
  mockAgent.get('https://embed.reanime.example').intercept({ path: '/player', method: 'GET', headers: { referer: 'https://reanime.net/anime/cowboy-bebop/ep-1' } })
    .reply(200, '<script>sources: [{"file":"https://media.reanime.example/episode.m3u8"}]</script>');
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST\n';
  for (let request = 0; request < 2; request++) {
    mockAgent.get('https://media.reanime.example').intercept({ path: '/episode.m3u8', method: 'GET', headers: { referer: 'https://embed.reanime.example/' } })
      .reply(200, playlist);
  }

  setGlobalDispatcher(mockAgent);
  try {
    const hits = await reanime.searchByTitle('Cowboy & Bebop');
    assert.deepEqual(hits, [{ id: 'cowboy-bebop', title: 'Cowboy Bebop' }]);
    const episodes = await reanime.listEpisodes(hits[0].id);
    assert.deepEqual(episodes.map(item => item.num), [1, 2]);
    const sources = await reanime.resolve(episodes[0].id, 'sub');
    assert.equal(sources.length, 1);
    assert.match(sources[0].url, /^https?:/);
    assert.equal(await verifyPlaylist(sources[0].url, sources[0].headers), true);
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
  }
});
