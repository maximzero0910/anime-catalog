import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

async function claimInProcess(databasePath: string, mode: 'translation' | 'index'): Promise<number[]> {
  const moduleUrl = pathToFileURL(resolve('src/lib/subtitles/storage.ts')).href;
  const operation = mode === 'translation' ? `storage.claimJobs(1).map(job => job.id)` : `storage.claimSubtitleIndexJobs(1).map(job => job.id)`;
  const script = `const storage=await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(${operation})); storage.closeSubtitleStorage();`;
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, CATALOG_DB_PATH: databasePath, SUBTITLE_DATA_DIR: `${databasePath}.assets` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`claim subprocess failed (${code}): ${stderr}`));
      try { resolveResult(JSON.parse(stdout) as number[]); }
      catch (error) { reject(new Error(`claim subprocess returned invalid JSON: ${stdout}; ${String(error)}`)); }
    });
  });
}

test('concurrent processes claim each translation and index job at most once', async () => {
  const directory = await mkdtemp(`${tmpdir()}/subtitle-claim-concurrency-`);
  const databasePath = `${directory}/catalog.db`;
  process.env.CATALOG_DB_PATH = databasePath;
  process.env.SUBTITLE_DATA_DIR = `${databasePath}.assets`;
  const seed = new Database(databasePath);
  seed.pragma('journal_mode = WAL');
  seed.exec(`CREATE TABLE titles(id INTEGER PRIMARY KEY,romaji TEXT,english TEXT);
    CREATE TABLE episodes(title_id INTEGER NOT NULL,number INTEGER NOT NULL,PRIMARY KEY(title_id,number));
    CREATE TABLE subs(title_id INTEGER NOT NULL,number INTEGER NOT NULL,path TEXT,source TEXT,status TEXT DEFAULT 'draft',translator TEXT,PRIMARY KEY(title_id,number));
    INSERT INTO titles VALUES(1,'Series','Series');
    INSERT INTO episodes VALUES(1,1),(1,2),(1,3),(1,4),(1,5),(1,6);`);
  seed.close();

  const storage = await import('../storage');
  const translationIds: number[] = [];
  for (let episode = 1; episode <= 6; episode++) {
    const job = storage.enqueueJob(1, episode);
    storage.updateJob(job.id, 'QUEUED', { sourceLanguage: 'en' });
    translationIds.push(job.id);
    storage.enqueueSubtitleIndexJob({ animeId: '1', episode });
  }
  storage.closeSubtitleStorage();

  try {
    const [translationClaims, indexClaims] = await Promise.all([
      Promise.all(Array.from({ length: 8 }, () => claimInProcess(databasePath, 'translation'))),
      Promise.all(Array.from({ length: 8 }, () => claimInProcess(databasePath, 'index'))),
    ]);
    const claimedTranslations = translationClaims.flat();
    const claimedIndex = indexClaims.flat();
    assert.equal(claimedTranslations.length, 6);
    assert.equal(new Set(claimedTranslations).size, 6);
    assert.deepEqual([...claimedTranslations].sort((a, b) => a - b), [...translationIds].sort((a, b) => a - b));
    assert.equal(claimedIndex.length, 6);
    assert.equal(new Set(claimedIndex).size, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
