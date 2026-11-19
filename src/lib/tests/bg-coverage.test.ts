import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

test('live coverage endpoint returns partial and complete source-backed counts in one batch', async () => {
  const previousPath = process.env.CATALOG_DB_PATH;
  const directory = mkdtempSync(join(tmpdir(), 'anineko-bg-coverage-'));
  const databasePath = join(directory, 'catalog.db');
  const seed = new Database(databasePath);
  seed.exec(`
    CREATE TABLE episodes(title_id INTEGER NOT NULL, number INTEGER NOT NULL, PRIMARY KEY(title_id,number));
    CREATE TABLE subs(title_id INTEGER NOT NULL, number INTEGER NOT NULL, path TEXT, status TEXT, PRIMARY KEY(title_id,number));
    CREATE TABLE subtitle_artifacts(anime_id INTEGER NOT NULL, episode_id TEXT NOT NULL, target_language TEXT NOT NULL, validation_status TEXT NOT NULL);
    INSERT INTO episodes VALUES (21,1),(21,2),(21,3),(22,1);
    INSERT INTO subs VALUES (21,1,'/subs/21-1.vtt','final');
    INSERT INTO subtitle_artifacts VALUES (21,'2','bg','validated'),(21,'3','bg','rejected');
  `);
  seed.close();
  process.env.CATALOG_DB_PATH = databasePath;

  try {
    const { GET } = await import('../../pages/api/subtitles/coverage');
    const response = GET({ request: new Request('https://anineko.test/api/subtitles/coverage?ids=21,22,21') });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      coverage: {
        21: { total: 3, available: 2, complete: false },
        22: { total: 1, available: 0, complete: false },
      },
      episodes: { 21: [1, 2], 22: [] },
    });
  } finally {
    if (previousPath === undefined) delete process.env.CATALOG_DB_PATH;
    else process.env.CATALOG_DB_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('live coverage endpoint rejects unbounded and malformed ID lists', async () => {
  const { GET } = await import('../../pages/api/subtitles/coverage');
  for (const ids of ['', '1,not-an-id', Array.from({ length: 201 }, (_, index) => index + 1).join(',')]) {
    const response = GET({ request: new Request(`https://anineko.test/api/subtitles/coverage?ids=${encodeURIComponent(ids)}`) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid-anime-ids' });
  }
});
