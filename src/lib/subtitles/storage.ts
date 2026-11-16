import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { subtitleConfig } from './config';

export type JobState = 'DISCOVERED' | 'QUEUED' | 'DOWNLOADING' | 'NORMALIZING' | 'TRANSLATING' | 'VALIDATING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
const dbPath = resolve(process.env.CATALOG_DB_PATH ?? 'data/catalog.db');
const bodyRoot = resolve(subtitleConfig.dataDirectory);
const database = new Database(dbPath, { timeout: 5000 });
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 5000');
database.exec(`
CREATE TABLE IF NOT EXISTS subtitle_artifacts (
  id INTEGER PRIMARY KEY, anime_id INTEGER NOT NULL, season_id TEXT, episode_id TEXT NOT NULL,
  source_language TEXT NOT NULL, target_language TEXT NOT NULL, source_hash TEXT NOT NULL,
  model TEXT NOT NULL, translation_version TEXT NOT NULL, config_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK(validation_status IN ('validated','rejected')),
  source_format TEXT NOT NULL, translated_format TEXT NOT NULL,
  source_path TEXT NOT NULL, translated_path TEXT NOT NULL, score REAL NOT NULL,
  UNIQUE(anime_id, episode_id, source_hash, target_language, config_hash)
);
CREATE INDEX IF NOT EXISTS subtitle_artifacts_lookup ON subtitle_artifacts(anime_id,episode_id,target_language,validation_status);
CREATE TABLE IF NOT EXISTS subtitle_jobs (
  id INTEGER PRIMARY KEY, anime_id INTEGER NOT NULL, season_id TEXT, episode_id TEXT NOT NULL,
  target_language TEXT NOT NULL DEFAULT 'bg', source_language TEXT, provider_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('DISCOVERED','QUEUED','DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING','COMPLETED','FAILED','SKIPPED')),
  attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, locked_at INTEGER,
  checkpoint TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  source_hash TEXT, UNIQUE(anime_id,episode_id,target_language)
);
CREATE INDEX IF NOT EXISTS subtitle_jobs_ready ON subtitle_jobs(status,available_at,anime_id,episode_id);
CREATE TABLE IF NOT EXISTS subtitle_glossary (
  anime_id INTEGER NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(anime_id,source)
);
CREATE TABLE IF NOT EXISTS subtitle_job_logs (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES subtitle_jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS subtitle_job_logs_job ON subtitle_job_logs(job_id,created_at);
CREATE TABLE IF NOT EXISTS subtitle_worker_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subtitle_dead_letters (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES subtitle_jobs(id), failed_at TEXT NOT NULL, attempts INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subtitle_assets (
  content_hash TEXT PRIMARY KEY, format TEXT NOT NULL, language TEXT NOT NULL, storage_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL, provenance TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subtitle_index (
  id INTEGER PRIMARY KEY, anime_id TEXT NOT NULL, anidb_id TEXT, imdb_id TEXT, season_number INTEGER,
  episode_number INTEGER NOT NULL, language TEXT NOT NULL, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
  release_group TEXT, file_hash TEXT, duration_ms INTEGER, format TEXT, source_url TEXT, attribution TEXT,
  quality_score REAL NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, catalog_only INTEGER NOT NULL DEFAULT 0,
  fetchable INTEGER NOT NULL DEFAULT 0, asset_hash TEXT REFERENCES subtitle_assets(content_hash), discovered_at TEXT NOT NULL,
  UNIQUE(provider,provider_id)
);
CREATE INDEX IF NOT EXISTS subtitle_index_lookup ON subtitle_index(anime_id,episode_number,language,quality_score DESC);
CREATE INDEX IF NOT EXISTS subtitle_index_alias_lookup ON subtitle_index(provider,anime_id,language,episode_number);
CREATE TABLE IF NOT EXISTS subtitle_index_verification_queue (
  index_id INTEGER PRIMARY KEY REFERENCES subtitle_index(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','VERIFIED','REJECTED')),
  reason TEXT NOT NULL, queued_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subtitle_asset_sources (
  content_hash TEXT NOT NULL REFERENCES subtitle_assets(content_hash), provider TEXT NOT NULL,
  provider_id TEXT NOT NULL, source_url TEXT, attribution TEXT, added_at TEXT NOT NULL,
  PRIMARY KEY(content_hash,provider,provider_id)
);
CREATE TABLE IF NOT EXISTS subtitle_title_aliases (
  anime_id TEXT NOT NULL, normalized_title TEXT NOT NULL, display_title TEXT NOT NULL,
  PRIMARY KEY(anime_id,normalized_title)
);
CREATE INDEX IF NOT EXISTS subtitle_title_alias_lookup ON subtitle_title_aliases(normalized_title,anime_id);
CREATE TABLE IF NOT EXISTS subtitle_provider_misses (
  anime_id TEXT NOT NULL, episode_number INTEGER NOT NULL, provider TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(anime_id,episode_number,provider)
);
CREATE TABLE IF NOT EXISTS subtitle_provider_http_cache (
  cache_key TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, response_body TEXT, response_status INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subtitle_index_jobs (
  id INTEGER PRIMARY KEY, anime_id TEXT NOT NULL, episode_number INTEGER NOT NULL,
  season_number INTEGER, video_hash TEXT, release_group TEXT, duration_ms INTEGER,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, locked_at INTEGER,
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(anime_id,episode_number)
);
CREATE INDEX IF NOT EXISTS subtitle_index_jobs_ready ON subtitle_index_jobs(state,available_at,anime_id,episode_number);
CREATE TABLE IF NOT EXISTS subtitle_indexer_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`);

export interface Job { id: number; anime_id: number; season_id: string | null; episode_id: string; target_language: string; source_language: string | null; provider_id: string | null; status: JobState; attempts: number; available_at: number; locked_at: number | null; checkpoint: Record<string, unknown>; error: string | null; source_hash: string | null; }
const fromRow = (row: Record<string, unknown>): Job => ({ ...row, checkpoint: JSON.parse(String(row.checkpoint ?? '{}')) } as Job);
const nowIso = () => new Date().toISOString();

export interface SubtitleIndexInput {
  animeId: string; anidbId?: string | null; imdbId?: string | null; seasonNumber?: number | null;
  episodeNumber: number; language: string; provider: string; providerId: string;
  releaseGroup?: string | null; fileHash?: string | null; durationMs?: number | null;
  format?: string | null; sourceUrl?: string | null; attribution?: string | null;
  qualityScore: number; verified?: boolean; catalogOnly?: boolean; fetchable?: boolean; assetHash?: string | null;
}

export interface SubtitleIndexRecord extends SubtitleIndexInput { id: number; discovered_at: string; }

export async function storeSubtitleAsset(content: string, format: string, language: string, provenance: Record<string, unknown>): Promise<{ hash: string; path: string }> {
  const body = content.replace(/^\uFEFF/, '');
  const saved = await saveBody(body, format);
  const current = database.prepare('SELECT storage_path,provenance FROM subtitle_assets WHERE content_hash=?').get(saved.hash) as { storage_path: string; provenance: string } | undefined;
  if (!current) recordSubtitleAssetBody(saved.hash, saved.path, format, language, Buffer.byteLength(body), provenance);
  else {
    let sources: unknown[] = [];
    try { const value = JSON.parse(current.provenance) as Record<string, unknown>; sources = Array.isArray(value.sources) ? value.sources : [value]; } catch { sources = []; }
    database.prepare('UPDATE subtitle_assets SET provenance=? WHERE content_hash=?').run(JSON.stringify({ sources: [...sources, provenance].slice(-32) }), saved.hash);
  }
  const source = provenance as { provider?: unknown; providerId?: unknown; sourceUrl?: unknown; attribution?: unknown };
  if (source.provider && source.providerId) database.prepare(`INSERT OR IGNORE INTO subtitle_asset_sources(content_hash,provider,provider_id,source_url,attribution,added_at) VALUES(?,?,?,?,?,?)`).run(saved.hash, String(source.provider), String(source.providerId), source.sourceUrl == null ? null : String(source.sourceUrl), source.attribution == null ? null : String(source.attribution), nowIso());
  return { hash: saved.hash, path: current?.storage_path ?? saved.path };
}

export function recordSubtitleAssetBody(hash: string, path: string, format: string, language: string, byteLength: number, provenance: Record<string, unknown>): void {
  database.prepare(`INSERT OR IGNORE INTO subtitle_assets(content_hash,format,language,storage_path,byte_length,provenance,created_at) VALUES(?,?,?,?,?,?,?)`).run(hash, format, language, path, byteLength, JSON.stringify(provenance), nowIso());
}

export async function readSubtitleAsset(hash: string): Promise<{ body: string; asset: Record<string, unknown> } | undefined> {
  const asset = database.prepare('SELECT * FROM subtitle_assets WHERE content_hash=?').get(hash) as Record<string, unknown> | undefined;
  if (!asset) return undefined;
  try { return { body: await readFile(String(asset.storage_path), 'utf8'), asset }; } catch { return undefined; }
}

export function upsertSubtitleIndex(input: SubtitleIndexInput): number {
  const normalized = { ...input, anidbId: input.anidbId ?? null, imdbId: input.imdbId ?? null, seasonNumber: input.seasonNumber ?? null, releaseGroup: input.releaseGroup ?? null, fileHash: input.fileHash ?? null, durationMs: input.durationMs ?? null, format: input.format ?? null, sourceUrl: input.sourceUrl ?? null, attribution: input.attribution ?? null, verified: Number(Boolean(input.verified)), catalogOnly: Number(Boolean(input.catalogOnly)), fetchable: Number(Boolean(input.fetchable)), assetHash: input.assetHash ?? null };
  database.prepare(`INSERT INTO subtitle_index(anime_id,anidb_id,imdb_id,season_number,episode_number,language,provider,provider_id,release_group,file_hash,duration_ms,format,source_url,attribution,quality_score,verified,catalog_only,fetchable,asset_hash,discovered_at)
    VALUES(@animeId,@anidbId,@imdbId,@seasonNumber,@episodeNumber,@language,@provider,@providerId,@releaseGroup,@fileHash,@durationMs,@format,@sourceUrl,@attribution,@qualityScore,@verified,@catalogOnly,@fetchable,@assetHash,@discoveredAt)
    ON CONFLICT(provider,provider_id) DO UPDATE SET anime_id=excluded.anime_id,anidb_id=COALESCE(excluded.anidb_id,subtitle_index.anidb_id),imdb_id=COALESCE(excluded.imdb_id,subtitle_index.imdb_id),season_number=COALESCE(excluded.season_number,subtitle_index.season_number),episode_number=excluded.episode_number,language=excluded.language,release_group=COALESCE(excluded.release_group,subtitle_index.release_group),file_hash=COALESCE(excluded.file_hash,subtitle_index.file_hash),duration_ms=COALESCE(excluded.duration_ms,subtitle_index.duration_ms),format=COALESCE(excluded.format,subtitle_index.format),source_url=COALESCE(excluded.source_url,subtitle_index.source_url),attribution=COALESCE(excluded.attribution,subtitle_index.attribution),quality_score=MAX(excluded.quality_score,subtitle_index.quality_score),verified=MAX(excluded.verified,subtitle_index.verified),catalog_only=excluded.catalog_only,fetchable=MAX(excluded.fetchable,subtitle_index.fetchable),asset_hash=COALESCE(excluded.asset_hash,subtitle_index.asset_hash)`).run({ ...normalized, discoveredAt: nowIso() });
  const id = Number((database.prepare('SELECT id FROM subtitle_index WHERE provider=? AND provider_id=?').get(input.provider, input.providerId) as { id: number }).id);
  if (!input.catalogOnly && input.qualityScore >= 0.5 && input.qualityScore < 0.85) {
    database.prepare(`INSERT INTO subtitle_index_verification_queue(index_id,state,reason,queued_at,updated_at) VALUES(?,'QUEUED','Match confidence is between 0.5 and 0.85',?,?) ON CONFLICT(index_id) DO NOTHING`).run(id, nowIso(), nowIso());
  }
  if (input.qualityScore >= 0.85 && input.verified) database.prepare(`DELETE FROM subtitle_index_verification_queue WHERE index_id=?`).run(id);
  return id;
}

export function markSubtitleIndexVerified(indexId: number, evidence: string): void {
  const row = database.prepare('SELECT quality_score,catalog_only,asset_hash FROM subtitle_index WHERE id=?').get(indexId) as { quality_score: number; catalog_only: number; asset_hash: string | null } | undefined;
  if (!row || row.catalog_only || !row.asset_hash || row.quality_score < 0.5 || row.quality_score >= 0.85) throw new Error('Only an indexed subtitle candidate with an attached asset and score 0.5–0.85 can be manually verified');
  const now = nowIso();
  const updateIndex = database.prepare('UPDATE subtitle_index SET verified=1 WHERE id=?');
  const updateQueue = database.prepare(`UPDATE subtitle_index_verification_queue SET state='VERIFIED',reason=?,updated_at=? WHERE index_id=? AND state IN ('QUEUED','RUNNING')`);
  const transaction = database.transaction(() => {
    updateIndex.run(indexId);
    const changed = updateQueue.run(evidence.slice(0, 1000), now, indexId).changes;
    if (!changed) throw new Error('Subtitle candidate is not waiting in the verification queue');
  });
  transaction();
}

export function markSubtitleIndexRejected(indexId: number, reason: string): void {
  const now = nowIso();
  const changed = database.prepare(`UPDATE subtitle_index_verification_queue SET state='REJECTED',reason=?,updated_at=? WHERE index_id=? AND state='QUEUED'`).run(reason.slice(0, 1000), now, indexId).changes;
  if (!changed) throw new Error('Subtitle candidate is not waiting in the verification queue');
}

export function subtitleIndexReviewQueue(limit = 100): Array<Record<string, unknown>> {
  return database.prepare(`SELECT q.index_id,q.reason,q.queued_at,i.anime_id,i.episode_number,i.provider,i.source_url,i.quality_score,i.attribution,t.romaji,t.english
    FROM subtitle_index_verification_queue q JOIN subtitle_index i ON i.id=q.index_id
    LEFT JOIN titles t ON CAST(t.id AS TEXT)=i.anime_id WHERE q.state='QUEUED' ORDER BY q.queued_at LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
}

export function addSubtitleTitleAliases(animeId: string, titles: string[]): void {
  const insert = database.prepare('INSERT OR IGNORE INTO subtitle_title_aliases(anime_id,normalized_title,display_title) VALUES(?,?,?)');
  const tx = database.transaction(() => { for (const title of titles) { const normalized = title.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); if (normalized) insert.run(animeId, normalized, title); } });
  tx();
}

export function resolveIndexedSubtitle(animeId: string, episode: number, language = 'bg', title?: string): Array<Record<string, unknown>> {
  const normalized = title?.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() ?? '';
  return database.prepare(`SELECT i.*,a.storage_path,a.byte_length,a.format AS asset_format,q.state AS verification_state FROM subtitle_index i LEFT JOIN subtitle_assets a ON a.content_hash=i.asset_hash LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id
    WHERE i.language=? AND i.episode_number IN (?,0) AND (i.anime_id=? OR (?<>'' AND i.anime_id IN (SELECT anime_id FROM subtitle_title_aliases WHERE normalized_title=?)))
    ORDER BY i.catalog_only ASC,i.verified DESC,i.quality_score DESC,i.discovered_at DESC`).all(language, episode, animeId, normalized, normalized) as Array<Record<string, unknown>>;
}
export function indexedSubtitleRows(animeId: string, episode: number): Array<Record<string, unknown>> {
  return database.prepare('SELECT provider,quality_score FROM subtitle_index WHERE anime_id=? AND episode_number=?').all(animeId, episode) as Array<Record<string, unknown>>;
}

export function providerMissActive(animeId: string, episode: number, provider: string, now = Date.now()): boolean {
  return Boolean(database.prepare('SELECT 1 FROM subtitle_provider_misses WHERE anime_id=? AND episode_number=? AND provider=? AND expires_at>?').get(animeId, episode, provider, now));
}
export function recordProviderMiss(animeId: string, episode: number, provider: string, ttlMs = 7 * 24 * 60 * 60_000): void {
  database.prepare(`INSERT INTO subtitle_provider_misses(anime_id,episode_number,provider,expires_at) VALUES(?,?,?,?) ON CONFLICT(anime_id,episode_number,provider) DO UPDATE SET expires_at=excluded.expires_at`).run(animeId, episode, provider, Date.now() + ttlMs);
}
export function enqueueSubtitleIndexJob(input: { animeId: string; episode: number; season?: number | null; videoHash?: string | null; releaseGroup?: string | null; durationMs?: number | null }): boolean {
  const now = nowIso();
  const existing = database.prepare('SELECT id,state,updated_at,available_at FROM subtitle_index_jobs WHERE anime_id=? AND episode_number=?').get(input.animeId, input.episode) as { id: number; state: string; updated_at: string; available_at: number } | undefined;
  if (existing) {
    if (existing.state === 'QUEUED' || existing.state === 'RUNNING') return false;
    if (existing.state === 'COMPLETED' && Date.now() - Date.parse(existing.updated_at) < 7 * 24 * 60 * 60_000) return false;
    if (existing.state === 'FAILED' && existing.available_at > Date.now()) return false;
    return database.prepare(`UPDATE subtitle_index_jobs SET state='QUEUED',season_number=COALESCE(?,season_number),video_hash=COALESCE(?,video_hash),release_group=COALESCE(?,release_group),duration_ms=COALESCE(?,duration_ms),available_at=0,locked_at=NULL,error=NULL,updated_at=? WHERE id=?`).run(input.season ?? null, input.videoHash ?? null, input.releaseGroup ?? null, input.durationMs ?? null, now, existing.id).changes > 0;
  }
  const result = database.prepare(`INSERT INTO subtitle_index_jobs(anime_id,episode_number,season_number,video_hash,release_group,duration_ms,state,attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'QUEUED',0,0,?,?)
    ON CONFLICT(anime_id,episode_number) DO NOTHING`).run(input.animeId, input.episode, input.season ?? null, input.videoHash ?? null, input.releaseGroup ?? null, input.durationMs ?? null, now, now);
  return result.changes > 0;
}
export function claimSubtitleIndexJobs(limit: number, now = Date.now()): Array<Record<string, unknown>> {
  const claim = database.transaction(() => {
    const jobs = database.prepare(`SELECT * FROM subtitle_index_jobs WHERE (state='QUEUED' OR (state='FAILED' AND available_at<=?)) AND available_at<=? ORDER BY created_at,id LIMIT ?`).all(now, now, limit) as Array<Record<string, unknown>>;
    const update = database.prepare(`UPDATE subtitle_index_jobs SET state='RUNNING',attempts=attempts+1,locked_at=?,updated_at=? WHERE id=? AND state IN ('QUEUED','FAILED')`);
    for (const job of jobs) update.run(now, nowIso(), job.id);
    return jobs.map(job => database.prepare('SELECT * FROM subtitle_index_jobs WHERE id=?').get(job.id) as Record<string, unknown>);
  });
  return claim();
}
export function recoverStaleSubtitleIndexJobs(staleMs = 30 * 60_000, now = Date.now()): number {
  return database.prepare(`UPDATE subtitle_index_jobs SET state='QUEUED',locked_at=NULL,available_at=?,error='Recovered after stale indexer lock',updated_at=? WHERE state='RUNNING' AND locked_at IS NOT NULL AND locked_at<?`).run(now, nowIso(), now - staleMs).changes;
}
export function finishSubtitleIndexJob(id: number, error?: string): void {
  const row = database.prepare('SELECT attempts FROM subtitle_index_jobs WHERE id=?').get(id) as { attempts: number } | undefined;
  if (!row) return;
  const terminal = Boolean(error) && row.attempts >= 5;
  const backoff = Math.min(24 * 60 * 60_000, 30_000 * (2 ** Math.max(0, row.attempts - 1)));
  database.prepare('UPDATE subtitle_index_jobs SET state=?,error=?,locked_at=NULL,available_at=?,updated_at=? WHERE id=?').run(error ? (terminal ? 'FAILED' : 'QUEUED') : 'COMPLETED', error ?? null, error ? Date.now() + backoff : 0, nowIso(), id);
}
export function indexerHttpCache(key: string): { etag: string | null; lastModified: string | null; body: string | null; status: number | null } | undefined {
  const row = database.prepare('SELECT etag,last_modified,response_body,response_status FROM subtitle_provider_http_cache WHERE cache_key=?').get(key) as { etag: string | null; last_modified: string | null; response_body: string | null; response_status: number | null } | undefined;
  return row && { etag: row.etag, lastModified: row.last_modified, body: row.response_body, status: row.response_status };
}
export function saveIndexerHttpCache(key: string, input: { etag?: string | null; lastModified?: string | null; body?: string | null; status?: number | null }): void {
  database.prepare(`INSERT INTO subtitle_provider_http_cache(cache_key,etag,last_modified,response_body,response_status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET etag=COALESCE(excluded.etag,subtitle_provider_http_cache.etag),last_modified=COALESCE(excluded.last_modified,subtitle_provider_http_cache.last_modified),response_body=COALESCE(excluded.response_body,subtitle_provider_http_cache.response_body),response_status=COALESCE(excluded.response_status,subtitle_provider_http_cache.response_status),updated_at=excluded.updated_at`).run(key, input.etag ?? null, input.lastModified ?? null, input.body ?? null, input.status ?? null, nowIso());
}
export function subtitleIndexStats(): Record<string, number> {
  const rows = database.prepare(`SELECT provider,COUNT(*) AS count,SUM(CASE WHEN catalog_only=1 THEN 1 ELSE 0 END) AS catalog_only,SUM(CASE WHEN asset_hash IS NOT NULL THEN 1 ELSE 0 END) AS assets FROM subtitle_index GROUP BY provider`).all() as Array<{ provider: string; count: number; catalog_only: number; assets: number }>;
  const jobs = database.prepare(`SELECT state,COUNT(*) AS count FROM subtitle_index_jobs GROUP BY state`).all() as Array<{ state: string; count: number }>;
  const count = (state: string) => Number(jobs.find(job => job.state === state)?.count ?? 0);
  const assetCount = Number((database.prepare('SELECT COUNT(*) AS count FROM subtitle_assets').get() as { count: number }).count);
  const playableRows = Number((database.prepare(`SELECT COUNT(*) AS count FROM subtitle_index i LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id WHERE i.catalog_only=0 AND i.fetchable=1 AND i.asset_hash IS NOT NULL AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED')`).get() as { count: number }).count);
  const catalogOnlyRows = Number((database.prepare('SELECT COUNT(*) AS count FROM subtitle_index WHERE catalog_only=1').get() as { count: number }).count);
  const verifiedRows = Number((database.prepare(`SELECT COUNT(*) AS count FROM subtitle_index i LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id WHERE i.catalog_only=0 AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED')`).get() as { count: number }).count);
  return { titles: Number((database.prepare('SELECT COUNT(DISTINCT anime_id) AS count FROM subtitle_index').get() as { count: number }).count), entries: Number((database.prepare('SELECT COUNT(*) AS count FROM subtitle_index').get() as { count: number }).count), assets: assetCount, playableRows, catalogOnlyRows, verifiedRows, verificationQueued: Number((database.prepare("SELECT COUNT(*) AS count FROM subtitle_index_verification_queue WHERE state='QUEUED'").get() as { count: number }).count), providers: rows.length, queued: count('QUEUED'), running: count('RUNNING'), completed: count('COMPLETED'), failed: count('FAILED') };
}
export function subtitleIndexProviderBreakdown(): Array<{ provider: string; indexedRows: number; playableRows: number; catalogOnlyRows: number; verifiedRows: number }> {
  return database.prepare(`SELECT i.provider,COUNT(*) AS indexedRows,
    SUM(CASE WHEN i.catalog_only=0 AND i.fetchable=1 AND i.asset_hash IS NOT NULL AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED') THEN 1 ELSE 0 END) AS playableRows,
    SUM(CASE WHEN i.catalog_only=1 THEN 1 ELSE 0 END) AS catalogOnlyRows,
    SUM(CASE WHEN i.catalog_only=0 AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED') THEN 1 ELSE 0 END) AS verifiedRows
    FROM subtitle_index i LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id GROUP BY i.provider ORDER BY i.provider`).all() as Array<{ provider: string; indexedRows: number; playableRows: number; catalogOnlyRows: number; verifiedRows: number }>;
}

export function enqueueJob(animeId: number, episodeId: number, target = 'bg'): Job {
  return enqueueJobOnce(animeId, episodeId, target).job;
}
export function enqueueJobOnce(animeId: number, episodeId: number, target = 'bg'): { job: Job; inserted: boolean } {
  const now = nowIso();
  const result = database.prepare(`INSERT INTO subtitle_jobs(anime_id,episode_id,target_language,status,created_at,updated_at) VALUES(?,?,?,'DISCOVERED',?,?) ON CONFLICT(anime_id,episode_id,target_language) DO NOTHING`).run(animeId, String(episodeId), target, now, now);
  const row = database.prepare('SELECT * FROM subtitle_jobs WHERE anime_id=? AND episode_id=? AND target_language=?').get(animeId, String(episodeId), target) as Record<string, unknown>;
  const job = fromRow(row);
  if (job.status === 'DISCOVERED') updateJob(job.id, 'QUEUED');
  return { job: getJob(job.id)!, inserted: result.changes === 1 };
}
export function getJob(id: number): Job | undefined { const row = database.prepare('SELECT * FROM subtitle_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined; return row && fromRow(row); }
export function heartbeatJob(id: number): void { database.prepare(`UPDATE subtitle_jobs SET locked_at=? WHERE id=? AND status IN ('DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING')`).run(Date.now(), id); }
export function updateJob(id: number, status: JobState, patch: { sourceLanguage?: string; providerId?: string; sourceHash?: string; error?: string | null; checkpoint?: Record<string, unknown>; lockedAt?: number | null; attempts?: number; availableAt?: number } = {}): void {
  const current = getJob(id);
  if (!current) throw new Error(`Subtitle job ${id} does not exist`);
  const next = { status, source_language: patch.sourceLanguage ?? current.source_language, provider_id: patch.providerId ?? current.provider_id, source_hash: patch.sourceHash ?? current.source_hash, error: patch.error === undefined ? current.error : patch.error, checkpoint: JSON.stringify(patch.checkpoint ?? current.checkpoint), locked_at: patch.lockedAt === undefined ? (['COMPLETED', 'FAILED', 'SKIPPED'].includes(status) ? null : Date.now()) : patch.lockedAt, attempts: patch.attempts ?? current.attempts, available_at: patch.availableAt ?? current.available_at, updated_at: nowIso(), id };
  database.prepare(`UPDATE subtitle_jobs SET status=@status,source_language=@source_language,provider_id=@provider_id,source_hash=@source_hash,error=@error,checkpoint=@checkpoint,locked_at=@locked_at,attempts=@attempts,available_at=@available_at,updated_at=@updated_at WHERE id=@id`).run(next);
}
export function logJob(jobId: number, level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown> = {}): void {
  database.prepare('INSERT INTO subtitle_job_logs(job_id,created_at,level,event,details) VALUES(?,?,?,?,?)').run(jobId, nowIso(), level, event, JSON.stringify(details));
}
export function recoverStaleJobs(staleMs: number): number {
  const now = Date.now();
  const result = database.prepare(`UPDATE subtitle_jobs SET status='QUEUED',locked_at=NULL,available_at=?,updated_at=?,error='Recovered after stale worker lock' WHERE status IN ('DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING') AND locked_at IS NOT NULL AND locked_at < ?`).run(now, nowIso(), now - staleMs);
  return result.changes;
}
export type WorkerControl = 'running' | 'paused' | 'stopping';
export function workerControl(): WorkerControl { const row = database.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='control'`).get() as { value: string } | undefined; return (row?.value as WorkerControl) ?? 'running'; }
export function setWorkerControl(value: WorkerControl): void { database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('control',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(value, nowIso()); }
export function recordWorkerHeartbeat(at = Date.now()): void { database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('worker-heartbeat',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(String(at), nowIso()); }
export function workerProcessStatus(now = Date.now(), staleAfterMs = 30_000): 'running' | 'stopped' {
  const row = database.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='worker-heartbeat'`).get() as { value: string } | undefined;
  const heartbeat = Number(row?.value ?? 0);
  return Number.isFinite(heartbeat) && heartbeat > 0 && now - heartbeat <= staleAfterMs ? 'running' : 'stopped';
}
export function workerConcurrency(): number { const row = database.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='concurrency'`).get() as { value: string } | undefined; return row ? Math.max(1, Math.min(subtitleConfig.maxConcurrentJobs, Number(row.value) || 1)) : subtitleConfig.maxConcurrentJobs; }
export function setWorkerConcurrency(value: number): void { database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('concurrency',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(String(Math.max(1, Math.min(subtitleConfig.maxConcurrentJobs, Math.floor(value)))), nowIso()); }
export function persistModelStatus(value: Record<string, unknown>): void { database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('models',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify(value), nowIso()); }
export function persistedModelStatus(): Record<string, unknown> | null { const row = database.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='models'`).get() as { value: string } | undefined; return row ? JSON.parse(row.value) as Record<string, unknown> : null; }
export function storedBulgarianCount(): number { const row = database.prepare(`SELECT COUNT(*) AS count FROM (SELECT anime_id,episode_id FROM subtitle_artifacts WHERE target_language='bg' AND validation_status='validated' UNION SELECT title_id,CAST(number AS TEXT) FROM subs WHERE status IN ('qc','final') AND path IS NOT NULL)`).get() as { count: number }; return row.count; }
export function claimJobs(limit: number): Job[] {
  const now = Date.now();
  const transaction = database.transaction(() => {
    const rows = database.prepare(`SELECT j.* FROM subtitle_jobs j WHERE j.status IN ('QUEUED','FAILED') AND j.available_at<=? ORDER BY CASE j.source_language WHEN 'en' THEN 0 WHEN 'ja' THEN 1 ELSE 2 END, (SELECT COUNT(*) FROM episodes e WHERE e.title_id=j.anime_id) DESC, CASE j.status WHEN 'FAILED' THEN 1 ELSE 0 END, j.attempts, j.anime_id, CAST(j.episode_id AS REAL), j.episode_id LIMIT ?`).all(now, limit) as Array<Record<string, unknown>>;
    const update = database.prepare(`UPDATE subtitle_jobs SET status='DOWNLOADING',locked_at=?,updated_at=?,attempts=attempts+1 WHERE id=? AND status IN ('QUEUED','FAILED')`);
    for (const row of rows) update.run(now, nowIso(), row.id);
    return rows.map(row => getJob(Number(row.id))!).filter(job => job.status === 'DOWNLOADING');
  });
  return transaction();
}
export function claimUndiscoveredJobs(limit: number): Job[] {
  const now = Date.now();
  const transaction = database.transaction(() => {
    const rows = database.prepare(`SELECT j.* FROM subtitle_jobs j WHERE j.status='QUEUED' AND j.source_language IS NULL ORDER BY (SELECT COUNT(*) FROM episodes e WHERE e.title_id=j.anime_id) DESC,j.anime_id,CAST(j.episode_id AS REAL),j.episode_id LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    const update = database.prepare(`UPDATE subtitle_jobs SET status='DOWNLOADING',locked_at=?,updated_at=?,attempts=attempts+1 WHERE id=? AND status='QUEUED' AND source_language IS NULL`);
    for (const row of rows) update.run(now, nowIso(), row.id);
    return rows.map(row => getJob(Number(row.id))!).filter(job => job.status === 'DOWNLOADING');
  });
  return transaction();
}
export function saveBody(content: string, extension: string): Promise<{ hash: string; path: string }> {
  const contentHash = createHash('sha256').update(content).digest('hex');
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'txt';
  const path = resolve(bodyRoot, contentHash.slice(0, 2), `${contentHash}.${safeExt}`);
  return mkdir(dirname(path), { recursive: true }).then(async () => {
    try { await readFile(path); } catch {
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      try { await rename(temporary, path); } catch (error) { await import('node:fs/promises').then(fs => fs.rm(temporary, { force: true })); try { await readFile(path); } catch { throw error; } }
    }
    return { hash: contentHash, path };
  });
}
export async function readBody(path: string): Promise<string> { return readFile(resolve(bodyRoot, path), 'utf8'); }
export function relativeBodyPath(path: string): string { return path.startsWith(`${bodyRoot}/`) ? path.slice(bodyRoot.length + 1) : path; }
export function storeValidatedArtifact(input: { animeId: number; seasonId: string | null; episodeId: string; sourceLanguage: string; targetLanguage: string; sourceHash: string; model: string; configHash?: string; sourceFormat: string; translatedFormat: string; sourcePath: string; translatedPath: string; score: number }): number {
  const configHash = input.configHash ?? `native:${input.model}`;
  const insert = database.prepare(`INSERT INTO subtitle_artifacts(anime_id,season_id,episode_id,source_language,target_language,source_hash,model,translation_version,config_hash,created_at,validation_status,source_format,translated_format,source_path,translated_path,score) VALUES(@animeId,@seasonId,@episodeId,@sourceLanguage,@targetLanguage,@sourceHash,@model,@version,@configHash,@createdAt,'validated',@sourceFormat,@translatedFormat,@sourcePath,@translatedPath,@score) ON CONFLICT(anime_id,episode_id,source_hash,target_language,config_hash) DO NOTHING`);
  insert.run({ ...input, configHash, version: process.env.SUBTITLE_TRANSLATION_VERSION ?? subtitleConfig.translationVersion, createdAt: nowIso() });
  const row = database.prepare(`SELECT id FROM subtitle_artifacts WHERE anime_id=? AND episode_id=? AND source_hash=? AND target_language=? AND config_hash=? AND validation_status='validated'`).get(input.animeId, input.episodeId, input.sourceHash, input.targetLanguage, configHash) as { id: number } | undefined;
  if (!row) throw new Error('Validated subtitle artifact insert did not persist');
  database.prepare(`INSERT INTO subs(title_id,number,path,source,status,translator) VALUES(?,?,?,'local-ai','final',?) ON CONFLICT(title_id,number) DO UPDATE SET path=excluded.path,source=excluded.source,status=excluded.status,translator=excluded.translator WHERE subs.status NOT IN ('final','qc')`).run(input.animeId, Number(input.episodeId), relativeBodyPath(input.translatedPath), input.model);
  return row.id;
}
export function updateValidatedArtifactBody(id: number, translatedPath: string, translatedFormat: string): void {
  const artifact = database.prepare(`SELECT anime_id,episode_id FROM subtitle_artifacts WHERE id=? AND validation_status='validated'`).get(id) as { anime_id: number; episode_id: string } | undefined;
  if (!artifact) throw new Error(`Validated subtitle artifact ${id} does not exist`);
  const transaction = database.transaction(() => {
    const updated = database.prepare(`UPDATE subtitle_artifacts SET translated_path=?,translated_format=? WHERE id=? AND validation_status='validated'`).run(translatedPath, translatedFormat, id);
    if (updated.changes !== 1) throw new Error(`Validated subtitle artifact ${id} changed while updating its body`);
    database.prepare(`UPDATE subs SET path=? WHERE title_id=? AND number=? AND source='local-ai' AND status IN ('final','qc')`).run(relativeBodyPath(translatedPath), artifact.anime_id, Number(artifact.episode_id));
  });
  transaction();
}
export function findCachedArtifact(sourceHash: string, target: string, configHash: string, version: string): Record<string, unknown> | undefined {
  return database.prepare(`SELECT * FROM subtitle_artifacts WHERE source_hash=? AND target_language=? AND config_hash=? AND translation_version=? AND validation_status='validated' ORDER BY id DESC LIMIT 1`).get(sourceHash, target, configHash, version) as Record<string, unknown> | undefined;
}
export function setGlossary(animeId: number, entries: Array<{ source: string; target: string; note?: string }>): void {
  const insert = database.prepare(`INSERT INTO subtitle_glossary(anime_id,source,target,note,created_at,updated_at) VALUES(@animeId,@source,@target,@note,@now,@now) ON CONFLICT(anime_id,source) DO UPDATE SET target=excluded.target,note=excluded.note,updated_at=excluded.updated_at`);
  const transaction = database.transaction(() => { for (const entry of entries) insert.run({ animeId, source: entry.source, target: entry.target, note: entry.note ?? '', now: nowIso() }); });
  transaction();
}
export function getGlossary(animeId: number): Array<{ source: string; target: string; note: string }> { return database.prepare('SELECT source,target,note FROM subtitle_glossary WHERE anime_id=? ORDER BY source').all(animeId) as Array<{ source: string; target: string; note: string }>; }
export function listArtifacts(animeId?: number, episodeId?: string): Array<Record<string, unknown>> {
  const clauses: string[] = ["validation_status='validated'"]; const values: unknown[] = [];
  if (animeId !== undefined) { clauses.push('anime_id=?'); values.push(animeId); }
  if (episodeId !== undefined) { clauses.push('episode_id=?'); values.push(episodeId); }
  return database.prepare(`SELECT * FROM subtitle_artifacts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`).all(...values) as Array<Record<string, unknown>>;
}
export function jobStats(): Record<string, unknown> {
  const counts = database.prepare('SELECT status,COUNT(*) AS count FROM subtitle_jobs GROUP BY status').all() as Array<{ status: string; count: number }>;
  const completed = database.prepare(`SELECT COUNT(*) AS count,AVG(CAST(json_extract(details,'$.elapsedMs') AS REAL)/1000.0) AS mean_seconds FROM subtitle_job_logs WHERE event='translation_completed'`).get() as { count: number; mean_seconds: number | null };
  const active = database.prepare(`SELECT id,anime_id,episode_id,status,attempts,updated_at,checkpoint FROM subtitle_jobs WHERE status IN ('DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING') ORDER BY updated_at`).all() as Array<{ id: number; anime_id: number; episode_id: string; status: string; attempts: number; updated_at: string; checkpoint: string }>;
  const progress = active.map(job => {
    try { const checkpoint = JSON.parse(job.checkpoint) as { translated?: Record<string, string>; elapsedMs?: number; totalCues?: number }; const translated = Object.keys(checkpoint.translated ?? {}).length; const total = Number(checkpoint.totalCues); return { translated, elapsedMs: Number(checkpoint.elapsedMs ?? 0), remaining: Number.isFinite(total) && total > 0 ? Math.max(0, total - translated) : null }; }
    catch { return { translated: 0, elapsedMs: 0, remaining: null }; }
  });
  const activeTranslatedCues = progress.reduce((sum, item) => sum + item.translated, 0);
  const activeElapsedMs = progress.reduce((sum, item) => sum + item.elapsedMs, 0);
  const activeCuesPerHour = activeElapsedMs > 0 ? activeTranslatedCues / (activeElapsedMs / 3_600_000) : null;
  const activeRemainingCues = progress.every(item => item.remaining !== null) ? progress.reduce((sum, item) => sum + (item.remaining ?? 0), 0) : null;
  const activeEpisodeRemainingSeconds = activeRemainingCues !== null && activeCuesPerHour && activeCuesPerHour > 0 ? activeRemainingCues / (activeCuesPerHour / 3600) : null;
  const recent = database.prepare(`SELECT COUNT(*) AS count FROM subtitle_job_logs WHERE event='translation_completed' AND created_at>=?`).get(new Date(Date.now() - 3600000).toISOString()) as { count: number };
  return { counts: Object.fromEntries(counts.map(row => [row.status, row.count])), completed: completed.count, meanSeconds: completed.mean_seconds, throughputPerHour: recent.count, active, activeTranslatedCues, activeCuesPerHour, activeEpisodeRemainingSeconds };
}
export function recentJobs(limit = 50): Array<Record<string, unknown>> { return database.prepare(`SELECT j.*,t.romaji,t.english FROM subtitle_jobs j LEFT JOIN titles t ON t.id=j.anime_id ORDER BY j.updated_at DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>; }
export function controlJob(id: number, action: 'retry' | 'skip'): void {
  if (action === 'retry') database.prepare(`UPDATE subtitle_jobs SET status='QUEUED',attempts=0,error=NULL,available_at=0,locked_at=NULL,updated_at=? WHERE id=? AND status IN ('FAILED','SKIPPED')`).run(nowIso(), id);
  else database.prepare(`UPDATE subtitle_jobs SET status='SKIPPED',locked_at=NULL,updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','SKIPPED')`).run(nowIso(), id);
}
export function retryFailedJobs(): number {
  const transaction = database.transaction(() => {
    const result = database.prepare(`UPDATE subtitle_jobs SET status='QUEUED',attempts=0,error=NULL,available_at=0,locked_at=NULL,updated_at=? WHERE status='FAILED'`).run(nowIso());
    database.prepare('DELETE FROM subtitle_dead_letters WHERE job_id IN (SELECT id FROM subtitle_jobs WHERE status=\'QUEUED\')').run();
    return result.changes;
  });
  return transaction();
}
export function addDeadLetter(job: Job, reason: string): void {
  database.prepare('INSERT INTO subtitle_dead_letters(job_id,failed_at,attempts,reason) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET failed_at=excluded.failed_at,attempts=excluded.attempts,reason=excluded.reason').run(job.id, nowIso(), job.attempts, reason);
}
export function deadLetters(limit = 50): Array<Record<string, unknown>> { return database.prepare('SELECT * FROM subtitle_dead_letters ORDER BY failed_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>; }
export function existingBulgarian(animeId: number, episodeId: number): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM subtitle_artifacts WHERE anime_id=? AND episode_id=? AND target_language='bg' AND validation_status='validated' UNION SELECT 1 FROM subs WHERE title_id=? AND number=? AND status IN ('qc','final') AND path IS NOT NULL LIMIT 1`).get(animeId, String(episodeId), animeId, episodeId));
}
export function closeSubtitleStorage(): void { database.close(); }
