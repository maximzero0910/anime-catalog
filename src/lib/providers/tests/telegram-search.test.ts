import test from 'node:test';
import assert from 'node:assert/strict';
import telegram from '../telegram';

test('Telegram search ignores ambiguous one-character queries', async () => {
  assert.deepEqual(await telegram.searchByTitle('h'), []);
});

test('Telegram search returns the catalog poster with each playable title card', async () => {
  const results = await telegram.searchByTitle('Witch Hat Atelier');
  const hit = results.find(result => result.id === '147105');
  assert.ok(hit);
  assert.match(hit.image ?? '', /^https:\/\//);
});
