import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizedSubtitleLanguage, searchAllSubtitleProviders, subtitleDiscoveryNeedsRetry, type SubtitleProviderCandidate, type SubtitleSearchProvider } from '../provider-fallback';

interface Candidate extends SubtitleProviderCandidate { provider: string; providerId: string; episode: number; language: string; url: string; kind: string; }
const candidate = (provider: string, patch: Partial<Candidate> = {}): Candidate => ({ provider, providerId: `${provider}-file`, episode: 1, language: 'en', url: `https://${provider}.test/episode.srt`, kind: 'file', ...patch });
const provider = (id: string, search: () => Promise<Candidate[]>, isEnabled = true): SubtitleSearchProvider<Candidate> => ({ id, search, isEnabled: () => isEnabled });

test('an empty primary provider does not stop the secondary provider', async () => {
  const result = await searchAllSubtitleProviders([provider('primary', async () => []), provider('secondary', async () => [candidate('secondary')])]);
  assert.deepEqual(result.checkedProviders, ['primary', 'secondary']);
  assert.equal(result.primaryEmpty, true);
  assert.equal(result.state, 'available');
  assert.equal(result.candidates[0]?.provider, 'secondary');
});

test('a timed out primary provider is isolated and the secondary provider can succeed', async () => {
  const result = await searchAllSubtitleProviders([
    provider('primary', async () => { throw new Error('provider request timeout'); }),
    provider('secondary', async () => [candidate('secondary')]),
  ]);
  assert.equal(result.state, 'temporary-failure');
  assert.deepEqual(result.errors.map(item => item.provider), ['primary']);
  assert.equal(result.candidates.length, 1);
  assert.equal(subtitleDiscoveryNeedsRetry(result), true, 'a partial result remains eligible for a later retry');
});

test('duplicate files are aggregated once but preserve the lower-priority provider as a fetch fallback', async () => {
  const first = candidate('primary', { fileHash: 'ABCD', releaseGroup: 'Group', filename: 'series-01.srt' });
  const duplicate = candidate('secondary', { fileHash: 'abcd', releaseGroup: 'Group', filename: 'series-01.srt' });
  const result = await searchAllSubtitleProviders([provider('primary', async () => [first]), provider('secondary', async () => [duplicate])]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.provider, 'primary');
  assert.equal(result.candidates[0]?.providerAlternates?.[0]?.provider, 'secondary');
  assert.deepEqual(result.emptyProviders, []);
});

test('English and Japanese are normalized and discovered independently', async () => {
  const result = await searchAllSubtitleProviders([
    provider('english-provider', async () => [candidate('english-provider', { language: 'eng_Latn' })]),
    provider('japanese-provider', async () => []),
  ]);
  assert.equal(normalizedSubtitleLanguage(result.candidates[0]!.language), 'en');
  assert.deepEqual(result.emptyProviders, ['japanese-provider']);
  assert.equal(result.candidates.length, 1, 'an absent Japanese track does not suppress the English source');
});

test('all enabled providers returning no results is an exhausted search, not an incomplete failure', async () => {
  const result = await searchAllSubtitleProviders([provider('primary', async () => []), provider('secondary', async () => [])]);
  assert.equal(result.state, 'exhausted');
  assert.equal(result.exhaustedAllProviders, true);
  assert.equal(result.emptyProviders.length, 2);
  assert.equal(subtitleDiscoveryNeedsRetry(result), false);
});

test('a provider failure does not prevent healthy providers from being queried', async () => {
  let healthyCalls = 0;
  const result = await searchAllSubtitleProviders([
    provider('offline', async () => { throw new Error('503 upstream unavailable'); }),
    provider('healthy', async () => { healthyCalls++; return []; }),
  ]);
  assert.equal(healthyCalls, 1);
  assert.deepEqual(result.errors.map(item => item.provider), ['offline']);
  assert.equal(result.state, 'temporary-failure');
  assert.equal(subtitleDiscoveryNeedsRetry(result), true);
});

test('rediscovery can make a previously empty episode available without a permanent negative cache', async () => {
  let available = false;
  const source = provider('recovering', async () => available ? [candidate('recovering')] : []);
  const initial = await searchAllSubtitleProviders([source]);
  assert.equal(initial.state, 'exhausted');
  available = true;
  const retry = await searchAllSubtitleProviders([source]);
  assert.equal(retry.state, 'available');
  assert.equal(retry.candidates.length, 1);
});

test('disabled providers are reported as not searched rather than as definitive misses', async () => {
  let calls = 0;
  const result = await searchAllSubtitleProviders([provider('disabled', async () => { calls++; return []; }, false)]);
  assert.equal(calls, 0);
  assert.equal(result.state, 'not-searched');
  assert.equal(result.exhaustedAllProviders, false);
});
