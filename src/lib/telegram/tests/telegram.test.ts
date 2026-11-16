import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTelegramEpisode, parseTelegramMedia, scoreTelegramTitle } from '../matching';
import { parseTelegramByteRange } from '../range';
import { getTitles } from '../../db';
import { getProvider, ordered } from '../../providers';

test('episode markers preserve season and number from irregular filenames', () => {
  assert.deepEqual(parseTelegramEpisode('[Fansub] Cowboy Bebop S01E03 1080p.mkv'), { season: 1, episode: 3, explicit: true, titleText: 'Cowboy Bebop' });
  assert.deepEqual(parseTelegramEpisode('Каубой Бибоп - еп. 12.mp4'), { season: null, episode: 12, explicit: true, titleText: 'Каубой Бибоп' });
  assert.equal(parseTelegramEpisode('[AnimaBG] Sousou No Frieren - 01-04 Bg.mp4 Фрирен Еп. 1-4'), null);
  assert.deepEqual(parseTelegramEpisode('Frieren S02 Ep. 2'), { season: 2, episode: 2, explicit: true, titleText: 'Frieren' });
  assert.deepEqual(parseTelegramEpisode('Фрирен С02 Еп. 2'), { season: 2, episode: 2, explicit: true, titleText: 'Фрирен' });
  assert.equal(parseTelegramEpisode('a random video without a number'), null);
});

test('matching accepts exact and alternative catalog titles and keeps weak candidates low confidence', () => {
  assert.equal(scoreTelegramTitle(['Cowboy Bebop', 'カウボーイビバップ'], 'Cowboy Bebop').score, 0.94);
  assert.equal(scoreTelegramTitle(['Cowboy Bebop', 'カウボーイビバップ'], 'カウボーイビバップ episode 2').matched, 'カウボーイビバップ');
  assert.ok(scoreTelegramTitle(['Cowboy Bebop'], 'Cowboy unrelated').score < 0.92);
  assert.ok(scoreTelegramTitle(['Non Non Biyori'], 'Non Non Biyori Repeat').score < scoreTelegramTitle(['Non Non Biyori Repeat'], 'Non Non Biyori Repeat').score);
});

test('uploaded Telegram filenames identify season episodes, suffixes, Bulgarian captions, and packs safely', () => {
  assert.deepEqual(parseTelegramMedia('Non Non Biyori (S01)E01 [bgsubs].mkv', 'Non Non Biyori S01E01'), {
    episode: 1, season: 1, explicit: true, titleNames: ['Non Non Biyori'], compilation: false,
  });
  assert.deepEqual(parseTelegramMedia('Komi-San Wa, Comyushou Desu.S0201bg.mp4', '', 1432), {
    episode: 1, season: 2, explicit: true, titleNames: ['Komi-San Wa, Comyushou Desu'], compilation: false,
  });
  assert.deepEqual(parseTelegramMedia('Tondemo Skill De Isekai Hourou Meshi 2 - 01bg.mp4', '', 1420), {
    episode: 1, season: 2, explicit: true, titleNames: ['Tondemo Skill De Isekai Hourou Meshi'], compilation: false,
  });
  assert.deepEqual(parseTelegramMedia('[AnimaBG] Hataraku Saibous01e01bg.mp4', '', 1420), {
    episode: 1, season: 1, explicit: true, titleNames: ['Hataraku Saibou'], compilation: false,
  });
  assert.equal(parseTelegramMedia('[AnimaBG] Ikoku Nikki - 03bg.mp4', 'Икоку Никки Еп. 3', 1420).episode, 3);
  assert.equal(parseTelegramMedia('Tamayura Ova - 03-04bg.mp4', '', 2800).episode, null);
  assert.equal(parseTelegramMedia('A Film.mp4', 'Аниме Филмът', 6000).episode, 1);
  const pack = parseTelegramMedia('[AnimaBG] Sousou No Frieren - 01-04 Bg.mp4', 'Фрирен Еп. 1-4', 5615);
  assert.equal(pack.compilation, true);
  assert.equal(pack.episode, null);
});

test('a real catalog title matches through its existing metadata and Telegram stays registered alongside current providers', () => {
  const catalog = getTitles();
  assert.ok(catalog.length > 0);
  const title = catalog.find(item => item.english || item.romaji)!;
  const display = title.english ?? title.romaji!;
  const names = [title.english, title.romaji, title.native, title.title_bg].filter((name): name is string => Boolean(name));
  assert.equal(scoreTelegramTitle(names, display).score, 0.94);
  assert.ok(getProvider('telegram'));
  const providers = new Set(ordered().map(provider => provider.id));
  for (const id of ['9anime', 'reanime', 'allanime', 'anikoto', 'telegram']) assert.ok(providers.has(id), `provider ${id} remains registered`);
});

test('byte range parser supports explicit, open-ended, and suffix ranges and rejects invalid requests', () => {
  assert.deepEqual(parseTelegramByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseTelegramByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseTelegramByteRange('bytes=-8', 100), { start: 92, end: 99 });
  assert.deepEqual(parseTelegramByteRange('bytes=95-200', 100), { start: 95, end: 99 });
  assert.equal(parseTelegramByteRange('bytes=100-', 100), 'invalid');
  assert.equal(parseTelegramByteRange('bytes=0-1,4-5', 100), 'invalid');
  assert.equal(parseTelegramByteRange(null, 100), null);
});
