import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root = '';
let storage: typeof import('../storage');
let subtitleIndex: typeof import('../index');
let providers: typeof import('../index-providers');
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'subtitle-index-'));
  process.env.CATALOG_DB_PATH = join(root, 'catalog.db');
  process.env.SUBTITLE_DATA_DIR = join(root, 'assets');
  storage = await import('../storage');
  subtitleIndex = await import('../index');
  providers = await import('../index-providers');
});
after(async () => { storage.closeSubtitleStorage(); await rm(root, { recursive: true, force: true }); });

function zipWithSingleSrt(text: string): Uint8Array {
  const name = Buffer.from('episode-01.srt');
  const body = Buffer.from(text);
  const compressed = deflateRawSync(body);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  name.copy(local, 30); compressed.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, central, end]));
}

test('subtitle ZIP parsing preserves valid entries and rejects decompression bombs', () => {
  const normal = zipWithSingleSrt('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  const entries = providers.zipSubtitleEntries(normal);
  assert.equal(entries.length, 1);
  assert.match(Buffer.from(entries[0]!.bytes).toString('utf8'), /Hello/);

  const bomb = zipWithSingleSrt('x'.repeat(8 * 1024 * 1024 + 1));
  assert.throws(() => providers.zipSubtitleEntries(bomb), /decompressed-size limit/);
});

test('hash outranks release group, release group outranks duration, and drift beyond two seconds is rejected', () => {
  const request = { fileHash: 'abc', releaseGroup: 'Fansub', durationMs: 1_440_000 };
  const hash = subtitleIndex.subtitleMatchScore({ fileHash: 'ABC', releaseGroup: null, durationMs: null, catalogOnly: false }, request, 1_440_000);
  const group = subtitleIndex.subtitleMatchScore({ fileHash: null, releaseGroup: 'fansub', durationMs: null, catalogOnly: false }, request, 1_440_000);
  const duration = subtitleIndex.subtitleMatchScore({ fileHash: null, releaseGroup: null, durationMs: 1_440_500, catalogOnly: false }, request, 1_440_000);
  const drift = subtitleIndex.subtitleMatchScore({ fileHash: null, releaseGroup: 'Fansub', durationMs: null, catalogOnly: false }, request, 1_442_001);
  assert.equal(hash.score, 1);
  assert.equal(group.score, 0.85);
  assert.equal(duration.score, 0.7);
  assert.equal(drift.score, 0);
});

test('OpenSubtitles season search caches one request and exposes every episode from the batch', async () => {
  let calls = 0;
  const requester = async (url: string) => {
    calls++;
    assert.match(url, /season_number=1/);
    return { status: 200, headers: new Headers(), finalUrl: url, text: JSON.stringify({ data: [1, 2].map(episode => ({ attributes: { language: 'bg', release: 'Group', feature_details: { season_number: 1, episode_number: episode }, files: [{ file_id: 900 + episode, file_name: `series.s01e0${episode}.srt` }] } })) }) };
  };
  const provider = new providers.OpenSubtitlesProvider(requester as never, 'test-key', 'Anineko test');
  const context = { animeId: 'os-season-test', title: 'Series', imdbId: 'tt12345', season: 1, episode: 1 };
  assert.equal((await provider.search(context, 1, 1))[0]?.episodeNumber, 1);
  assert.equal((await provider.search({ ...context, episode: 2 }, 1, 2))[0]?.episodeNumber, 2);
  assert.equal(calls, 1);
});

test('an unconfigured OpenSubtitles adapter is skipped rather than negative-cached', () => {
  const missingKey = new providers.OpenSubtitlesProvider(async () => { throw new Error('must not make a request'); }, '', 'Anineko test');
  const configured = new providers.OpenSubtitlesProvider(async () => { throw new Error('not called'); }, 'test-key', 'Anineko test');
  assert.equal(missingKey.isEnabled(), false);
  assert.equal(configured.isEnabled(), true);
});

test('failed OpenSubtitles season batches are evicted so the same lookup can recover', async () => {
  let calls = 0;
  const requester = async (url: string) => {
    calls++;
    if (calls === 1) throw new Error('temporary network interruption');
    return { status: 200, headers: new Headers(), finalUrl: url, text: JSON.stringify({ data: [] }) };
  };
  const provider = new providers.OpenSubtitlesProvider(requester as never, 'test-key', 'Anineko test');
  const context = { animeId: 'os-retry-test', title: 'Recovery Series', imdbId: null, season: 1, episode: 1 };
  await assert.rejects(provider.search(context, 1, 1), /temporary network interruption/);
  assert.deepEqual(await provider.search(context, 1, 1), []);
  assert.equal(calls, 2);
});

test('subtitle-file adapters reject URLs outside their exact provider host policy', async () => {
  const provider = new providers.SubsunacsProvider();
  await assert.rejects(() => provider.fetch({
    animeId: '21', episodeNumber: 1, language: 'bg', provider: 'subsunacs', providerId: 'untrusted',
    qualityScore: 0, sourceUrl: 'https://127.0.0.1/private.srt', providerRef: {},
  }), /host-not-allowed/);
  await assert.rejects(() => provider.fetch({
    animeId: '21', episodeNumber: 1, language: 'bg', provider: 'subsunacs', providerId: 'untrusted-redirect',
    qualityScore: 0, sourceUrl: 'https://evil.example.test/private.srt', providerRef: {},
  }), /host-not-allowed/);
});

test('a resolved index hit uses the stored asset and catalog-only rows never become playable', async () => {
  const body = '1\n00:00:01,000 --> 00:00:02,000\nЗдравей\n';
  const asset = await storage.storeSubtitleAsset(body, 'srt', 'bg', { provider: 'index-test', providerId: 'real-file', attribution: 'Indexed source' });
  storage.upsertSubtitleIndex({ animeId: '21', episodeNumber: 1, language: 'bg', provider: 'index-test', providerId: 'real-file', qualityScore: 1, verified: true, fetchable: true, assetHash: asset.hash, attribution: 'Indexed source' });
  const result = await subtitleIndex.resolveIndexedBgSubtitle('21', 1, 'Cowboy Bebop');
  assert.equal(result.track?.attribution, 'Indexed source');
  assert.match(result.track?.body ?? '', /^WEBVTT/);
  assert.equal(result.queued, false);

  storage.addSubtitleTitleAliases('catalog:anime', ['Cowboy Bebop']);
  storage.upsertSubtitleIndex({ animeId: 'catalog:anime', episodeNumber: 0, language: 'bg', provider: 'anima-bg-fansubs', providerId: 'post-123', sourceUrl: 'https://anima-pr.blogspot.com/2020/01/cowboy-bebop.html', attribution: 'AniMa BG Fansubs', qualityScore: 0.3, verified: false, catalogOnly: true, fetchable: false });
  const catalog = await subtitleIndex.resolveIndexedBgSubtitle('not-indexed', 3, 'Cowboy Bebop');
  assert.equal(catalog.track, undefined);
  assert.equal(catalog.catalog?.sourceUrl, 'https://anima-pr.blogspot.com/2020/01/cowboy-bebop.html');
  assert.equal(catalog.queued, true);
});

test('a match below the auto-attach threshold is queued for verification and stays hidden', async () => {
  const asset = await storage.storeSubtitleAsset('1\n00:00:01,000 --> 00:00:02,000\nТекст\n', 'srt', 'bg', { provider: 'review-test', providerId: 'review-file' });
  storage.upsertSubtitleIndex({ animeId: 'review-anime', episodeNumber: 1, language: 'bg', provider: 'review-test', providerId: 'review-file', qualityScore: 0.7, verified: true, fetchable: true, assetHash: asset.hash });
  const result = await subtitleIndex.resolveIndexedBgSubtitle('review-anime', 1, 'Review Anime');
  assert.equal(result.track, undefined);
  assert.equal(storage.subtitleIndexStats().verificationQueued, 1);
});

test('a cached provider miss expires after seven days and prevents a duplicate probe', () => {
  storage.recordProviderMiss('21', 4, 'opensubtitles');
  assert.equal(storage.providerMissActive('21', 4, 'opensubtitles'), true);
  assert.equal(storage.providerMissActive('21', 4, 'opensubtitles', Date.now() + 7 * 24 * 60 * 60_000 + 1), false);
});

test('AniMa Blogger crawl stops at the first empty page', async () => {
  let calls = 0;
  const requester = async (url: string) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('start-index'), String(calls === 1 ? 1 : 2));
    const entry = { title: { $t: 'Anime Catalog Entry' }, link: [{ rel: 'alternate', href: 'https://anima-pr.blogspot.com/2020/01/anime.html' }], category: [] };
    return { status: 200, headers: new Headers(), finalUrl: url, text: JSON.stringify({ feed: { entry: calls === 1 ? [entry] : [] } }) };
  };
  assert.equal((await providers.crawlAniMaCatalog(true, requester as never)).length, 1);
  assert.equal(calls, 2);
});
