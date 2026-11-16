import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranslationResponse, translateBatch, type SourceLanguage } from '../inference';

test('malformed structured output is rejected without accepting partial cues', () => {
  const expected = [{ id: 'cue-1', text: 'Hello.', speaker: null }, { id: 'cue-2', text: 'Goodbye.', speaker: null }];
  assert.throws(() => parseTranslationResponse('{"translations":[{"id":"cue-1","text":"Здравей."}]}', expected), /expected 2/);
  assert.throws(() => parseTranslationResponse('{bad json', expected), /valid JSON/);
  assert.throws(() => parseTranslationResponse('{"translations":[{"id":"cue-1","text":""},{"id":"cue-1","text":"Чао."}]}', expected), /duplicate cue ID/);
});

test('live installed model covers English and Japanese into Bulgarian', { timeout: 600000 }, async context => {
  const { availableModels, modelCoverage } = await import('../inference');
  let models;
  try { models = await availableModels(true); } catch { context.skip('No compatible local inference server is running'); return; }
  if (!models.length) { context.skip('No local model is installed'); return; }
  const coverage = await modelCoverage(true);
  assert.ok(coverage.models.find(model => model.name === coverage.activeModel)?.languages?.en);
  assert.ok(coverage.models.find(model => model.name === coverage.activeModel)?.languages?.ja);
  for (const [language, cue] of [
    ['en', { id: 'en-1', text: 'We have to leave now.', speaker: 'Mira' }],
    ['ja', { id: 'ja-1', text: 'おはよう、みんな。', speaker: 'ミラ' }],
  ] as Array<[SourceLanguage, { id: string; text: string; speaker: string }]>) {
    const translated = await translateBatch(language, [cue], [], []);
    const text = translated.translations[0]!.text;
    assert.match(text, /[А-Яа-яЁё]/u);
    console.log(`LIVE ${language}->bg (${translated.model}): ${cue.text} => ${text}`);
  }
});
