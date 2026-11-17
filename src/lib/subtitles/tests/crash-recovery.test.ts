import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import test from 'node:test';

test('a killed worker leaves durable translation and index claims that a restarted worker recovers once', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(`${tmpdir()}/subtitle-crash-recovery-`);
  const databasePath = resolve(directory, 'catalog.db');
  const assetDirectory = `${databasePath}.assets`;
  const seed = new Database(databasePath);
  seed.pragma('journal_mode = WAL');
  seed.exec(`CREATE TABLE titles(id INTEGER PRIMARY KEY,romaji TEXT,english TEXT);
    CREATE TABLE episodes(title_id INTEGER NOT NULL,number INTEGER NOT NULL,PRIMARY KEY(title_id,number));
    CREATE TABLE subs(title_id INTEGER NOT NULL,number INTEGER NOT NULL,path TEXT,source TEXT,status TEXT DEFAULT 'draft',translator TEXT,PRIMARY KEY(title_id,number));
    INSERT INTO titles VALUES(1,'Crash recovery test','Crash recovery test');
    INSERT INTO episodes VALUES(1,1);`);
  seed.close();

  const moduleUrl = pathToFileURL(resolve('src/lib/subtitles/storage.ts')).href;
  const script = `const s=await import(${JSON.stringify(moduleUrl)});const j=s.enqueueJob(1,1);s.updateJob(j.id,'QUEUED',{sourceLanguage:'en'});const c=s.claimJobs(1)[0];s.enqueueSubtitleIndexJob({animeId:'1',episode:1});const i=s.claimSubtitleIndexJobs(1)[0];if(!c||!i)throw new Error('claim missing');process.stdout.write(JSON.stringify({translation:{id:c.id,status:c.status,attempts:c.attempts,lockedAt:c.locked_at},index:{id:i.id,state:i.state,attempts:i.attempts,lockedAt:i.locked_at}})+'\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, CATALOG_DB_PATH: databasePath, SUBTITLE_DATA_DIR: assetDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let childError = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { childError += chunk; });

  try {
    const deadline = Date.now() + 10_000;
    while (!output.includes('\n') && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    assert.ok(output.includes('\n'), `worker did not persist its claim: ${childError}`);
    const claim = JSON.parse(output.slice(0, output.indexOf('\n'))) as {
      translation: { id: number; status: string; attempts: number; lockedAt: number };
      index: { id: number; state: string; attempts: number; lockedAt: number };
    };
    assert.equal(claim.translation.status, 'DOWNLOADING');
    assert.equal(claim.translation.attempts, 1);
    assert.equal(claim.index.state, 'RUNNING');
    assert.equal(claim.index.attempts, 1);

    const closed = once(child, 'close');
    assert.equal(child.kill('SIGKILL'), true);
    const [exitCode, signal] = await closed as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, null);
    assert.equal(signal, 'SIGKILL');

    const stale = new Database(databasePath);
    stale.prepare('UPDATE subtitle_jobs SET locked_at=? WHERE id=?').run(Date.now() - 60_001, claim.translation.id);
    stale.prepare('UPDATE subtitle_index_jobs SET locked_at=? WHERE id=?').run(Date.now() - 60_001, claim.index.id);
    stale.close();

    process.env.CATALOG_DB_PATH = databasePath;
    process.env.SUBTITLE_DATA_DIR = assetDirectory;
    const storage = await import('../storage');
    try {
      assert.equal(storage.recoverStaleJobs(60_000), 1);
      assert.equal(storage.recoverStaleSubtitleIndexJobs(60_000), 1);
      const recovered = storage.getJob(claim.translation.id)!;
      assert.equal(recovered.status, 'QUEUED');
      assert.equal(recovered.attempts, 1);
      assert.match(recovered.error ?? '', /Recovered after stale worker lock/);

      const retry = storage.claimJobs(1);
      assert.equal(retry.length, 1);
      assert.equal(retry[0]?.id, claim.translation.id);
      assert.equal(retry[0]?.attempts, 2);
      assert.equal(storage.recoverStaleJobs(60_000), 0);
      const indexRetry = storage.claimSubtitleIndexJobs(1);
      assert.equal(indexRetry.length, 1);
      assert.equal(indexRetry[0]?.id, claim.index.id);
      assert.equal(indexRetry[0]?.attempts, 2);
      assert.equal(storage.recoverStaleSubtitleIndexJobs(60_000), 0);
      const check = new Database(databasePath, { readonly: true });
      assert.equal((check.prepare('SELECT COUNT(*) AS count FROM subtitle_jobs WHERE anime_id=? AND episode_id=?').get(1, '1') as { count: number }).count, 1);
      assert.equal((check.prepare('SELECT COUNT(*) AS count FROM subtitle_index_jobs WHERE anime_id=? AND episode_number=?').get('1', 1) as { count: number }).count, 1);
      check.close();
    } finally {
      storage.closeSubtitleStorage();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
