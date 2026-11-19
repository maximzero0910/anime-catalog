import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ordered, translationProviders, translateThroughProviders, translateWithProvider, type Provider } from '../providers';
import { formatTime, parseSubtitle } from '../normalize';

const fixture = await readFile('tests/fixtures/sample-en.srt', 'utf8');
const expected = parseSubtitle(fixture, 'srt');
const liveProviders = ['translate-subtitles-com', 'translatesubtitles-co', 'syedgakbar', 'editsub'];

test('translation registry contains only the four completed online providers', () => {
  assert.deepEqual([...translationProviders.keys()].sort(), [...liveProviders].sort());
  assert.ok(ordered().length > 0);
  assert.ok(ordered().every(provider => liveProviders.includes(provider.id)));
});

for (const id of liveProviders) {
  test(`live ${id} translation preserves cue parity and returns Bulgarian`, async () => {
    const provider = ordered().find(candidate => candidate.id === id);
    assert.ok(provider, `provider ${id} is registered`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const translated = await translateWithProvider(provider as Provider, fixture, 'en', 'bg', controller.signal);
      assert.match(translated.srt, /^\uFEFF?\s*1\s*\n/);
      const output = parseSubtitle(translated.srt, 'srt');
      assert.equal(output.cues.length, expected.cues.length);
      assert.deepEqual(output.cues.map(cue => [cue.start, cue.end]), expected.cues.map(cue => [cue.start, cue.end]));
      const text = output.cues.map(cue => cue.originalText).join(' ');
      assert.match(text, /\p{Script=Cyrillic}/u);
      assert.ok(!/^\s*WEBVTT/m.test(translated.srt));
    } finally {
      clearTimeout(timer);
    }
  });
}

test('VTT input is uploaded as SRT and returned with a WEBVTT header and unchanged times', async () => {
  const provider = ordered().find(candidate => candidate.id === 'translatesubtitles-co');
  assert.ok(provider);
  const vtt = `WEBVTT\n\n${expected.cues.map(cue => `${cue.id}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.originalText}`).join('\n\n')}\n`;
  const source = parseSubtitle(vtt, 'vtt');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const translated = await translateWithProvider(provider, vtt, 'en', 'bg', controller.signal);
    assert.match(translated.srt, /^WEBVTT\n/);
    const output = parseSubtitle(translated.srt, 'vtt');
    assert.equal(output.cues.length, source.cues.length);
    assert.deepEqual(output.cues.map(cue => [cue.start, cue.end]), source.cues.map(cue => [cue.start, cue.end]));
  } finally {
    clearTimeout(timer);
  }
});

test('an injected mid-run outage skips the first site and translates through the next live provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get('referer') === 'https://www.syedgakbar.com/') throw new Error('injected provider outage');
    return originalFetch(input, init);
  };
  try {
    const result = await translateThroughProviders({ srt: fixture, sourceLang: 'en', targetLang: 'bg' }, { totalBudgetMs: 60_000 });
    assert.equal(result.providerId, 'translatesubtitles-co');
    const output = parseSubtitle(result.srt, 'srt');
    assert.equal(output.cues.length, expected.cues.length);
    assert.deepEqual(output.cues.map(cue => [cue.start, cue.end]), expected.cues.map(cue => [cue.start, cue.end]));
    assert.match(output.cues.map(cue => cue.originalText).join(' '), /\p{Script=Cyrillic}/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
