import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { allanime } from '../allanime';
import { verifyPlaylist } from '../types';

const searchQuery = 'query($search:SearchInput,$limit:Int,$page:Int,$translationType:VaildTranslationTypeEnumType,$countryOrigin:VaildCountryOriginEnumType){shows(search:$search,limit:$limit,page:$page,translationType:$translationType,countryOrigin:$countryOrigin){edges{_id name englishName availableEpisodes __typename}}}';
const episodesQuery = 'query($showId:String!){show(_id:$showId){_id availableEpisodesDetail}}';
const sourcesQuery = 'query($showId:String!,$episodeString:String!,$translationType:VaildTranslationTypeEnumType!){episode(showId:$showId,episodeString:$episodeString,translationType:$translationType){sourceUrls}}';

function graphqlPath(query: string, variables: Record<string, unknown>): string {
  const url = new URL('https://api.allanime.day/api');
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('query', query);
  return `${url.pathname}${url.search}`;
}

test('AllAnime search, episode listing, and episode 1 sub streams use the current GraphQL contract', async () => {
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const api = mockAgent.get('https://api.allanime.day');
  const commonHeaders = { referer: 'https://allanime.day/', origin: 'https://allanime.day' };
  api.intercept({ path: graphqlPath(searchQuery, { search: { allowAdult: false, allowUnknown: false, query: 'Cowboy Bebop' }, limit: 20, page: 1, translationType: 'sub', countryOrigin: 'ALL' }), method: 'POST', headers: commonHeaders })
    .reply(200, { data: { shows: { edges: [{ _id: 'cowboy-bebop', name: 'Cowboy Bebop', englishName: 'Cowboy Bebop' }] } } });
  api.intercept({ path: graphqlPath(episodesQuery, { showId: 'cowboy-bebop' }), method: 'POST', headers: commonHeaders })
    .reply(200, { data: { show: { _id: 'cowboy-bebop', availableEpisodesDetail: { sub: ['1', '2'], dub: ['1'] } } } });
  api.intercept({ path: graphqlPath(sourcesQuery, { showId: 'cowboy-bebop', episodeString: '1', translationType: 'sub' }), method: 'POST', headers: commonHeaders })
    .reply(200, { data: { episode: { sourceUrls: [{ sourceUrl: `--${Buffer.from('/link').toString('hex')}` }] } } });
  mockAgent.get('https://allanime.day').intercept({ path: '/link', method: 'GET', headers: { referer: 'https://allanime.day/' } })
    .reply(200, { links: [{ link: 'https://media.allanime.day/episode.m3u8', hls: true, resolutionStr: '1080p' }] });
  mockAgent.get('https://media.allanime.day').intercept({ path: '/episode.m3u8', method: 'GET', headers: { referer: 'https://allanime.day/' } })
    .reply(200, '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST\n');

  setGlobalDispatcher(mockAgent);
  try {
    const hits = await allanime.searchByTitle('Cowboy Bebop');
    assert.deepEqual(hits.map(hit => ({ id: hit.id, title: hit.title })), [{ id: 'cowboy-bebop', title: 'Cowboy Bebop' }]);
    const episodes = await allanime.listEpisodes(hits[0].id);
    assert.deepEqual(episodes.map(item => item.num), [1, 2]);
    const sources = await allanime.resolve(episodes[0].id, 'sub');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].type, 'hls');
    assert.equal(sources[0].quality, '1080');
    assert.match(sources[0].url, /^https?:/);
    assert.equal(await verifyPlaylist(sources[0].url, sources[0].headers), true);
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
  }
});

test('AllAnime retries once and surfaces an upstream GraphQL outage', async () => {
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.get('https://api.allanime.day')
    .intercept({ path: graphqlPath(searchQuery, { search: { allowAdult: false, allowUnknown: false, query: 'test' }, limit: 20, page: 1, translationType: 'sub', countryOrigin: 'ALL' }), method: 'POST' })
    .reply(500, 'upstream unavailable');
  mockAgent.get('https://api.allanime.day')
    .intercept({ path: graphqlPath(searchQuery, { search: { allowAdult: false, allowUnknown: false, query: 'test' }, limit: 20, page: 1, translationType: 'sub', countryOrigin: 'ALL' }), method: 'POST' })
    .reply(500, 'upstream unavailable');
  setGlobalDispatcher(mockAgent);
  try {
    await assert.rejects(allanime.searchByTitle('test'), /AllAnime GraphQL returned HTTP 500/);
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
  }
});
