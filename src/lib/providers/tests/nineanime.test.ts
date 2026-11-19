import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSubtitleTracks, relevantSearchHits } from '../nineanime';

test('9Anime MegaPlay track metadata is retained with usable URLs and formats', () => {
  const tracks = extractSubtitleTracks([
    { file: '/captions/en.vtt?sig=abc', label: 'English' },
    { file: 'https://captions.example.test/bg.srt', lang: 'Bulgarian' },
    { file: 'javascript:alert(1)', label: 'Unsafe' },
    { label: 'Missing file' },
  ], 'https://megaplay.buzz/embed/episode');
  assert.deepEqual(tracks, [
    { lang: 'English', url: 'https://megaplay.buzz/captions/en.vtt?sig=abc', format: 'vtt' },
    { lang: 'Bulgarian', url: 'https://captions.example.test/bg.srt', format: 'srt' },
  ]);
});

test('9Anime search drops unrelated cards returned alongside the matching result', () => {
  const hits = [
    { id: 'right', title: 'Tokyo Revengers: War of the Three Titan Arc' },
    { id: 'wrong', title: 'Bleach: Thousand-Year Blood War' },
  ];
  assert.deepEqual(relevantSearchHits(hits, 'Tokyo Revengers'), [hits[0]]);
});

test('9Anime search preserves repeated franchise words when matching', () => {
  const hits = [
    { id: 'right', title: 'Hunter x Hunter (2011)' },
    { id: 'wrong', title: 'Fantasy x Hunter' },
  ];
  assert.deepEqual(relevantSearchHits(hits, 'Hunter x Hunter'), [hits[0]]);
});

test('9Anime single-letter search keeps only titles beginning with that letter', () => {
  const hits = [
    { id: 'right', title: 'Horror Collector' },
    { id: 'wrong', title: 'Chitose Is in the Ramune Bottle' },
  ];
  assert.deepEqual(relevantSearchHits(hits, 'h'), [hits[0]]);
});

test('9Anime search returns no unrelated trending cards when nothing matches', () => {
  const hits = [{ id: 'wrong', title: 'Horror Collector' }];
  assert.deepEqual(relevantSearchHits(hits, 'Tokyo Revengers'), []);
});
