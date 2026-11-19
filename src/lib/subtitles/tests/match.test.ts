import assert from 'node:assert/strict';
import test from 'node:test';
import { matchAtLeast85, normalize, scoreTitleMatch } from '../match';
import { episodeUrl, subtitleSources, type Candidate } from '../sources';
import { resolveProviderEpisode } from '../../providers/title-resolver';
import type { Provider } from '../../providers/types';

test('normalizes diacritics, punctuation, and Cyrillic romanization', () => {
  assert.equal(normalize('Tokyo: Revengers!').split('|')[0], 'tokyo revengers');
  assert.ok(normalize('Токийски отмъстители').includes('tokiyski otmastiteli'));
});

test('source alias makes a Bulgarian PlayTube title an exact match for the AniList title', () => {
  const titles = { romaji: 'Tokyo Revengers: Seiya Kessen-hen', english: 'Tokyo Revengers Season 2', native: '東京リベンジャーズ 聖夜決戦編', synonyms: [] };
  const alias = 'Токийски отмъстители';
  assert.equal(scoreTitleMatch(titles, alias, [alias]), 100);
  assert.equal(matchAtLeast85(titles, alias, [alias]), true);
  assert.equal(matchAtLeast85(titles, 'Unrelated anime', [alias]), false);
});

test('subtitle-source adapters are separately registered and episode URLs require an episode match', () => {
  assert.deepEqual(Object.keys(subtitleSources).sort(), ['anima-pr', 'playtube', 'provider-captions', 'subsunacs']);
  const candidate: Candidate = { sourceId: 'playtube', title: 'Title', episode: 2, url: 'https://playtube.tv/watch/ep-2', kind: 'hardsub', attribution: 'PlayTube' };
  assert.equal(episodeUrl(candidate, 2), candidate.url);
  assert.equal(episodeUrl(candidate, 1), null);
});

test('stream resolver searches a source alias and passes the provider slug to episode lookup', async () => {
  let listedSlug = '';
  const provider: Provider = {
    id: 'anikoto', weight: 1, score: 1,
    async searchByTitle(query) { return query === 'Tokyo Revengers: Christmas Showdown' ? [{ id: 'tokyo-revengers-christmas-showdown-7g6kf', title: query }] : []; },
    async listEpisodes(slug) { listedSlug = slug; return [{ num: 1, id: `${slug}$episode$1` }]; },
    async resolve() { return []; }, async health() { return true; },
  };
  const alias = 'Tokyo Revengers: Christmas Showdown';
  const result = await resolveProviderEpisode(provider, [alias], { romaji: 'Tokyo Revengers: Seiya Kessen-hen', english: 'Tokyo Revengers Season 2', native: '東京リベンジャーズ 聖夜決戦編', synonyms: [] }, [alias], 1);
  assert.equal(result.hit.id, 'tokyo-revengers-christmas-showdown-7g6kf');
  assert.equal(listedSlug, 'tokyo-revengers-christmas-showdown-7g6kf');
  assert.equal(result.episode.id, 'tokyo-revengers-christmas-showdown-7g6kf$episode$1');
});
