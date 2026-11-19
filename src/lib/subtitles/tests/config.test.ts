import assert from 'node:assert/strict';
import test from 'node:test';
import { completedTranslationProviders, resolveSubtitleProviderOrder } from '../config';

test('stale local and failed-site settings cannot enter the active translation chain', () => {
  assert.deepEqual(resolveSubtitleProviderOrder('translate-subtitles-com,local,subtitlestranslator,editsub'), ['translate-subtitles-com', 'editsub']);
  assert.deepEqual(resolveSubtitleProviderOrder('local'), [...completedTranslationProviders]);
  assert.deepEqual(resolveSubtitleProviderOrder(''), [...completedTranslationProviders]);
});
