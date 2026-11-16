import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('source misses become terminal SKIPPED and aliases plus subtitle offsets persist', () => {
  const job = storage.enqueueJob(21, 3);
  storage.skipJobForNoSubtitleSource(job.id);
  assert.equal(storage.getJob(job.id)?.status, 'SKIPPED');
  assert.equal(storage.getJob(job.id)?.error, 'no subtitle source');
  storage.addSubtitleTitleAlias(21, 'playtube', 'Примерно заглавие');
  assert.equal(storage.subtitleTitleAliases(21, 'playtube')[0]?.source_title, 'Примерно заглавие');
  storage.setSubtitleOffset(21, 3, 'playtube', 250);
  assert.equal(storage.getSubtitleOffset(21, 3, 'playtube'), 250);
  assert.deepEqual(storage.subtitleOffsets(21, 3), { playtube: 250 });
  storage.saveSubtitleHardsub({ animeId: 21, episode: 3, sourceId: 'playtube', sourceTitle: 'Примерно заглавие', sourceUrl: 'https://playtube.tv/watch/episode' });
  assert.equal(storage.getSubtitleHardsub(21, 3)?.source_id, 'playtube');
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
  const id = storage.storeValidatedArtifact({ animeId: 21, seasonId: null, episodeId: '1', sourceLanguage: 'en', targetLanguage: 'bg', sourceHash: savedSource.hash, model: 'local-qwen', configHash: 'config-a', sourceFormat: 'vtt', translatedFormat: 'vtt', sourcePath: savedSource.path, translatedPath: savedOutput.path, score: 0.98 });
  assert.equal(storage.findCachedArtifact(savedSource.hash, 'bg', 'config-a', '3')?.id, id);
  assert.equal(storage.findCachedArtifact(savedSource.hash, 'bg', 'config-b', '3'), undefined);
  assert.equal(storage.existingBulgarian(21, 1), true);
  assert.equal(storage.listArtifacts(21, '1')[0]?.validation_status, 'validated');
  assert.equal(storage.listArtifacts(21, '1')[0]?.translation_version, '3');
  const revisedOutput = await storage.saveBody('re-serialized validated Bulgarian subtitle', 'vtt');
  storage.updateValidatedArtifactBody(id, revisedOutput.path, 'vtt');
  assert.equal(storage.listArtifacts(21, '1')[0]?.translated_path, revisedOutput.path);
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
  storage.storeValidatedArtifact({ animeId: 21, seasonId: null, episodeId: '2', sourceLanguage: 'ja', targetLanguage: 'bg', sourceHash: source.hash, model: 'local-qwen', configHash: 'config-c', sourceFormat: 'srt', translatedFormat: 'srt', sourcePath: source.path, translatedPath: output.path, score: 0.9 });
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
});

test('worker dashboard status follows a live heartbeat and expires after a crash', () => {
  storage.recordWorkerHeartbeat(10_000);
  assert.equal(storage.workerProcessStatus(20_000, 30_000), 'running');
  assert.equal(storage.workerProcessStatus(50_001, 30_000), 'stopped');
  storage.recordWorkerHeartbeat(0);
  assert.equal(storage.workerProcessStatus(50_001, 30_000), 'stopped');
});
