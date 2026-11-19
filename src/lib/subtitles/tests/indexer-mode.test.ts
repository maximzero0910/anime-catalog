import assert from 'node:assert/strict';
import test from 'node:test';
import { subtitleIndexerMode } from '../indexer-mode';

test('subtitle indexer preserves explicit catalog crawling as the default', () => {
  assert.equal(subtitleIndexerMode([]), 'catalog');
  assert.equal(subtitleIndexerMode(['--watch']), 'catalog');
});

test('persistent indexer mode drains queued work without enumerating the full catalog', () => {
  assert.equal(subtitleIndexerMode(['--watch', '--queued-only']), 'queued-only');
});
