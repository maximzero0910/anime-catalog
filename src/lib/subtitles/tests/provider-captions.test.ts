import assert from 'node:assert/strict';
import test from 'node:test';
import type { StreamSource } from '../../providers/types';
import { candidatesFromProviderSources } from '../sources/provider-captions';

test('registered stream providers expose English, Japanese, and native Bulgarian subtitle tracks to background acquisition', async () => {
  const source: StreamSource = {
    url: 'https://video.example.test/episode.m3u8', quality: 'auto', type: 'hls',
    headers: { referer: 'https://embed.example.test/' }, audio: 'sub', provider: 'anikoto',
    subtitles: [
      { lang: 'English', url: 'https://caption.example.test/en.vtt', format: 'vtt' },
      { lang: 'Japanese (SDH)', url: 'https://caption.example.test/ja.vtt', format: 'vtt' },
      { lang: 'Bulgarian', url: 'https://caption.example.test/bg.srt', format: 'srt' },
      { lang: 'French', url: 'https://caption.example.test/fr.vtt', format: 'vtt' },
      { lang: 'English', url: 'https://caption.example.test/sprite_0.webp', format: 'vtt' },
    ],
  };
  const requests: Array<{ url: string; referer: string; signal: AbortSignal }> = [];
  const candidates = candidatesFromProviderSources('anikoto', 1, [source], async (url, referer, signal) => {
    requests.push({ url, referer, signal });
    return { body: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n', format: 'vtt', language: '' };
  });
  assert.deepEqual(candidates.map(candidate => candidate.language), ['en', 'ja', 'bg']);
  assert.equal(candidates[0]!.sourceId, 'stream-anikoto');
  const downloaded = await candidates[0]!.fetch!();
  assert.equal(downloaded.language, 'en');
  assert.equal(downloaded.format, 'vtt');
  assert.equal(requests[0]!.referer, 'https://embed.example.test/');
  assert.equal(requests[0]!.signal.aborted, false);
});

test('provider-caption discovery ignores insecure, unusable, and non-HLS sources', () => {
  const hls: StreamSource = { url: 'https://video.example.test/episode.m3u8', quality: 'auto', type: 'hls', headers: {}, subtitles: [
    { lang: 'English', url: 'http://caption.example.test/en.vtt', format: 'vtt' },
    { lang: 'English', url: 'https://caption.example.test/sprite_0.webp', format: 'vtt' },
  ], audio: 'sub', provider: '9anime' };
  const mp4: StreamSource = { ...hls, url: 'https://video.example.test/episode.mp4', type: 'mp4', subtitles: [{ lang: 'English', url: 'https://caption.example.test/en.vtt', format: 'vtt' }] };
  assert.deepEqual(candidatesFromProviderSources('9anime', 2, [hls, mp4]), []);
});
