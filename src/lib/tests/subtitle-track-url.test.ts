import test from 'node:test';
import assert from 'node:assert/strict';
import { isUsableSubtitleTrackUrl } from '../subtitle-track-url';

test('accepts only same-origin HLS capability URLs as relative subtitle tracks', () => {
  assert.equal(isUsableSubtitleTrackUrl('/api/hls?t=opaque-capability'), true);
  assert.equal(isUsableSubtitleTrackUrl('/api/hls?u=https%3A%2F%2Fexample.test%2Fa.vtt'), false);
  assert.equal(isUsableSubtitleTrackUrl('/api/hls?t=x&u=https%3A%2F%2Fexample.test%2Fa.vtt'), false);
  assert.equal(isUsableSubtitleTrackUrl('/api/other?t=opaque-capability'), false);
  assert.equal(isUsableSubtitleTrackUrl('//evil.example/a.vtt'), false);
});

test('retains valid remote subtitle URLs and rejects image preview tracks', () => {
  assert.equal(isUsableSubtitleTrackUrl('https://cdn.example.test/captions/en.vtt?sig=1'), true);
  assert.equal(isUsableSubtitleTrackUrl('https://cdn.example.test/sprite_0.webp'), false);
  assert.equal(isUsableSubtitleTrackUrl('https://cdn.example.test/thumbnails/frame.vtt'), false);
});
