import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

let root = '';
let databasePath = '';
let storage: typeof import('../storage');
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'anime-subtitles-test-'));
  databasePath = join(root, 'catalog.db');
  process.env.CATALOG_DB_PATH = databasePath;
  process.env.SUBTITLE_DATA_DIR = join(root, 'bodies');
  const base = new Database(databasePath);
  base.exec(`CREATE TABLE titles(id INTEGER PRIMARY KEY,romaji TEXT,english TEXT); CREATE TABLE episodes(title_id INTEGER NOT NULL,number INTEGER NOT NULL,PRIMARY KEY(title_id,number)); CREATE TABLE subs(title_id INTEGER NOT NULL,number INTEGER NOT NULL,path TEXT,source TEXT,status TEXT DEFAULT 'draft',translator TEXT,PRIMARY KEY(title_id,number)); INSERT INTO titles VALUES(21,'Series A','Series A'),(22,'Series B','Series B'); INSERT INTO episodes VALUES(21,1),(21,2),(21,3),(22,1);`);
  base.close();
  storage = await import('../storage');
});
after(async () => { storage.closeSubtitleStorage(); await rm(root, { recursive: true, force: true }); });

test('enqueue is deduplicated and interrupted locks recover after restart', () => {
  const creation = storage.enqueueJobOnce(21, 1);
  const first = creation.job;
  const duplicate = storage.enqueueJobOnce(21, 1);
  assert.equal(creation.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.job.id, first.id);
  storage.updateJob(first.id, 'TRANSLATING', { lockedAt: Date.now() - 3600000, checkpoint: { offset: 24, translated: { cue1: 'Здравей.' } } });
  assert.equal(storage.recoverStaleJobs(60000), 1);
  const recovered = storage.getJob(first.id)!;
  assert.equal(recovered.status, 'QUEUED');
  assert.equal(recovered.checkpoint.offset, 24);
  assert.deepEqual(recovered.checkpoint.translated, { cue1: 'Здравей.' });
  const restarted = new Database(databasePath, { readonly: true });
  assert.equal((restarted.prepare('SELECT status FROM subtitle_jobs WHERE id=?').get(first.id) as { status: string } | undefined)?.status, 'QUEUED');
  restarted.close();
  storage.updateJob(first.id, 'SKIPPED', { error: 'test complete' });
});

test('repeated worker crashes reach the retry ceiling and dead-letter instead of looping', () => {
  const job = storage.enqueueJob(22, 90);
  storage.updateJob(job.id, 'TRANSLATING', {
    attempts: 99,
    lockedAt: Date.now() - 120_000,
  });

  assert.equal(storage.recoverStaleJobs(60_000), 1);
  const recovered = storage.getJob(job.id)!;
  assert.equal(recovered.status, 'FAILED');
  assert.match(recovered.error ?? '', /retry ceiling/);
  assert.equal(recovered.available_at, Number.MAX_SAFE_INTEGER);
  assert.ok(storage.deadLetters().some((row) => row.job_id === job.id));
});

test('source misses remain skipped during their cache window and become eligible for rediscovery after expiry', () => {
  const job = storage.enqueueJob(21, 3);
  storage.skipJobForNoSubtitleSource(job.id, 'no subtitle source', 60_000);
  assert.equal(storage.getJob(job.id)?.status, 'SKIPPED');
  assert.equal(storage.getJob(job.id)?.error, 'no subtitle source');
  assert.equal(storage.enqueueOnDemandJob(21, 3).status, 'SKIPPED');
  const db = new Database(databasePath);
  db.prepare('UPDATE subtitle_jobs SET available_at=? WHERE id=?').run(Date.now() - 1, job.id);
  db.close();
  assert.equal(storage.enqueueOnDemandJob(21, 3).status, 'QUEUED');
  storage.updateJob(job.id, 'SKIPPED', { error: 'test complete' });
  storage.addSubtitleTitleAlias(21, 'playtube', 'Примерно заглавие');
  assert.equal(storage.subtitleTitleAliases(21, 'playtube')[0]?.source_title, 'Примерно заглавие');
  storage.setSubtitleOffset(21, 3, 'playtube', 250);
  assert.equal(storage.getSubtitleOffset(21, 3, 'playtube'), 250);
  assert.deepEqual(storage.subtitleOffsets(21, 3), { playtube: 250 });
  storage.saveSubtitleHardsub({ animeId: 21, episode: 3, sourceId: 'playtube', sourceTitle: 'Примерно заглавие', sourceUrl: 'https://playtube.tv/watch/episode' });
  assert.equal(storage.getSubtitleHardsub(21, 3)?.source_id, 'playtube');
});

test('background queue refill only requeues expired no-source results and respects its batch limit', () => {
  const first = storage.enqueueJob(21, 1);
  const second = storage.enqueueJob(21, 2);
  storage.skipJobForNoSubtitleSource(first.id, 'no subtitle source', 60_000);
  storage.skipJobForNoSubtitleSource(second.id, 'no usable English or Japanese subtitle source', 60_000);
  const db = new Database(databasePath);
  db.prepare('UPDATE subtitle_jobs SET available_at=? WHERE id IN (?,?)').run(Date.now() - 1, first.id, second.id);
  db.close();
  assert.equal(storage.requeueExpiredSubtitleSources(1), 1);
  assert.equal([storage.getJob(first.id), storage.getJob(second.id)].filter(job => job?.status === 'QUEUED').length, 1);
  assert.equal(storage.requeueExpiredSubtitleSources(1), 1);
  assert.equal([storage.getJob(first.id), storage.getJob(second.id)].filter(job => job?.status === 'QUEUED').length, 2);
  storage.updateJob(first.id, 'SKIPPED', { error: 'test complete' });
  storage.updateJob(second.id, 'SKIPPED', { error: 'test complete' });
});

test('fresh on-demand work is claimed before the older bulk-discovery backlog', () => {
  const bulk = storage.enqueueJob(21, 2);
  const demand = storage.enqueueOnDemandJob(22, 1);
  const claimed = storage.claimUndiscoveredJobs(1);
  assert.equal(claimed[0]?.id, demand.id);
  storage.updateJob(demand.id, 'SKIPPED', { error: 'test complete' });
  storage.updateJob(bulk.id, 'SKIPPED', { error: 'test complete' });
});

test('content-addressed bodies and validated cache entries are reused by config key', async () => {
  const body = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nЗдравей!\n';
  const savedSource = await storage.saveBody('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello!\n', 'vtt');
  const savedOutput = await storage.saveBody(body, 'vtt');
  const repeated = await storage.saveBody(body, 'vtt');
  assert.equal(repeated.path, savedOutput.path);
  const id = storage.storeValidatedArtifact({ animeId: 21, seasonId: null, episodeId: '1', sourceLanguage: 'en', targetLanguage: 'bg', sourceHash: savedSource.hash, model: 'provider:editsub', configHash: 'config-a', sourceFormat: 'vtt', translatedFormat: 'vtt', sourcePath: savedSource.path, translatedPath: savedOutput.path, score: 0.98 });
  assert.equal(storage.findCachedArtifact(savedSource.hash, 'bg', 'config-a', '3')?.id, id);
  assert.equal(storage.findCachedArtifact(savedSource.hash, 'bg', 'config-b', '3'), undefined);
  assert.equal(storage.existingBulgarian(21, 1), true);
  assert.equal(storage.listArtifacts(21, '1')[0]?.validation_status, 'validated');
  assert.equal(storage.listArtifacts(21, '1')[0]?.translation_version, '3');
  const revisedOutput = await storage.saveBody('re-serialized validated Bulgarian subtitle', 'vtt');
  storage.updateValidatedArtifactBody(id, revisedOutput.path, 'vtt');
  assert.equal(storage.listArtifacts(21, '1')[0]?.translated_path, revisedOutput.path);
});

test('concurrent content-addressed writes are atomic and existing corruption is rejected', async () => {
  const content = `atomic body ${Date.now()}\n`;
  const copies = await Promise.all(Array.from({ length: 8 }, () => storage.saveBody(content, 'vtt')));
  assert.equal(new Set(copies.map(item => item.path)).size, 1);
  assert.equal(await storage.readBody(copies[0]!.path), content);
  await writeFile(copies[0]!.path, 'corrupted body');
  await assert.rejects(() => storage.saveBody(content, 'vtt'), /failed integrity check/);
});

test('subtitle body reads and artifact paths cannot escape the configured asset directory', async () => {
  await assert.rejects(() => storage.readBody('/etc/passwd'), /outside the configured asset directory/);
  await assert.rejects(() => storage.readBody('../../etc/passwd'), /outside the configured asset directory/);
  assert.throws(() => storage.relativeBodyPath('/etc/passwd'), /outside the configured asset directory/);
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'private');
  await symlink(outside, join(root, 'bodies', 'escape-link'));
  await assert.rejects(() => storage.readBody('escape-link'), /resolves outside the configured asset directory/);
});

test('indexed subtitle asset reads validate the path, content hash, and byte length', async () => {
  const body = `indexed integrity ${Date.now()}\n`;
  const stored = await storage.storeSubtitleAsset(body, 'vtt', 'bg', { provider: 'storage-test', providerId: 'integrity-case' });
  const loaded = await storage.readSubtitleAsset(stored.hash);
  assert.equal(loaded?.body, body);
  await writeFile(stored.path, 'tampered bytes');
  await assert.rejects(() => storage.readSubtitleAsset(stored.hash), /hash mismatch/);
});

test('discovery stages languages and claims English before Japanese sources', () => {
  const episodeA = storage.enqueueJob(21, 4);
  const episodeB = storage.enqueueJob(22, 2);
  const discovered = storage.claimUndiscoveredJobs(1);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]!.anime_id, 21);
  storage.updateJob(episodeA.id, 'QUEUED', { sourceLanguage: 'ja', checkpoint: { sourceTrack: { language: 'ja', url: 'https://example.test/ja.vtt' } }, lockedAt: null });
  const remainingDiscovery = storage.claimUndiscoveredJobs(1);
  assert.equal(remainingDiscovery[0]!.anime_id, 22);
  storage.updateJob(episodeB.id, 'QUEUED', { sourceLanguage: 'en', checkpoint: { sourceTrack: { language: 'en', url: 'https://example.test/en.vtt' } }, lockedAt: null });
  const isolated = new Database(databasePath);
  isolated.prepare('UPDATE subtitle_jobs SET priority=0 WHERE id IN (?,?)').run(episodeA.id, episodeB.id);
  isolated.close();
  const claimed = storage.claimJobs(1);
  assert.equal(claimed[0]!.anime_id, 22);
});

test('episode queues sort numeric episode IDs numerically', () => {
  const ten = storage.enqueueJob(22, 110);
  const two = storage.enqueueJob(22, 12);
  storage.updateJob(ten.id, 'QUEUED', { sourceLanguage: 'en' });
  storage.updateJob(two.id, 'QUEUED', { sourceLanguage: 'en' });
  const claimed = storage.claimJobs(2);
  assert.deepEqual(claimed.map(job => job.episode_id), ['12', '110']);
});

test('validated translations never overwrite an existing final manual subtitle', async () => {
  const database = new Database(databasePath);
  database.prepare(`INSERT INTO subs(title_id,number,path,source,status,translator) VALUES(21,2,'manual/2.vtt','manual','final','Редакция')`).run();
  database.close();
  const source = await storage.saveBody('source text', 'srt');
  const output = await storage.saveBody('validated text', 'srt');
  storage.storeValidatedArtifact({ animeId: 21, seasonId: null, episodeId: '2', sourceLanguage: 'ja', targetLanguage: 'bg', sourceHash: source.hash, model: 'provider:editsub', configHash: 'config-c', sourceFormat: 'srt', translatedFormat: 'srt', sourcePath: source.path, translatedPath: output.path, score: 0.9 });
  const check = new Database(databasePath, { readonly: true });
  assert.deepEqual(check.prepare('SELECT path,source,status,translator FROM subs WHERE title_id=21 AND number=2').get(), { path: 'manual/2.vtt', source: 'manual', status: 'final', translator: 'Редакция' });
  check.close();
});

test('pause, resume and graceful stop flags persist across process connections', () => {
  storage.setWorkerControl('paused');
  const restarted = new Database(databasePath, { readonly: true });
  assert.equal((restarted.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='control'`).get() as { value: string } | undefined)?.value, 'paused');
  restarted.close();
  storage.setWorkerControl('running');
  assert.equal(storage.workerControl(), 'running');
  storage.setWorkerControl('stopping');
  assert.equal(storage.workerControl(), 'stopping');
  const stoppedRestart = new Database(databasePath, { readonly: true });
  assert.equal((stoppedRestart.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='control'`).get() as { value: string } | undefined)?.value, 'stopping');
  stoppedRestart.close();
});

test('system shutdown restores only its own transient stop flag and preserves operator controls', () => {
  storage.setWorkerControl('stopping');
  assert.equal(storage.compareAndSetWorkerControl('stopping', 'running'), true);
  assert.equal(storage.workerControl(), 'running');
  storage.setWorkerControl('stopping');
  storage.setWorkerControl('paused');
  assert.equal(storage.compareAndSetWorkerControl('stopping', 'running'), false);
  assert.equal(storage.workerControl(), 'paused');
  storage.setWorkerControl('running');
});

test('worker dashboard status follows a live heartbeat and expires after a crash', () => {
  storage.recordWorkerHeartbeat(10_000);
  assert.equal(storage.workerProcessStatus(20_000, 30_000), 'running');
  assert.equal(storage.workerProcessStatus(50_001, 30_000), 'stopped');
  storage.recordWorkerHeartbeat(0);
  assert.equal(storage.workerProcessStatus(50_001, 30_000), 'stopped');
});

test('subtitle index job heartbeat refreshes its lease before stale recovery', () => {
  assert.equal(storage.enqueueSubtitleIndexJob({ animeId: '21', episode: 77 }), true);
  const claimed = storage.claimSubtitleIndexJobs(1, 100_000);
  assert.equal(claimed.length, 1);
  const id = Number(claimed[0]!.id);
  storage.heartbeatSubtitleIndexJob(id, 150_000);
  assert.equal(storage.recoverStaleSubtitleIndexJobs(30_000, 160_000), 0);
  assert.equal(storage.recoverStaleSubtitleIndexJobs(30_000, 181_000), 1);
  storage.finishSubtitleIndexJob(id);
});

test('repeated subtitle indexer crashes reach the retry ceiling and stay terminal', () => {
  assert.equal(storage.enqueueSubtitleIndexJob({ animeId: '22', episode: 91 }), true);
  const database = new Database(databasePath);
  const row = database.prepare('SELECT id FROM subtitle_index_jobs WHERE anime_id=? AND episode_number=?').get('22', 91) as { id: number };
  const id = Number(row.id);
  database.prepare(`UPDATE subtitle_index_jobs SET state='RUNNING',attempts=5,locked_at=? WHERE id=?`).run(100_000, id);
  database.close();

  assert.equal(storage.recoverStaleSubtitleIndexJobs(30_000, 200_000), 1);
  const check = new Database(databasePath, { readonly: true });
  const recovered = check.prepare('SELECT state,available_at,error FROM subtitle_index_jobs WHERE id=?').get(id) as { state: string; available_at: number; error: string };
  check.close();
  assert.equal(recovered.state, 'FAILED');
  assert.equal(recovered.available_at, Number.MAX_SAFE_INTEGER);
  assert.match(recovered.error, /retry ceiling/);
});

test('transient subtitle-index errors remain queued behind bounded backoff', () => {
  assert.equal(storage.enqueueSubtitleIndexJob({ animeId: 'retry-index', episode: 1 }), true);
  const claimed = storage.claimSubtitleIndexJobs(1);
  assert.equal(claimed[0]?.anime_id, 'retry-index');
  const id = Number(claimed[0]?.id);
  const beforeFailure = Date.now();
  storage.finishSubtitleIndexJob(id, 'temporary provider timeout');
  const pending = new Database(databasePath, { readonly: true });
  const retry = pending.prepare('SELECT state,available_at,error FROM subtitle_index_jobs WHERE id=?').get(id) as { state: string; available_at: number; error: string };
  pending.close();
  assert.equal(retry.state, 'QUEUED');
  assert.ok(retry.available_at > beforeFailure);
  assert.equal(retry.error, 'temporary provider timeout');
  assert.deepEqual(storage.claimSubtitleIndexJobs(1, beforeFailure), []);
  assert.equal(Number(storage.claimSubtitleIndexJobs(1, retry.available_at)[0]?.id), id);
  storage.finishSubtitleIndexJob(id);
});

test('enabling a previously disabled subtitle provider clears its stale misses and requeues affected episodes once', () => {
  assert.equal(storage.enqueueSubtitleIndexJob({ animeId: 'provider-enable', episode: 1 }), true);
  const database = new Database(databasePath);
  const job = database.prepare('SELECT id FROM subtitle_index_jobs WHERE anime_id=? AND episode_number=1').get('provider-enable') as { id: number };
  database.prepare("UPDATE subtitle_index_jobs SET state='COMPLETED',attempts=2 WHERE id=?").run(job.id);
  database.close();
  storage.recordProviderMiss('provider-enable', 1, 'opensubtitles');
  assert.equal(storage.syncSubtitleProviderEnabled('opensubtitles', false), 0);
  assert.equal(storage.providerMissActive('provider-enable', 1, 'opensubtitles'), true);
  assert.equal(storage.syncSubtitleProviderEnabled('opensubtitles', true), 1);
  assert.equal(storage.providerMissActive('provider-enable', 1, 'opensubtitles'), false);
  const check = new Database(databasePath, { readonly: true });
  const requeued = check.prepare('SELECT state,attempts,available_at FROM subtitle_index_jobs WHERE id=?').get(job.id) as { state: string; attempts: number; available_at: number };
  check.close();
  assert.deepEqual(requeued, { state: 'QUEUED', attempts: 0, available_at: 0 });

  const finish = new Database(databasePath);
  finish.prepare("UPDATE subtitle_index_jobs SET state='COMPLETED' WHERE id=?").run(job.id);
  finish.close();
  storage.recordProviderMiss('provider-enable', 1, 'opensubtitles');
  assert.equal(storage.syncSubtitleProviderEnabled('opensubtitles', true), 0);
  assert.equal(storage.providerMissActive('provider-enable', 1, 'opensubtitles'), true);
});

test('operational data cleanup bounds logs and expires only cache and miss rows', () => {
  const job = storage.enqueueJob(22, 3);
  storage.logJob(job.id, 'info', 'old-event');
  storage.logJob(job.id, 'error', 'recent-error');
  const database = new Database(databasePath);
  database.prepare("UPDATE subtitle_job_logs SET created_at='2000-01-01T00:00:00.000Z' WHERE event='old-event'").run();
  database.prepare("INSERT INTO subtitle_provider_misses(anime_id,episode_number,provider,expires_at) VALUES('22',3,'expired',1)").run();
  database.prepare("INSERT INTO subtitle_provider_http_cache(cache_key,etag,last_modified,response_body,response_status,updated_at) VALUES('expired',NULL,NULL,'body',200,'2000-01-01T00:00:00.000Z')").run();
  database.close();
  const result = storage.pruneSubtitleOperationalData(Date.now(), 7, 1);
  assert.equal(result.expiredProviderMisses, 1);
  assert.equal(result.expiredHttpCache, 1);
  assert.ok(result.expiredLogs >= 1);
  const check = new Database(databasePath, { readonly: true });
  assert.equal((check.prepare('SELECT COUNT(*) AS n FROM subtitle_job_logs').get() as { n: number }).n, 1);
  assert.equal((check.prepare("SELECT COUNT(*) AS n FROM subtitle_job_logs WHERE event='recent-error'").get() as { n: number }).n, 1);
  assert.equal((check.prepare('SELECT COUNT(*) AS n FROM subtitle_jobs WHERE id=?').get(job.id) as { n: number }).n, 1);
  check.close();
  storage.updateJob(job.id, 'SKIPPED', { error: 'test complete' });
});

test('persisted subtitle provider cache refuses oversized bodies', () => {
  storage.saveIndexerHttpCache('large-response', { body: 'x'.repeat(2 * 1024 * 1024 + 1), etag: '"v1"', status: 200 });
  assert.deepEqual(storage.indexerHttpCache('large-response'), { etag: '"v1"', lastModified: null, body: null, status: 200 });
});
